-- =====================================================================
--  Reihenfolge von Aufgaben und Unterpunkten
--  - Spalte "position" bestimmt die Reihenfolge überall in der App.
--  - Neue Einträge (und solche mit geändertem Datum) werden automatisch
--    nach Fälligkeit einsortiert; ohne Datum ans Ende.
--  - Von Hand verschobene Einträge behalten ihre Position.
--  - aufgaben_nach_datum() stellt die Datumsreihenfolge wieder her.
-- =====================================================================

alter table public.aufgaben add column if not exists position double precision;

-- Bestehende Einträge einmalig nach Datum durchnummerieren
update public.aufgaben a
set position = n.nr * 1000
from (
  select id, row_number() over (order by faellig nulls last, created_at, id) as nr
  from public.aufgaben
) n
where a.id = n.id and a.position is null;

create index if not exists aufgaben_position_idx on public.aufgaben (position);

-- Position so wählen, dass der Eintrag nach Datum an der richtigen Stelle steht
create or replace function public.aufgabe_einsortieren()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  nachfolger double precision;
  vorgaenger double precision;
begin
  if tg_op = 'UPDATE' then
    -- Von Hand verschoben, oder Datum unverändert: nichts tun
    if new.position is distinct from old.position or new.faellig is not distinct from old.faellig then
      return new;
    end if;
  elsif new.position is not null then
    return new;
  end if;

  if new.faellig is null then
    select max(position) into vorgaenger from public.aufgaben where id <> new.id;
    new.position := coalesce(vorgaenger, 0) + 1000;
    return new;
  end if;

  -- direkt hinter den letzten Eintrag, der früher oder am selben Tag fällig ist
  select max(position) into vorgaenger
  from public.aufgaben
  where id <> new.id and faellig is not null and faellig <= new.faellig;

  if vorgaenger is not null then
    select min(position) into nachfolger
    from public.aufgaben where id <> new.id and position > vorgaenger;
    new.position := case
      when nachfolger is null then vorgaenger + 1000
      else (vorgaenger + nachfolger) / 2
    end;
  else
    -- früher als alles andere: vor den ersten Eintrag mit Datum
    select min(position) into nachfolger
    from public.aufgaben where id <> new.id and faellig is not null;
    if nachfolger is null then
      select min(position) into nachfolger from public.aufgaben where id <> new.id;
    end if;
    if nachfolger is null then
      new.position := 1000;
    else
      select max(position) into vorgaenger
      from public.aufgaben where id <> new.id and position < nachfolger;
      new.position := case
        when vorgaenger is null then nachfolger - 1000
        else (vorgaenger + nachfolger) / 2
      end;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists aufgaben_einsortieren on public.aufgaben;
create trigger aufgaben_einsortieren
  before insert or update of faellig, position on public.aufgaben
  for each row execute function public.aufgabe_einsortieren();

-- Datumsreihenfolge wiederherstellen: für alle Aufgaben oder nur für
-- die Unterpunkte eines Termins (die dann ihre bisherigen Plätze tauschen)
create or replace function public.aufgaben_nach_datum(nur_termin uuid default null)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if nur_termin is null then
    update public.aufgaben a
    set position = n.nr * 1000
    from (
      select id, row_number() over (order by faellig nulls last, created_at, id) as nr
      from public.aufgaben
    ) n
    where a.id = n.id;
  else
    update public.aufgaben a
    set position = plaetze.position
    from (
      select id, row_number() over (order by faellig nulls last, created_at, id) as nr
      from public.aufgaben where termin_id = nur_termin
    ) n
    join (
      select position, row_number() over (order by position) as nr
      from public.aufgaben where termin_id = nur_termin
    ) plaetze on plaetze.nr = n.nr
    where a.id = n.id;
  end if;
end;
$$;

revoke execute on function public.aufgaben_nach_datum(uuid) from public, anon;
grant execute on function public.aufgaben_nach_datum(uuid) to authenticated;
revoke execute on function public.aufgabe_einsortieren() from public, anon, authenticated;
