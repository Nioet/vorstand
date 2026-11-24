-- =====================================================================
--  Protokoll: Verweis auf den betroffenen Eintrag, damit man ihn aus
--  der Liste öffnen kann (bei Rückmeldungen: der Termin)
-- =====================================================================

alter table public.protokoll add column if not exists objekt_id uuid;

create or replace function public.protokollieren()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  wer      uuid := auth.uid();
  neu      jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  alt      jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  zeile    jsonb := coalesce(to_jsonb(new), to_jsonb(old));
  v_art    text;
  v_titel  text;
  v_kontext text;
  v_aktion text;
  v_felder text[] := '{}';
  k        text;
begin
  -- Ohne angemeldete Person (Abgleich mit der Kreis-Website) oder als Folge
  -- eines anderen Vorgangs (z. B. Unterpunkte beim Löschen eines Termins): nichts eintragen
  if wer is null or pg_trigger_depth() > 1 then
    return null;
  end if;

  if tg_table_name = 'rueckmeldungen' then
    if tg_op = 'UPDATE' and alt->>'dabei' = neu->>'dabei' then return null; end if;
    select t.titel into v_kontext from public.termine t where t.id = (zeile->>'termin_id')::uuid;
    if tg_op = 'DELETE' and v_kontext is null then return null; end if;  -- Termin wurde gelöscht
    v_aktion := case when tg_op = 'DELETE' then 'zurückgenommen'
                     when (neu->>'dabei')::boolean then 'zugesagt' else 'abgesagt' end;
    insert into public.protokoll (person, art, aktion, titel, objekt_id)
    values (wer, 'Rückmeldung', v_aktion, v_kontext, (zeile->>'termin_id')::uuid);
    return null;
  end if;

  v_art := case tg_table_name
             when 'termine' then 'Termin'
             when 'projekte' then 'Projekt'
             else case when zeile->>'termin_id' is not null then 'Unterpunkt' else 'Aufgabe' end
           end;
  v_titel := zeile->>(case when tg_table_name = 'projekte' then 'name' else 'titel' end);
  if tg_table_name = 'aufgaben' and zeile->>'termin_id' is not null then
    select t.titel into v_kontext from public.termine t where t.id = (zeile->>'termin_id')::uuid;
    -- Unterpunkt verschwindet, weil der ganze Termin gelöscht wurde: steht schon beim Termin
    if tg_op = 'DELETE' and v_kontext is null then return null; end if;
  end if;

  if tg_op = 'INSERT' then
    v_aktion := 'angelegt';
  elsif tg_op = 'DELETE' then
    v_aktion := 'gelöscht';
  else
    for k in select jsonb_object_keys(neu) loop
      if k <> all (array['updated_at', 'created_at', 'position', 'erledigt_am', 'quelle_uid'])
         and neu->k is distinct from alt->k then
        v_felder := v_felder || k;
      end if;
    end loop;
    if cardinality(v_felder) = 0 then return null; end if;   -- nur umsortiert o. Ä.

    if tg_table_name = 'aufgaben' and v_felder = array['status'] then
      v_aktion := case neu->>'status' when 'erledigt' then 'erledigt' when 'in_arbeit' then 'angefangen' else 'wieder_offen' end;
      v_felder := '{}';
    elsif tg_table_name = 'aufgaben' and v_felder <@ array['zustaendig', 'zustaendig_extern'] and neu->>'zustaendig' = wer::text then
      v_aktion := 'übernommen';
      v_felder := '{}';
    else
      v_aktion := 'geändert';
    end if;
  end if;

  insert into public.protokoll (person, art, aktion, titel, kontext, felder, objekt_id)
  values (wer, v_art, v_aktion, v_titel, v_kontext, v_felder, (zeile->>'id')::uuid);
  return null;
end;
$$;
revoke execute on function public.protokollieren() from public, anon, authenticated;

-- Bisherige Einträge nachträglich zuordnen (über den Titel, soweit eindeutig)
update public.protokoll p set objekt_id = (
  select t.id from public.termine t where t.titel = p.titel order by abs(extract(epoch from t.created_at - p.zeit)) limit 1)
where p.objekt_id is null and p.art = 'Termin';
update public.protokoll p set objekt_id = (
  select r.termin_id from public.rueckmeldungen r join public.termine t on t.id = r.termin_id
  where t.titel = p.titel and r.person = p.person order by abs(extract(epoch from r.updated_at - p.zeit)) limit 1)
where p.objekt_id is null and p.art = 'Rückmeldung';
update public.protokoll p set objekt_id = (
  select a.id from public.aufgaben a where a.titel = p.titel order by abs(extract(epoch from a.created_at - p.zeit)) limit 1)
where p.objekt_id is null and p.art in ('Aufgabe', 'Unterpunkt');
update public.protokoll p set objekt_id = (
  select x.id from public.projekte x where x.name = p.titel limit 1)
where p.objekt_id is null and p.art = 'Projekt';
