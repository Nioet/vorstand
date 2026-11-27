// Übernimmt neue Beiträge von gruene-bad-krozingen.de ins Archiv
// (Supabase Edge Function "archiv-website"). Wird stündlich von pg_cron
// aufgerufen, siehe Migration 20261127010000_archiv_automatisch.sql.
// Gelesen werden nur öffentliche Beiträge von einer festen Adresse,
// deshalb braucht der Aufruf keine Anmeldung.
//
// deno-lint-ignore-file no-explicit-any

const D = (globalThis as any).Deno;
const QUELLE = D?.env.get("ARCHIV_WP_URL") ??
  "https://gruene-bad-krozingen.de/wp-json/wp/v2/posts?per_page=20&_fields=id,date,link,title,content";

async function abgleichen(): Promise<Response> {
  const antwort = await fetch(QUELLE, { headers: { "User-Agent": "Vorstands-App Gruene BK (Archiv)" } });
  if (!antwort.ok) throw new Error(`Website antwortet mit ${antwort.status}`);
  const liste = await antwort.json();
  if (!Array.isArray(liste) || !liste.length) {
    return Response.json({ ok: true, beitraege: 0, hinweis: "keine Beiträge erhalten, nichts geändert" });
  }
  const beitraege = liste.map((b: any) => ({
    id: b.id,
    date: b.date,
    link: b.link,
    title: b.title?.rendered ?? "",
    content: b.content?.rendered ?? "",
  }));

  const basis = D.env.get("SUPABASE_URL")!;
  const schluessel = D.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? D.env.get("SERVICE_KEY")!;
  const headers: Record<string, string> = { apikey: schluessel, "Content-Type": "application/json" };
  if (schluessel.startsWith("eyJ")) headers.Authorization = `Bearer ${schluessel}`;
  const res = await fetch(`${basis}/rest/v1/rpc/texte_website_abgleichen`, {
    method: "POST",
    headers,
    body: JSON.stringify({ beitraege }),
  });
  if (!res.ok) throw new Error(`Datenbank: ${res.status} ${await res.text()}`);
  return Response.json({ ok: true, beitraege: beitraege.length, ergebnis: await res.json() });
}

if (D?.serve) {
  D.serve(async () => {
    try {
      return await abgleichen();
    } catch (e) {
      console.error(e);
      return Response.json({ ok: false, fehler: String(e) }, { status: 500 });
    }
  });
}
