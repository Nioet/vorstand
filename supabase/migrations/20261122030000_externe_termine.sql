-- =====================================================================
--  Externe Termine
--  * Termine anderer Gliederungen (z. B. Kreisverband), die wir nicht
--    selbst organisieren. Sie erscheinen kompakt in der Übersicht.
--  * „zustaendig“: wer von uns den externen Termin übernimmt.
--  * Termine von der Website des Kreisverbands werden automatisch
--    abgeglichen (quelle = 'kreisverband', quelle_uid = UID aus der ICS-Datei).
-- =====================================================================

alter table public.termine
  add column if not exists extern     boolean not null default false,
  add column if not exists zustaendig uuid references public.profiles (id) on delete set null,
  add column if not exists quelle     text,
  add column if not exists quelle_uid text,
  add column if not exists link       text;

alter table public.termine drop constraint if exists termine_quelle_eindeutig;
alter table public.termine
  add constraint termine_quelle_eindeutig unique (quelle, quelle_uid);

-- Importierte Termine sind immer extern
alter table public.termine drop constraint if exists quelle_ist_extern;
alter table public.termine
  add constraint quelle_ist_extern check (quelle is null or extern);

-- ---------------------------------------------------------------------
--  Abgleich mit der Website des Kreisverbands.
--  Erwartet ein JSON-Array mit uid, titel, datum, bis_datum, start_zeit,
--  end_zeit, ort, beschreibung, link. Nur die Edge Function darf das.
--  Unsere eigenen Ergänzungen (wer übernimmt, Projekt, Unterpunkte)
--  bleiben erhalten.
-- ---------------------------------------------------------------------
create or replace function public.kreis_termine_abgleichen(eintraege jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  geaendert integer;
  entfernt integer;
begin
  with neu as (
    select
      e->>'uid'                                  as uid,
      left(trim(e->>'titel'), 300)               as titel,
      (e->>'datum')::date                        as datum,
      nullif(e->>'bis_datum', '')::date          as bis_datum,
      nullif(e->>'start_zeit', '')::time         as start_zeit,
      nullif(e->>'end_zeit', '')::time           as end_zeit,
      nullif(left(trim(e->>'ort'), 300), '')     as ort,
      nullif(left(trim(e->>'beschreibung'), 4000), '') as beschreibung,
      nullif(left(trim(e->>'link'), 500), '')    as link
    from jsonb_array_elements(eintraege) e
    where coalesce(e->>'uid', '') <> '' and coalesce(trim(e->>'titel'), '') <> '' and e->>'datum' is not null
  ), sauber as (
    select uid, titel, datum,
           case when bis_datum > datum then bis_datum end as bis_datum,
           start_zeit,
           case when start_zeit is not null then end_zeit end as end_zeit,
           ort, beschreibung, link
    from neu
  )
  insert into public.termine as t
    (quelle, quelle_uid, extern, titel, datum, bis_datum, start_zeit, end_zeit, ort, beschreibung, link)
  select 'kreisverband', uid, true, titel, datum, bis_datum, start_zeit, end_zeit, ort, beschreibung, link
  from sauber
  on conflict (quelle, quelle_uid) do update set
    titel = excluded.titel, datum = excluded.datum, bis_datum = excluded.bis_datum,
    start_zeit = excluded.start_zeit, end_zeit = excluded.end_zeit, ort = excluded.ort,
    beschreibung = excluded.beschreibung, link = excluded.link
  -- nur echte Änderungen schreiben (sonst jede Stunde Neuladen in allen Apps)
  where (t.titel, t.datum, t.bis_datum, t.start_zeit, t.end_zeit, t.ort, t.beschreibung, t.link)
        is distinct from
        (excluded.titel, excluded.datum, excluded.bis_datum, excluded.start_zeit, excluded.end_zeit,
         excluded.ort, excluded.beschreibung, excluded.link);
  get diagnostics geaendert = row_count;

  -- Abgesagte (kommende) Termine entfernen – aber nur, wenn wir nichts ergänzt haben
  delete from public.termine t
  where t.quelle = 'kreisverband'
    and t.datum >= current_date
    and t.zustaendig is null
    and t.projekt_id is null
    and not exists (select 1 from public.aufgaben a where a.termin_id = t.id)
    and not exists (select 1 from jsonb_array_elements(eintraege) e where e->>'uid' = t.quelle_uid);
  get diagnostics entfernt = row_count;

  return jsonb_build_object('geaendert', geaendert, 'entfernt', entfernt);
end;
$$;

revoke execute on function public.kreis_termine_abgleichen(jsonb) from public, anon, authenticated;
grant execute on function public.kreis_termine_abgleichen(jsonb) to service_role;

-- Duplizieren eines externen Termins: „extern“ und „wer übernimmt“ gehen mit,
-- die Verbindung zur Website nicht (die Kopie gehört dann uns).
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

  insert into public.termine (titel, datum, bis_datum, start_zeit, end_zeit, ort, beschreibung, projekt_id, extern, zustaendig, link)
  values (
    q.titel, neues_datum, q.bis_datum + abstand,
    neue_start_zeit,
    case when neue_start_zeit is null then null else neue_end_zeit end,
    q.ort, q.beschreibung, q.projekt_id, q.extern, q.zustaendig, q.link
  )
  returning id into neu;

  insert into public.aufgaben (titel, beschreibung, zustaendig, zustaendig_extern, faellig, faellig_zeit, projekt_id, termin_id, status, created_at)
  select a.titel, a.beschreibung, a.zustaendig, a.zustaendig_extern, a.faellig + abstand, a.faellig_zeit, a.projekt_id, neu, 'offen',
         now() + (row_number() over (order by a.created_at, a.id)) * interval '1 millisecond'
  from public.aufgaben a
  where a.termin_id = quelle;

  return neu;
end;
$$;

-- Neue Spalte „quelle“ heißt wie der Parameter: Variable hat Vorrang
create or replace function public.projekt_duplizieren(
  quelle uuid,
  neuer_name text,
  verschiebung_tage integer default 0
)
returns uuid
language plpgsql
set search_path = ''
as $$
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
    insert into public.termine (titel, datum, bis_datum, start_zeit, end_zeit, ort, beschreibung, projekt_id, extern, zustaendig, link)
    values (t.titel, t.datum + verschiebung_tage, t.bis_datum + verschiebung_tage,
            t.start_zeit, t.end_zeit, t.ort, t.beschreibung, neu, t.extern, t.zustaendig, t.link)
    returning id into neuer_termin;

    insert into public.aufgaben (titel, beschreibung, zustaendig, zustaendig_extern, faellig, faellig_zeit, projekt_id, termin_id, status, created_at)
    select a.titel, a.beschreibung, a.zustaendig, a.zustaendig_extern, a.faellig + verschiebung_tage, a.faellig_zeit,
           case when a.projekt_id = quelle then neu else a.projekt_id end,
           neuer_termin, 'offen',
           now() + (row_number() over (order by a.created_at, a.id)) * interval '1 millisecond'
    from public.aufgaben a
    where a.termin_id = t.id;
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
$$;

-- ---------------------------------------------------------------------
--  Stündlicher Abgleich: pg_cron ruft die Edge Function „kreis-termine“ auf
-- ---------------------------------------------------------------------
create extension if not exists pg_net;
create extension if not exists pg_cron;

select cron.unschedule('kreis-termine') where exists (select 1 from cron.job where jobname = 'kreis-termine');
select cron.schedule(
  'kreis-termine',
  '17 * * * *',
  $cron$select net.http_post(
    url := 'https://gfkemraayaphjfxwpalx.supabase.co/functions/v1/kreis-termine',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  )$cron$
);
