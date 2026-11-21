-- =====================================================================
--  Freiwillige Uhrzeit für Fristen von Aufgaben und Unterpunkten.
--  Sortierung, Duplizieren und "Nach Datum sortieren" berücksichtigen sie.
-- =====================================================================

alter table public.aufgaben add column if not exists faellig_zeit time;

do $$
begin
  alter table public.aufgaben
    add constraint zeit_braucht_datum check (faellig_zeit is null or faellig is not null);
exception when duplicate_object then null;
end;
$$;

create or replace function public.aufgabe_einsortieren()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  nachfolger double precision;
  vorgaenger double precision;
  schluessel timestamp := new.faellig + coalesce(new.faellig_zeit, time '23:59:59');
begin
  if tg_op = 'UPDATE' then
    -- Von Hand verschoben, oder Datum unverändert: nichts tun
    if new.position is distinct from old.position
       or (new.faellig is not distinct from old.faellig and new.faellig_zeit is not distinct from old.faellig_zeit) then
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
  where id <> new.id and faellig is not null
    and faellig + coalesce(faellig_zeit, time '23:59:59') <= schluessel;

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
  before insert or update of faellig, faellig_zeit, position on public.aufgaben
  for each row execute function public.aufgabe_einsortieren();

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
      select id, row_number() over (order by faellig nulls last, faellig_zeit nulls last, created_at, id) as nr
      from public.aufgaben
    ) n
    where a.id = n.id;
  else
    update public.aufgaben a
    set position = plaetze.position
    from (
      select id, row_number() over (order by faellig nulls last, faellig_zeit nulls last, created_at, id) as nr
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

create or replace function public.termin_duplizieren(
  quelle uuid,
  neues_datum date,
  neue_start_zeit time default null,
  neue_end_zeit time default null
)
returns uuid
language plpgsql
set search_path = ''
as $$
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

  insert into public.termine (titel, datum, bis_datum, start_zeit, end_zeit, ort, beschreibung, projekt_id)
  values (
    q.titel, neues_datum, q.bis_datum + abstand,
    neue_start_zeit,
    case when neue_start_zeit is null then null else neue_end_zeit end,
    q.ort, q.beschreibung, q.projekt_id
  )
  returning id into neu;

  -- Reihenfolge der Unterpunkte beibehalten (eigene Zeitstempel je Zeile)
  insert into public.aufgaben (titel, beschreibung, zustaendig, faellig, faellig_zeit, projekt_id, termin_id, status, created_at)
  select a.titel, a.beschreibung, a.zustaendig, a.faellig + abstand, a.faellig_zeit, a.projekt_id, neu, 'offen',
         now() + (row_number() over (order by a.created_at, a.id)) * interval '1 millisecond'
  from public.aufgaben a
  where a.termin_id = quelle;

  return neu;
end;
$$;

create or replace function public.projekt_duplizieren(
  quelle uuid,
  neuer_name text,
  verschiebung_tage integer default 0
)
returns uuid
language plpgsql
set search_path = ''
as $$
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
    insert into public.termine (titel, datum, bis_datum, start_zeit, end_zeit, ort, beschreibung, projekt_id)
    values (t.titel, t.datum + verschiebung_tage, t.bis_datum + verschiebung_tage,
            t.start_zeit, t.end_zeit, t.ort, t.beschreibung, neu)
    returning id into neuer_termin;

    insert into public.aufgaben (titel, beschreibung, zustaendig, faellig, faellig_zeit, projekt_id, termin_id, status, created_at)
    select a.titel, a.beschreibung, a.zustaendig, a.faellig + verschiebung_tage, a.faellig_zeit,
           case when a.projekt_id = quelle then neu else a.projekt_id end,
           neuer_termin, 'offen',
           now() + (row_number() over (order by a.created_at, a.id)) * interval '1 millisecond'
    from public.aufgaben a
    where a.termin_id = t.id;
  end loop;

  insert into public.aufgaben (titel, beschreibung, zustaendig, faellig, faellig_zeit, projekt_id, termin_id, status, created_at)
  select a.titel, a.beschreibung, a.zustaendig, a.faellig + verschiebung_tage, a.faellig_zeit, neu, null, 'offen',
         now() + interval '1 second' + (row_number() over (order by a.created_at, a.id)) * interval '1 millisecond'
  from public.aufgaben a
  where a.projekt_id = quelle
    and (a.termin_id is null
         or a.termin_id not in (select x.id from public.termine x where x.projekt_id = quelle));

  return neu;
end;
$$;
