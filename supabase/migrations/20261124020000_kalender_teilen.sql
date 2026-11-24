-- =====================================================================
--  Zweiter Kalender zum Teilen
--  id 1 = Vorstands-Kalender (alles), id 2 = zum Weitergeben
--  (nur eigene Termine mit Zeit und Ort, ohne Aufgaben, Unterpunkte,
--  Notizen und externe Termine). Eigene Links, getrennt erneuerbar.
-- =====================================================================

alter table public.kalender_abo drop constraint if exists kalender_abo_id_check;
alter table public.kalender_abo add constraint kalender_abo_id_check check (id in (1, 2));
insert into public.kalender_abo (id) values (2) on conflict (id) do nothing;

drop function if exists public.abo_token_erneuern();
create or replace function public.abo_token_erneuern(welcher smallint default 1)
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
  update public.kalender_abo set token = neu where id = welcher;
  return neu;
end;
$$;
revoke execute on function public.abo_token_erneuern(smallint) from public, anon;
grant execute on function public.abo_token_erneuern(smallint) to authenticated;
