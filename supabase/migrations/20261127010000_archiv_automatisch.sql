-- =====================================================================
--  Archiv: neue Website-Beiträge automatisch übernehmen.
--  Die Edge Function "archiv-website" holt stündlich die 20 neuesten
--  Beiträge über die WordPress-Schnittstelle und reicht sie an diese
--  Funktion weiter. Neue Beiträge werden eingefügt; Beiträge der letzten
--  14 Tage werden aktualisiert, falls sie nachträglich korrigiert wurden.
-- =====================================================================

create or replace function public.texte_website_abgleichen(beitraege jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  neu int := 0;
  geaendert int := 0;
begin
  with daten as (
    select (b->>'date')::date as datum,
           coalesce(nullif(trim(replace(public.html_zu_text(b->>'title'), chr(65279), '')), ''), 'Ohne Titel') as titel,
           regexp_replace(regexp_replace(replace(public.html_zu_text(b->>'content'), chr(65279), ''),
                '^\s*charset=InvalidCharsetId[^}]*\}', ''), '^\s+|\s+$', '', 'g') as text,
           b->>'link' as link,
           'wp:' || (b->>'id') as herkunft
    from jsonb_array_elements(beitraege) b
    where b->>'id' is not null and b->>'date' is not null
  ),
  ergebnis as (
    insert into public.texte as t (datum, quelle, titel, text, link, herkunft)
    select datum, 'website', titel, text, link, herkunft from daten
    on conflict (herkunft) do update
      set titel = excluded.titel, text = excluded.text, link = excluded.link, datum = excluded.datum
      where t.datum >= current_date - 14
        and (t.titel, t.text, t.link, t.datum) is distinct from (excluded.titel, excluded.text, excluded.link, excluded.datum)
    returning (xmax = 0) as eingefuegt
  )
  select count(*) filter (where eingefuegt), count(*) filter (where not eingefuegt)
    into neu, geaendert from ergebnis;
  return jsonb_build_object('neu', neu, 'geaendert', geaendert);
end;
$$;
revoke execute on function public.texte_website_abgleichen(jsonb) from public, anon, authenticated;
grant execute on function public.texte_website_abgleichen(jsonb) to service_role;
grant execute on function public.html_zu_text(text) to service_role;

-- Leerzeilen am Anfang und Ende der bisherigen Texte entfernen
-- (html_zu_text entfernt sie inzwischen selbst, siehe Migration 20261127000000)
update public.texte set text = regexp_replace(text, '^\s+|\s+$', '', 'g')
where text ~ '^\s|\s$';

-- Stündlicher Abruf (nach dem Bereitstellen der Edge Function "archiv-website")
select cron.unschedule('archiv-website') where exists (select 1 from cron.job where jobname = 'archiv-website');
select cron.schedule(
  'archiv-website',
  '37 * * * *',
  $cron$select net.http_post(
    url := 'https://gfkemraayaphjfxwpalx.supabase.co/functions/v1/archiv-website',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  )$cron$
);
