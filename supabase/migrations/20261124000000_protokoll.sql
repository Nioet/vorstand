-- =====================================================================
--  Änderungsprotokoll
--  * Wer hat wann was angelegt, geändert, gelöscht, erledigt, zu- oder abgesagt
--  * Sichtbar nur für Konten mit profiles.admin = true
--    (setzen im SQL-Editor: update public.profiles set admin = true where email = '…';)
--  * Einträge werden nach 30 Tagen gelöscht
-- =====================================================================

alter table public.profiles add column if not exists admin boolean not null default false;

create or replace function public.ist_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and aktiv and admin);
$$;
revoke execute on function public.ist_admin() from public, anon;
grant execute on function public.ist_admin() to authenticated;

create table if not exists public.protokoll (
  id      bigint generated always as identity primary key,
  zeit    timestamptz not null default now(),
  person  uuid references public.profiles (id) on delete set null,
  art     text not null,          -- Termin, Aufgabe, Unterpunkt, Projekt, Rückmeldung
  aktion  text not null,          -- angelegt, geändert, gelöscht, erledigt, angefangen, wieder_offen, übernommen, zugesagt, abgesagt, zurückgenommen
  titel   text,
  kontext text,                   -- z. B. der Termin eines Unterpunkts
  felder  text[] not null default '{}'
);
create index if not exists protokoll_zeit_idx on public.protokoll (zeit desc);

alter table public.protokoll enable row level security;
drop policy if exists "Admin liest Protokoll" on public.protokoll;
create policy "Admin liest Protokoll" on public.protokoll
  for select to authenticated using (public.ist_admin());

revoke all on public.protokoll from anon, authenticated;
grant select on public.protokoll to authenticated;

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
    insert into public.protokoll (person, art, aktion, titel) values (wer, 'Rückmeldung', v_aktion, v_kontext);
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

  insert into public.protokoll (person, art, aktion, titel, kontext, felder)
  values (wer, v_art, v_aktion, v_titel, v_kontext, v_felder);
  return null;
end;
$$;
revoke execute on function public.protokollieren() from public, anon, authenticated;

drop trigger if exists termine_protokoll on public.termine;
create trigger termine_protokoll after insert or update or delete on public.termine
  for each row execute function public.protokollieren();
drop trigger if exists aufgaben_protokoll on public.aufgaben;
create trigger aufgaben_protokoll after insert or update or delete on public.aufgaben
  for each row execute function public.protokollieren();
drop trigger if exists projekte_protokoll on public.projekte;
create trigger projekte_protokoll after insert or update or delete on public.projekte
  for each row execute function public.protokollieren();
drop trigger if exists rueckmeldungen_protokoll on public.rueckmeldungen;
create trigger rueckmeldungen_protokoll after insert or update or delete on public.rueckmeldungen
  for each row execute function public.protokollieren();

-- Nachtrag der letzten drei Tage, soweit aus den Daten ablesbar:
-- Angelegtes (mit erstellt_von) und Rückmeldungen
insert into public.protokoll (zeit, person, art, aktion, titel)
select created_at, erstellt_von, 'Termin', 'angelegt', titel
from public.termine where erstellt_von is not null and created_at > now() - interval '3 days'
  and not exists (select 1 from public.protokoll);
insert into public.protokoll (zeit, person, art, aktion, titel, kontext)
select a.created_at, a.erstellt_von, case when a.termin_id is null then 'Aufgabe' else 'Unterpunkt' end, 'angelegt', a.titel, t.titel
from public.aufgaben a left join public.termine t on t.id = a.termin_id
where a.erstellt_von is not null and a.created_at > now() - interval '3 days'
  and not exists (select 1 from public.protokoll where art <> 'Termin');
insert into public.protokoll (zeit, person, art, aktion, titel)
select created_at, erstellt_von, 'Projekt', 'angelegt', name
from public.projekte where erstellt_von is not null and created_at > now() - interval '3 days'
  and not exists (select 1 from public.protokoll where art not in ('Termin', 'Aufgabe', 'Unterpunkt'));
insert into public.protokoll (zeit, person, art, aktion, titel)
select r.updated_at, r.person, 'Rückmeldung', case when r.dabei then 'zugesagt' else 'abgesagt' end, t.titel
from public.rueckmeldungen r join public.termine t on t.id = r.termin_id
where not exists (select 1 from public.protokoll where art = 'Rückmeldung');

-- Aufräumen: Einträge älter als 30 Tage
create extension if not exists pg_cron;
select cron.unschedule('protokoll-aufraeumen') where exists (select 1 from cron.job where jobname = 'protokoll-aufraeumen');
select cron.schedule('protokoll-aufraeumen', '43 3 * * *',
  $cron$delete from public.protokoll where zeit < now() - interval '30 days'$cron$);
