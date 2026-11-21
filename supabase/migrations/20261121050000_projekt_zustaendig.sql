-- =====================================================================
--  Projekte bekommen eine zuständige Person.
--  Beim Duplizieren wird sie mitkopiert.
-- =====================================================================

alter table public.projekte
  add column if not exists zustaendig uuid references public.profiles (id) on delete set null;

create index if not exists projekte_zustaendig_idx on public.projekte (zustaendig);

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

  insert into public.projekte (name, beschreibung, zustaendig)
  values (coalesce(nullif(trim(neuer_name), ''), p.name || ' (Kopie)'), p.beschreibung, p.zustaendig)
  returning id into neu;

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
