-- =====================================================================
--  Unterpunkte (Aufgaben mit Termin) haben kein eigenes Projekt:
--  Es gilt immer das Projekt ihres Termins. Ein eigenes Projekt haben
--  nur freie Aufgaben ohne Termin.
-- =====================================================================

create or replace function public.unterpunkt_ohne_eigenes_projekt()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.termin_id is not null then
    new.projekt_id := null;
  end if;
  return new;
end;
$$;

revoke execute on function public.unterpunkt_ohne_eigenes_projekt() from public, anon, authenticated;

drop trigger if exists aufgaben_unterpunkt_projekt on public.aufgaben;
create trigger aufgaben_unterpunkt_projekt
  before insert or update of termin_id, projekt_id on public.aufgaben
  for each row execute function public.unterpunkt_ohne_eigenes_projekt();

-- Bestehende Unterpunkte bereinigen
update public.aufgaben set projekt_id = null where termin_id is not null and projekt_id is not null;
