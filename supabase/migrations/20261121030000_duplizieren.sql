-- =====================================================================
--  Duplizieren von Terminen und Projekten (jeweils alles oder nichts).
--  Kopierte Unterpunkte und Aufgaben sind wieder "offen"; ihre Fristen
--  verschieben sich um denselben Abstand wie das Datum.
--  SECURITY INVOKER: Es gelten die normalen Zugriffsregeln.
-- =====================================================================

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
  insert into public.aufgaben (titel, beschreibung, zustaendig, faellig, projekt_id, termin_id, status, created_at)
  select a.titel, a.beschreibung, a.zustaendig, a.faellig + abstand, a.projekt_id, neu, 'offen',
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

  insert into public.projekte (name, beschreibung)
  values (coalesce(nullif(trim(neuer_name), ''), p.name || ' (Kopie)'), p.beschreibung)
  returning id into neu;

  -- Termine des Projekts mit ihren Unterpunkten
  for t in select * from public.termine where projekt_id = quelle order by datum, start_zeit loop
    insert into public.termine (titel, datum, bis_datum, start_zeit, end_zeit, ort, beschreibung, projekt_id)
    values (t.titel, t.datum + verschiebung_tage, t.bis_datum + verschiebung_tage,
            t.start_zeit, t.end_zeit, t.ort, t.beschreibung, neu)
    returning id into neuer_termin;

    insert into public.aufgaben (titel, beschreibung, zustaendig, faellig, projekt_id, termin_id, status, created_at)
    select a.titel, a.beschreibung, a.zustaendig, a.faellig + verschiebung_tage,
           case when a.projekt_id = quelle then neu else a.projekt_id end,
           neuer_termin, 'offen',
           now() + (row_number() over (order by a.created_at, a.id)) * interval '1 millisecond'
    from public.aufgaben a
    where a.termin_id = t.id;
  end loop;

  -- Übrige Aufgaben des Projekts (ohne Termin oder an fremden Terminen)
  insert into public.aufgaben (titel, beschreibung, zustaendig, faellig, projekt_id, termin_id, status, created_at)
  select a.titel, a.beschreibung, a.zustaendig, a.faellig + verschiebung_tage, neu, null, 'offen',
         now() + interval '1 second' + (row_number() over (order by a.created_at, a.id)) * interval '1 millisecond'
  from public.aufgaben a
  where a.projekt_id = quelle
    and (a.termin_id is null
         or a.termin_id not in (select x.id from public.termine x where x.projekt_id = quelle));

  return neu;
end;
$$;

revoke execute on function public.termin_duplizieren(uuid, date, time, time) from public, anon;
revoke execute on function public.projekt_duplizieren(uuid, text, integer) from public, anon;
grant execute on function public.termin_duplizieren(uuid, date, time, time) to authenticated;
grant execute on function public.projekt_duplizieren(uuid, text, integer) to authenticated;
