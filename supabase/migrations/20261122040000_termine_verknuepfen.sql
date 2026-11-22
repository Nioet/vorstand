-- =====================================================================
--  Externe Termine mit eigenen Terminen verknüpfen
--  * gehoert_zu: der eigene Termin, zu dem ein externer Termin gehört.
--    Verknüpfte externe Termine verschwinden aus der Übersicht und
--    erscheinen im eigenen Termin.
--  * Vergangene Kreistermine, an denen wir nichts ergänzt haben,
--    werden beim Abgleich entfernt.
-- =====================================================================

alter table public.termine
  add column if not exists gehoert_zu uuid references public.termine (id) on delete set null;

alter table public.termine drop constraint if exists nicht_mit_sich_selbst;
alter table public.termine
  add constraint nicht_mit_sich_selbst check (gehoert_zu is null or gehoert_zu <> id);

create index if not exists termine_gehoert_zu_idx on public.termine (gehoert_zu) where gehoert_zu is not null;

create or replace function public.kreis_termine_abgleichen(eintraege jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  geaendert integer;
  entfernt integer;
  vergangen integer;
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
  where (t.titel, t.datum, t.bis_datum, t.start_zeit, t.end_zeit, t.ort, t.beschreibung, t.link)
        is distinct from
        (excluded.titel, excluded.datum, excluded.bis_datum, excluded.start_zeit, excluded.end_zeit,
         excluded.ort, excluded.beschreibung, excluded.link);
  get diagnostics geaendert = row_count;

  -- Abgesagte (kommende) Termine entfernen – aber nur, wenn wir nichts ergänzt haben
  delete from public.termine t
  where t.quelle = 'kreisverband'
    and t.datum >= current_date
    and t.zustaendig is null and t.projekt_id is null and t.gehoert_zu is null
    and not exists (select 1 from public.aufgaben a where a.termin_id = t.id)
    and not exists (select 1 from jsonb_array_elements(eintraege) e where e->>'uid' = t.quelle_uid);
  get diagnostics entfernt = row_count;

  -- Vorbei und nichts ergänzt: aufräumen
  delete from public.termine t
  where t.quelle = 'kreisverband'
    and coalesce(t.bis_datum, t.datum) < current_date
    and t.zustaendig is null and t.projekt_id is null and t.gehoert_zu is null
    and not exists (select 1 from public.aufgaben a where a.termin_id = t.id);
  get diagnostics vergangen = row_count;

  return jsonb_build_object('geaendert', geaendert, 'entfernt', entfernt, 'vergangen', vergangen);
end;
$$;

revoke execute on function public.kreis_termine_abgleichen(jsonb) from public, anon, authenticated;
grant execute on function public.kreis_termine_abgleichen(jsonb) to service_role;
