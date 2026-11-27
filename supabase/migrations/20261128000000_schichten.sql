-- =====================================================================
--  Schichten: ein Termin (z. B. Infostand) kann Zeitblöcke mit einer
--  festen Zahl an Plätzen haben. Jede Person trägt nur sich selbst ein.
-- =====================================================================

alter table public.termine add column if not exists mit_schichten boolean not null default false;

create table if not exists public.schichten (
  id         uuid primary key default gen_random_uuid(),
  termin_id  uuid not null references public.termine (id) on delete cascade,
  start_zeit time not null,
  end_zeit   time not null,
  plaetze    smallint not null default 2 check (plaetze between 1 and 50),
  created_at timestamptz not null default now()
);
create index if not exists schichten_termin_idx on public.schichten (termin_id, start_zeit);

create table if not exists public.schicht_eintraege (
  schicht_id uuid not null references public.schichten (id) on delete cascade,
  person     uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (schicht_id, person)
);

alter table public.schichten enable row level security;
alter table public.schicht_eintraege enable row level security;

drop policy if exists "Vorstand verwaltet Schichten" on public.schichten;
create policy "Vorstand verwaltet Schichten" on public.schichten
  for all to authenticated
  using (public.ist_vorstand()) with check (public.ist_vorstand());

drop policy if exists "Vorstand sieht Schicht-Einträge" on public.schicht_eintraege;
create policy "Vorstand sieht Schicht-Einträge" on public.schicht_eintraege
  for select to authenticated using (public.ist_vorstand());

drop policy if exists "Sich selbst eintragen" on public.schicht_eintraege;
create policy "Sich selbst eintragen" on public.schicht_eintraege
  for insert to authenticated with check (public.ist_vorstand() and person = auth.uid());

drop policy if exists "Sich selbst austragen" on public.schicht_eintraege;
create policy "Sich selbst austragen" on public.schicht_eintraege
  for delete to authenticated using (public.ist_vorstand() and person = auth.uid());

revoke all on public.schichten, public.schicht_eintraege from anon;
grant select, insert, update, delete on public.schichten to authenticated;
grant select, insert, delete on public.schicht_eintraege to authenticated;

-- Volle Schicht: niemand kann sich mehr eintragen
create or replace function public.schicht_platz_pruefen()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  frei smallint;
begin
  select s.plaetze into frei from public.schichten s where s.id = new.schicht_id for update;
  if (select count(*) from public.schicht_eintraege e where e.schicht_id = new.schicht_id) >= frei then
    raise exception 'Diese Schicht ist schon voll.' using errcode = 'P0001', hint = 'schicht_voll';
  end if;
  return new;
end;
$$;
revoke execute on function public.schicht_platz_pruefen() from public, anon, authenticated;

drop trigger if exists schicht_platz on public.schicht_eintraege;
create trigger schicht_platz before insert on public.schicht_eintraege
  for each row execute function public.schicht_platz_pruefen();

-- Änderungsprotokoll: „Almut hat sich bei „Infostand“ für 10–12 Uhr eingetragen“
create or replace function public.schicht_protokollieren()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  wer uuid := auth.uid();
  s public.schichten;
  t public.termine;
begin
  if wer is null or pg_trigger_depth() > 1 then return null; end if;   -- z. B. Schicht oder Termin gelöscht
  select * into s from public.schichten where id = coalesce(new.schicht_id, old.schicht_id);
  if not found then return null; end if;
  select * into t from public.termine where id = s.termin_id;
  insert into public.protokoll (person, art, aktion, titel, kontext, objekt_id)
  values (wer, 'Schicht', case when tg_op = 'INSERT' then 'eingetragen' else 'ausgetragen' end,
          t.titel, to_char(s.start_zeit, 'HH24:MI') || '–' || to_char(s.end_zeit, 'HH24:MI') || ' Uhr', t.id);
  return null;
end;
$$;
revoke execute on function public.schicht_protokollieren() from public, anon, authenticated;

drop trigger if exists schicht_eintraege_protokoll on public.schicht_eintraege;
create trigger schicht_eintraege_protokoll after insert or delete on public.schicht_eintraege
  for each row execute function public.schicht_protokollieren();

-- Duplizieren übernimmt die Schichten (ohne Einträge)
create or replace function public.termin_duplizieren(quelle uuid, neues_datum date, neue_start_zeit time without time zone default null, neue_end_zeit time without time zone default null)
returns uuid
language plpgsql
set search_path to ''
as $function$
#variable_conflict use_variable
declare
  q public.termine;
  neu uuid;
  abstand integer;
