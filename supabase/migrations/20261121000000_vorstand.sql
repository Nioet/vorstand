-- =====================================================================
--  Vorstands-App: Datenbank-Schema
--  Einmal komplett im Supabase SQL-Editor ausführen (oder per CLI:
--  `supabase db push`).
-- =====================================================================

-- ---------------------------------------------------------------------
--  1. Profile der Vorstandsmitglieder
--     Für jede Person, die unter Authentication → Users angelegt wird,
--     entsteht hier automatisch ein Profil.
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  name        text,
  email       text,
  aktiv       boolean not null default true,
  created_at  timestamptz not null default now()
);

comment on table public.profiles is
  'Vorstandsmitglieder. aktiv = false sperrt eine Person aus, ohne ihre Einträge zu löschen.';

create or replace function public.neues_profil()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, new.email, nullif(new.raw_user_meta_data ->> 'name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists bei_neuem_nutzer on auth.users;
create trigger bei_neuem_nutzer
  after insert on auth.users
  for each row execute function public.neues_profil();

-- Profile für Personen nachtragen, die schon vor diesem Skript angelegt wurden
insert into public.profiles (id, email)
select id, email from auth.users
on conflict (id) do nothing;

-- Hilfsfunktion: Ist die angemeldete Person aktives Vorstandsmitglied?
create or replace function public.ist_vorstand()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and aktiv
  );
$$;

-- ---------------------------------------------------------------------
--  2. Termine
--     Ganztägig = keine Startzeit. Mehrtägig = bis_datum gesetzt.
-- ---------------------------------------------------------------------
create table if not exists public.termine (
  id            uuid primary key default gen_random_uuid(),
  titel         text not null check (length(trim(titel)) > 0),
  datum         date not null,
  bis_datum     date,
  start_zeit    time,
  end_zeit      time,
  ort           text,
  beschreibung  text,
  erstellt_von  uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint bis_nach_datum check (bis_datum is null or bis_datum >= datum),
  constraint ende_braucht_start check (end_zeit is null or start_zeit is not null)
);

create index if not exists termine_datum_idx on public.termine (datum);

-- ---------------------------------------------------------------------
--  3. Aufgaben (Board mit drei Spalten)
-- ---------------------------------------------------------------------
create table if not exists public.aufgaben (
  id            uuid primary key default gen_random_uuid(),
  titel         text not null check (length(trim(titel)) > 0),
  beschreibung  text,
  status        text not null default 'offen'
                check (status in ('offen', 'in_arbeit', 'erledigt')),
  zustaendig    uuid references public.profiles (id) on delete set null,
  faellig       date,
  erledigt_am   timestamptz,
  erstellt_von  uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists aufgaben_status_idx on public.aufgaben (status);

-- ---------------------------------------------------------------------
--  4. Geheimer Schlüssel für das Kalender-Abo
--     Steht nur angemeldeten Vorstandsmitgliedern zur Verfügung,
--     nicht im öffentlichen Code.
-- ---------------------------------------------------------------------
create table if not exists public.kalender_abo (
  id     smallint primary key default 1 check (id = 1),
  token  text not null default
           replace(gen_random_uuid()::text, '-', '') ||
           replace(gen_random_uuid()::text, '-', '')
);

insert into public.kalender_abo (id) values (1) on conflict (id) do nothing;

-- Neuen Abo-Link erzeugen (z. B. wenn jemand den Vorstand verlässt).
-- Alle bisherigen Abos hören dann auf zu funktionieren.
create or replace function public.abo_token_erneuern()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  neu text := replace(gen_random_uuid()::text, '-', '') ||
              replace(gen_random_uuid()::text, '-', '');
begin
  if not public.ist_vorstand() then
    raise exception 'Nicht erlaubt';
  end if;
  update public.kalender_abo set token = neu where id = 1;
  return neu;
end;
$$;

-- ---------------------------------------------------------------------
--  5. Automatische Felder
-- ---------------------------------------------------------------------
create or replace function public.zeitstempel_setzen()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  if tg_table_name = 'aufgaben' then
    if new.status = 'erledigt' and (tg_op = 'INSERT' or old.status <> 'erledigt') then
      new.erledigt_am := now();
    elsif new.status <> 'erledigt' then
      new.erledigt_am := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists termine_zeitstempel on public.termine;
create trigger termine_zeitstempel
  before insert or update on public.termine
  for each row execute function public.zeitstempel_setzen();

drop trigger if exists aufgaben_zeitstempel on public.aufgaben;
create trigger aufgaben_zeitstempel
  before insert or update on public.aufgaben
  for each row execute function public.zeitstempel_setzen();

-- ---------------------------------------------------------------------
--  6. Zugriffsregeln (Row Level Security)
--     Nur aktive Vorstandsmitglieder sehen und ändern etwas.
--     Ohne Anmeldung ist nichts lesbar.
-- ---------------------------------------------------------------------
alter table public.profiles     enable row level security;
alter table public.termine      enable row level security;
alter table public.aufgaben     enable row level security;
alter table public.kalender_abo enable row level security;

drop policy if exists "Vorstand sieht Profile" on public.profiles;
create policy "Vorstand sieht Profile" on public.profiles
  for select to authenticated using (public.ist_vorstand() or id = auth.uid());

drop policy if exists "Eigenen Namen ändern" on public.profiles;
create policy "Eigenen Namen ändern" on public.profiles
  for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "Vorstand verwaltet Termine" on public.termine;
create policy "Vorstand verwaltet Termine" on public.termine
  for all to authenticated
  using (public.ist_vorstand()) with check (public.ist_vorstand());

drop policy if exists "Vorstand verwaltet Aufgaben" on public.aufgaben;
create policy "Vorstand verwaltet Aufgaben" on public.aufgaben
  for all to authenticated
  using (public.ist_vorstand()) with check (public.ist_vorstand());

drop policy if exists "Vorstand sieht Abo-Link" on public.kalender_abo;
create policy "Vorstand sieht Abo-Link" on public.kalender_abo
  for select to authenticated using (public.ist_vorstand());

-- Rechte: Gäste (anon) bekommen gar nichts; Angemeldete nur das Nötige.
revoke all on public.profiles, public.termine, public.aufgaben, public.kalender_abo from anon;
revoke all on public.profiles, public.kalender_abo from authenticated;

grant select on public.profiles to authenticated;
grant update (name) on public.profiles to authenticated;   -- nur der Name, nicht "aktiv"
grant select, insert, update, delete on public.termine  to authenticated;
grant select, insert, update, delete on public.aufgaben to authenticated;
grant select on public.kalender_abo to authenticated;

revoke execute on function public.neues_profil() from public, anon, authenticated;
revoke execute on function public.abo_token_erneuern() from public, anon;
grant  execute on function public.abo_token_erneuern() to authenticated;
revoke execute on function public.ist_vorstand() from public, anon;
grant  execute on function public.ist_vorstand() to authenticated;

-- ---------------------------------------------------------------------
--  7. Live-Aktualisierung: Änderungen erscheinen sofort bei allen
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.termine;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.aufgaben;
    exception when duplicate_object then null;
    end;
  end if;
end;
$$;
