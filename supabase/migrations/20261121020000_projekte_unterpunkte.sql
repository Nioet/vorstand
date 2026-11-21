-- =====================================================================
--  Erweiterung: Projekte und Unterpunkte (Checklisten an Terminen)
--  Unterpunkte sind Aufgaben mit termin_id. Sie erben das Projekt
--  ihres Termins (die App zeigt es so an).
-- =====================================================================

create table if not exists public.projekte (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(trim(name)) > 0),
  beschreibung  text,
  abgeschlossen boolean not null default false,
  erstellt_von  uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.termine
  add column if not exists projekt_id uuid references public.projekte (id) on delete set null;

alter table public.aufgaben
  add column if not exists projekt_id uuid references public.projekte (id) on delete set null,
  -- Wird ein Termin gelöscht, verschwinden auch seine Unterpunkte
  add column if not exists termin_id  uuid references public.termine (id) on delete cascade;

create index if not exists termine_projekt_idx  on public.termine (projekt_id);
create index if not exists aufgaben_projekt_idx on public.aufgaben (projekt_id);
create index if not exists aufgaben_termin_idx  on public.aufgaben (termin_id);
create index if not exists termine_erstellt_idx  on public.termine (erstellt_von);
create index if not exists aufgaben_erstellt_idx on public.aufgaben (erstellt_von);
create index if not exists aufgaben_zustaendig_idx on public.aufgaben (zustaendig);
create index if not exists projekte_erstellt_idx on public.projekte (erstellt_von);

drop trigger if exists projekte_zeitstempel on public.projekte;
create trigger projekte_zeitstempel
  before insert or update on public.projekte
  for each row execute function public.zeitstempel_setzen();

alter table public.projekte enable row level security;

drop policy if exists "Vorstand verwaltet Projekte" on public.projekte;
create policy "Vorstand verwaltet Projekte" on public.projekte
  for all to authenticated
  using (public.ist_vorstand()) with check (public.ist_vorstand());

revoke all on public.projekte from anon;
grant select, insert, update, delete on public.projekte to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.projekte;
    exception when duplicate_object then null;
    end;
  end if;
end;
$$;
