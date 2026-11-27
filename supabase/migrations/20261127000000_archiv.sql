-- =====================================================================
--  Archiv: frühere Texte (Hallo Bad Krozingen, Website, Pressemitteilungen,
--  Anträge/Reden, BZ-Fundstellen nur als Link) – durchsuchbar, nur lesend.
--  Deutsche Volltextsuche: findet Wortformen (Baum/Bäume) und Wortanfänge.
-- =====================================================================

create table if not exists public.texte (
  id        bigint generated always as identity primary key,
  datum     date not null,
  quelle    text not null check (quelle in ('hallo', 'website', 'presse', 'antrag', 'bz')),
  titel     text not null,
  text      text not null default '',
  link      text,
  herkunft  text unique,          -- Schlüssel für wiederholbare Importe, z. B. "wp:10565"
  such      tsvector generated always as (
              setweight(to_tsvector('german', coalesce(titel, '')), 'A') ||
              setweight(to_tsvector('german', coalesce(text, '')), 'B')
            ) stored
);

create index if not exists texte_such_idx on public.texte using gin (such);
create index if not exists texte_datum_idx on public.texte (datum desc);

alter table public.texte enable row level security;
drop policy if exists "Vorstand liest Archiv" on public.texte;
create policy "Vorstand liest Archiv" on public.texte
  for select to authenticated using (public.ist_vorstand());
revoke all on public.texte from anon, authenticated;
grant select on public.texte to authenticated;

-- Suche: jedes Wort auch als Wortanfang („Fahrr“ findet „Fahrradstraße“),
-- deutsche Grundformen („Bäume“ findet „Baum“). Ohne Treffer: einfache Textsuche.
create or replace function public.texte_suchen(begriff text, anzahl int default 50)
returns table (id bigint, datum date, quelle text, titel text, link text, auszug text)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  woerter text;
  q tsquery;
begin
  select string_agg(w || ':*', ' & ')
    into woerter
  from (
    select regexp_replace(w, '[^[:alnum:]äöüß]', '', 'g') as w
    from regexp_split_to_table(lower(coalesce(begriff, '')), '\s+') as w
  ) x
  where length(w) >= 2;

  if woerter is null then
    return;
  end if;
  q := to_tsquery('german', woerter);

  return query
  select t.id, t.datum, t.quelle, t.titel, t.link,
         ts_headline('german', t.text, q,
           'MaxWords=28, MinWords=12, MaxFragments=1, StartSel=«, StopSel=», FragmentDelimiter=" … "')
  from public.texte t
  where t.such @@ q
  order by ts_rank(t.such, q) desc, t.datum desc
  limit anzahl;

  if not found then
    return query
    select t.id, t.datum, t.quelle, t.titel, t.link, left(t.text, 180)
    from public.texte t
    where t.titel ilike '%' || begriff || '%' or t.text ilike '%' || begriff || '%'
    order by t.datum desc
    limit anzahl;
  end if;
end;
$$;
revoke execute on function public.texte_suchen(text, int) from public, anon;
grant execute on function public.texte_suchen(text, int) to authenticated;

-- HTML (von der Website) in lesbaren Text umwandeln
create or replace function public.html_zu_text(html text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  t text := coalesce(html, '');
  m text[];
begin
  t := regexp_replace(t, '<script[^>]*>.*?</script>', '', 'gi');
  t := regexp_replace(t, '<style[^>]*>.*?</style>', '', 'gi');
  t := regexp_replace(t, '<br\s*/?>', E'\n', 'gi');
  t := regexp_replace(t, '</(p|div|h[1-6]|li|tr|blockquote|figure)>', E'\n\n', 'gi');
  t := regexp_replace(t, '<li[^>]*>', '– ', 'gi');
  t := regexp_replace(t, '<[^>]+>', '', 'g');
  -- Zahlen-Entitäten (&#8211; &#x201e; …)
  for m in select regexp_matches(t, '&#(x?[0-9a-fA-F]+);', 'g') loop
    begin
      t := replace(t, '&#' || m[1] || ';',
                   chr(case when m[1] ilike 'x%' then ('x' || lpad(substr(m[1], 2), 8, '0'))::bit(32)::int
                            else m[1]::int end));
    exception when others then null;
    end;
  end loop;
  t := replace(replace(replace(replace(replace(replace(t,
         '&nbsp;', ' '), '&quot;', '"'), '&lt;', '<'), '&gt;', '>'), '&hellip;', '…'), '&ndash;', '–');
  t := replace(replace(replace(replace(t, '&auml;', 'ä'), '&ouml;', 'ö'), '&uuml;', 'ü'), '&szlig;', 'ß');
  t := replace(t, '&amp;', '&');
  t := regexp_replace(t, '[ \t ]+', ' ', 'g');
  t := regexp_replace(t, ' *\n *', E'\n', 'g');
  t := regexp_replace(t, E'\n{3,}', E'\n\n', 'g');
  return trim(t);
end;
$$;
revoke execute on function public.html_zu_text(text) from public, anon, authenticated;
