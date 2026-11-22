// Holt die Termine des Kreisverbands (ICS-Export der Website) und gleicht
// sie mit der Tabelle "termine" ab (Supabase Edge Function "kreis-termine").
// Wird stündlich von pg_cron aufgerufen, siehe Migration 20261122030000.
//
// deno-lint-ignore-file no-explicit-any
// Es werden nur öffentliche Termine von einer festen Adresse gelesen,
// deshalb braucht der Aufruf keine Anmeldung.

const QUELLE = (globalThis as any).Deno?.env.get("KREIS_ICS_URL") ?? "https://gruene-breisgau-hochschwarzwald.de/termine/?format=ics";

export type Eintrag = {
  uid: string;
  titel: string;
  datum: string;
  bis_datum: string | null;
  start_zeit: string | null;
  end_zeit: string | null;
  ort: string | null;
  beschreibung: string | null;
  link: string | null;
};

const ENTITAETEN: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß",
  ndash: "–", mdash: "—", hellip: "…", bdquo: "„", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", euro: "€",
};

/** HTML-Reste entfernen (manche Websites schreiben HTML in die Beschreibung) */
export function klartext(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITAETEN[n] ?? ENTITAETEN[n.toLowerCase()] ?? m)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function entmaskieren(s: string): string {
  return s.replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
}

const fmtBerlin = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Berlin",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/** Liefert [Datum, Uhrzeit|null] in Berliner Ortszeit */
export function zeitpunkt(wert: string): [string, string | null] {
  const m = wert.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) throw new Error(`Unbekanntes Datum: ${wert}`);
  const [, y, mo, d, h, mi, , z] = m;
  if (h === undefined) return [`${y}-${mo}-${d}`, null];
  if (z) {
    const t = fmtBerlin.format(new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi)));
    const [datum, uhr] = t.split(" ");
    return [datum, uhr];
  }
  // Mit TZID oder ohne Zone: als Ortszeit nehmen (die Website liegt in Deutschland)
  return [`${y}-${mo}-${d}`, `${h}:${mi}`];
}

function tagDavor(d: string): string {
  const [y, m, t] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, t - 1)).toISOString().slice(0, 10);
}

export function leseIcs(text: string): Eintrag[] {
  const zeilen = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const liste: Eintrag[] = [];
  let ev: Record<string, string> | null = null;
  for (const zeile of zeilen) {
    if (zeile === "BEGIN:VEVENT") { ev = {}; continue; }
    if (zeile === "END:VEVENT") {
      if (ev) {
        try {
          const e = baueEintrag(ev);
          if (e) liste.push(e);
        } catch (err) {
          console.error("Termin übersprungen:", err);
        }
      }
      ev = null;
      continue;
    }
    if (!ev) continue;
    // Parameter können in Anführungszeichen Doppelpunkte enthalten (z. B. ALTREP="data:…")
    const m = zeile.match(/^([A-Za-z-]+)((?:;[^:;"=]+=(?:"[^"]*"|[^:;"]*))*):(.*)$/);
    if (m) ev[m[1].toUpperCase()] = m[3];
  }
  return liste;
}

function baueEintrag(ev: Record<string, string>): Eintrag | null {
  if (!ev.DTSTART || !ev.SUMMARY) return null;
  if ((ev.STATUS ?? "").toUpperCase() === "CANCELLED") return null;
  const [datum, start] = zeitpunkt(ev.DTSTART);
  let bis: string | null = null;
  let ende: string | null = null;
  if (ev.DTEND) {
    const [endDatum, endZeit] = zeitpunkt(ev.DTEND);
    if (start === null) {
      // ganztägig: DTEND ist der Tag nach dem letzten Tag
      const letzter = tagDavor(endDatum);
      if (letzter > datum) bis = letzter;
    } else {
      // Die Website trägt ohne Endzeit automatisch „eine Stunde später“ ein – das zeigen wir nicht
      ende = endDatum === datum && endZeit !== null && minuten(endZeit) - minuten(start) === 60 ? null : endZeit;
      if (endDatum > datum) {
        // Endet kurz nach Mitternacht → kein mehrtägiger Termin
        if (!(endDatum === plusEinTag(datum) && endZeit !== null && endZeit <= start)) bis = endDatum;
      }
    }
  }
  const text = (s?: string) => (s ? klartext(entmaskieren(s)) : "");
  const link = ev.URL ? entmaskieren(ev.URL).trim() : null;
  const titel = text(ev.SUMMARY);
  return {
    // Die Website vergibt bei jedem Abruf eine neue UID. Fester Schlüssel ist
    // deshalb die Adresse der Termin-Seite (sonst Titel + Datum).
    uid: link || `${titel}|${datum}`,
    titel,
    datum,
    bis_datum: bis,
    start_zeit: start,
    end_zeit: start ? ende : null,
    ort: text(ev.LOCATION) || null,
    beschreibung: text(ev.DESCRIPTION) || null,
    link,
  };
}

const minuten = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

function plusEinTag(d: string): string {
  const [y, m, t] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, t + 1)).toISOString().slice(0, 10);
}

async function abgleichen(): Promise<Response> {
  const antwort = await fetch(QUELLE, { headers: { "User-Agent": "Vorstands-App Gruene BK (Kalenderabgleich)" } });
  if (!antwort.ok) throw new Error(`Website antwortet mit ${antwort.status}`);
  const text = await antwort.text();
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error("Keine ICS-Datei erhalten");
  const eintraege = leseIcs(text);
  // Leere Liste ist eher ein Fehler der Website: dann lieber nichts ändern
  if (!eintraege.length) return Response.json({ ok: true, termine: 0, hinweis: "keine Termine gefunden, nichts geändert" });

  const basis = Deno.env.get("SUPABASE_URL")!;
  const schluessel = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_KEY")!;
  const headers: Record<string, string> = { apikey: schluessel, "Content-Type": "application/json" };
  if (schluessel.startsWith("eyJ")) headers.Authorization = `Bearer ${schluessel}`;
  const res = await fetch(`${basis}/rest/v1/rpc/kreis_termine_abgleichen`, {
    method: "POST",
    headers,
    body: JSON.stringify({ eintraege }),
  });
  if (!res.ok) throw new Error(`Datenbank: ${res.status} ${await res.text()}`);
  return Response.json({ ok: true, termine: eintraege.length, ergebnis: await res.json() });
}

// deno-lint-ignore no-explicit-any
const D = (globalThis as any).Deno;
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
