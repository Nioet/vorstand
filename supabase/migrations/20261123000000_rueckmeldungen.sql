-- =====================================================================
--  Rückmeldungen zu Terminen: „Ich bin dabei“ / „Ich kann nicht“
--  Jede Person meldet nur sich selbst. Keine Zeile = noch keine Rückmeldung.
-- =====================================================================

create table if not exists public.rueckmeldungen (
  termin_id  uuid not null references public.termine (id) on delete cascade,
  person     uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  dabei      boolean not null,
  updated_at timestamptz not null default now(),
  primary key (termin_id, person)
);

alter table public.rueckmeldungen enable row level security;

drop policy if exists "Vorstand sieht Rückmeldungen" on public.rueckmeldungen;
create policy "Vorstand sieht Rückmeldungen" on public.rueckmeldungen
  for select to authenticated using (public.ist_vorstand());

drop policy if exists "Eigene Rückmeldung eintragen" on public.rueckmeldungen;
create policy "Eigene Rückmeldung eintragen" on public.rueckmeldungen
  for insert to authenticated with check (public.ist_vorstand() and person = auth.uid());

drop policy if exists "Eigene Rückmeldung ändern" on public.rueckmeldungen;
create policy "Eigene Rückmeldung ändern" on public.rueckmeldungen
  for update to authenticated
  using (public.ist_vorstand() and person = auth.uid())
  with check (public.ist_vorstand() and person = auth.uid());

drop policy if exists "Eigene Rückmeldung zurücknehmen" on public.rueckmeldungen;
create policy "Eigene Rückmeldung zurücknehmen" on public.rueckmeldungen
  for delete to authenticated using (public.ist_vorstand() and person = auth.uid());

revoke all on public.rueckmeldungen from anon;
grant select, insert, update, delete on public.rueckmeldungen to authenticated;

drop trigger if exists rueckmeldungen_zeitstempel on public.rueckmeldungen;
create trigger rueckmeldungen_zeitstempel
  before update on public.rueckmeldungen
  for each row execute function public.zeitstempel_setzen();

-- Live-Aktualisierung
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.rueckmeldungen;
    exception when duplicate_object then null;
    end;
  end if;
end;
$$;
