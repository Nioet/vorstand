-- =====================================================================
--  Schichten: auch Helferinnen und Helfer ohne App eintragen (nur Name).
--  Mitglieder des Vorstands tragen weiterhin nur sich selbst ein.
--  Namen ohne App kann jedes Vorstandsmitglied eintragen und entfernen.
-- =====================================================================

alter table public.schicht_eintraege add column if not exists id uuid not null default gen_random_uuid();
alter table public.schicht_eintraege add column if not exists name text;
alter table public.schicht_eintraege add column if not exists eingetragen_von uuid
  references public.profiles (id) on delete set null default auth.uid();

alter table public.schicht_eintraege drop constraint if exists schicht_eintraege_pkey;
alter table public.schicht_eintraege add primary key (id);
alter table public.schicht_eintraege alter column person drop not null;

alter table public.schicht_eintraege drop constraint if exists schicht_eintrag_person_oder_name;
alter table public.schicht_eintraege add constraint schicht_eintrag_person_oder_name
  check ((person is null) <> (name is null) and (name is null or length(trim(name)) between 1 and 60));

create unique index if not exists schicht_eintraege_person_einmal
  on public.schicht_eintraege (schicht_id, person) where person is not null;

drop policy if exists "Sich selbst eintragen" on public.schicht_eintraege;
create policy "Sich selbst oder Name eintragen" on public.schicht_eintraege
  for insert to authenticated with check (
    public.ist_vorstand()
    and ((person = auth.uid() and name is null) or (person is null and name is not null))
  );

drop policy if exists "Sich selbst austragen" on public.schicht_eintraege;
create policy "Sich selbst oder Namen austragen" on public.schicht_eintraege
  for delete to authenticated using (public.ist_vorstand() and (person = auth.uid() or person is null));

-- Protokoll: „Nils hat Hans bei „Infostand“ für 10:00–12:00 Uhr eingetragen“
-- (der Name ohne App steht im Feld "felder")
create or replace function public.schicht_protokollieren()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  wer uuid := auth.uid();
  zeile public.schicht_eintraege := coalesce(new, old);
  s public.schichten;
  t public.termine;
begin
  if wer is null or pg_trigger_depth() > 1 then return null; end if;
  select * into s from public.schichten where id = zeile.schicht_id;
  if not found then return null; end if;
  select * into t from public.termine where id = s.termin_id;
  insert into public.protokoll (person, art, aktion, titel, kontext, objekt_id, felder)
  values (wer, 'Schicht', case when tg_op = 'INSERT' then 'eingetragen' else 'ausgetragen' end,
          t.titel, to_char(s.start_zeit, 'HH24:MI') || '–' || to_char(s.end_zeit, 'HH24:MI') || ' Uhr', t.id,
          case when zeile.name is not null then array[zeile.name] else '{}' end);
  return null;
end;
$$;