begin
  select * into q from public.termine where id = quelle;
  if not found then
    raise exception 'Termin nicht gefunden';
  end if;
  abstand := neues_datum - q.datum;

  insert into public.termine (titel, datum, bis_datum, start_zeit, end_zeit, ort, beschreibung, projekt_id, extern, zustaendig, link, mit_schichten)
  values (
    q.titel, neues_datum, q.bis_datum + abstand,
    neue_start_zeit,
    case when neue_start_zeit is null then null else neue_end_zeit end,
    q.ort, q.beschreibung, q.projekt_id, q.extern, q.zustaendig, q.link, q.mit_schichten
  )
  returning id into neu;

  insert into public.aufgaben (titel, beschreibung, zustaendig, zustaendig_extern, faellig, faellig_zeit, projekt_id, termin_id, status, created_at)
  select a.titel, a.beschreibung, a.zustaendig, a.zustaendig_extern, a.faellig + abstand, a.faellig_zeit, a.projekt_id, neu, 'offen',
         now() + (row_number() over (order by a.created_at, a.id)) * interval '1 millisecond'
  from public.aufgaben a
  where a.termin_id = quelle;

  insert into public.schichten (termin_id, start_zeit, end_zeit, plaetze)
  select neu, s.start_zeit, s.end_zeit, s.plaetze from public.schichten s where s.termin_id = quelle;

  return neu;
end;
$function$;

create or replace function public.projekt_duplizieren(quelle uuid, neuer_name text, verschiebung_tage integer default 0)
returns uuid
language plpgsql
set search_path to ''
as $function$
#variable_conflict use_variable
declare
  p public.projekte;
  neu uuid;
  t public.termine;
  neuer_termin uuid;
begin
  select * into p from public.projekte where id = quelle;
  if not found then
    raise exception 'Projekt nicht gefunden';
  end if;

  insert into public.projekte (name, beschreibung, zustaendig, in_planung)
  values (coalesce(nullif(trim(neuer_name), ''), p.name || ' (Kopie)'), p.beschreibung, p.zustaendig, p.in_planung)
  returning id into neu;

  for t in select * from public.termine where projekt_id = quelle order by datum, start_zeit loop
    insert into public.termine (titel, datum, bis_datum, start_zeit, end_zeit, ort, beschreibung, projekt_id, extern, zustaendig, link, mit_schichten)
    values (t.titel, t.datum + verschiebung_tage, t.bis_datum + verschiebung_tage,
            t.start_zeit, t.end_zeit, t.ort, t.beschreibung, neu, t.extern, t.zustaendig, t.link, t.mit_schichten)
    returning id into neuer_termin;

    insert into public.aufgaben (titel, beschreibung, zustaendig, zustaendig_extern, faellig, faellig_zeit, projekt_id, termin_id, status, created_at)
    select a.titel, a.beschreibung, a.zustaendig, a.zustaendig_extern, a.faellig + verschiebung_tage, a.faellig_zeit,
           case when a.projekt_id = quelle then neu else a.projekt_id end,
           neuer_termin, 'offen',
           now() + (row_number() over (order by a.created_at, a.id)) * interval '1 millisecond'
    from public.aufgaben a
    where a.termin_id = t.id;

    insert into public.schichten (termin_id, start_zeit, end_zeit, plaetze)
    select neuer_termin, s.start_zeit, s.end_zeit, s.plaetze from public.schichten s where s.termin_id = t.id;
  end loop;

  insert into public.aufgaben (titel, beschreibung, zustaendig, zustaendig_extern, faellig, faellig_zeit, projekt_id, termin_id, status, created_at)
  select a.titel, a.beschreibung, a.zustaendig, a.zustaendig_extern, a.faellig + verschiebung_tage, a.faellig_zeit, neu, null, 'offen',
         now() + interval '1 second' + (row_number() over (order by a.created_at, a.id)) * interval '1 millisecond'
  from public.aufgaben a
  where a.projekt_id = quelle
    and (a.termin_id is null
         or a.termin_id not in (select x.id from public.termine x where x.projekt_id = quelle));

  return neu;
end;
$function$;

-- Live-Aktualisierung
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.schichten;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.schicht_eintraege;
    exception when duplicate_object then null;
    end;
  end if;
end;
$$;
