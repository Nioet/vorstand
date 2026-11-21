// Kalender-Abo für die Vorstands-App (Supabase Edge Function "kalender").
// Liefert alle Termine und offene Aufgaben mit Frist als .ics-Datei.
// Aufruf: https://<projekt>.supabase.co/functions/v1/kalender?token=<geheim>
// Optional: &aufgaben=0 blendet die Aufgaben-Fristen aus.
//
// Bewusst ohne Abhängigkeiten in einer Datei, damit man sie auch im
// Supabase-Dashboard einfach einfügen kann.

export type Termin = {
  id: string;
  titel: string;
  datum: string;            // "2026-12-03"
  bis_datum: string | null;
  start_zeit: string | null; // "19:30:00"
  end_zeit: string | null;
  ort: string | null;
  beschreibung: string | null;
  updated_at: string;
};

export type Aufgabe = {
  id: string;
  titel: string;
  beschreibung: string | null;
  faellig: string;           // nur Aufgaben mit Datum
  status: string;
  zustaendig_name: string | null;
  updated_at: string;
};

const TZID = "Europe/Berlin";

const VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  `TZID:${TZID}`,
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

/** Text für iCalendar maskieren */
export function esc(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Zeilen nach 75 Bytes umbrechen, ohne UTF-8-Zeichen zu zerschneiden */
export function fold(line: string): string {
  const enc = new TextEncoder();
  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const len = enc.encode(ch).length;
    if (bytes + len > limit) {
      parts.push(current);
      current = "";
      bytes = 0;
      limit = 74; // Folgezeilen beginnen mit einem Leerzeichen
    }
    current += ch;
    bytes += len;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

const tag = (d: string) => d.replaceAll("-", "");
const uhr = (t: string) => t.slice(0, 8).padEnd(8, ":00").replaceAll(":", "").slice(0, 6);

function plusTage(d: string, n: number): string {
  const [y, m, day] = d.split("-").map(Number);
  const x = new Date(Date.UTC(y, m - 1, day + n));
  return x.toISOString().slice(0, 10);
}

function utcStempel(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function terminZuEvent(t: Termin, jetzt: string, domain: string): string[] {
  const z: string[] = [
    "BEGIN:VEVENT",
    `UID:termin-${t.id}@${domain}`,
    `DTSTAMP:${jetzt}`,
    `LAST-MODIFIED:${utcStempel(t.updated_at)}`,
    `SUMMARY:${esc(t.titel)}`,
  ];
  const ende = t.bis_datum ?? t.datum;

  if (!t.start_zeit) {
    // ganztägig: DTEND ist der Tag NACH dem letzten Tag
    z.push(`DTSTART;VALUE=DATE:${tag(t.datum)}`);
    z.push(`DTEND;VALUE=DATE:${tag(plusTage(ende, 1))}`);
  } else {
    z.push(`DTSTART;TZID=${TZID}:${tag(t.datum)}T${uhr(t.start_zeit)}`);
    if (t.end_zeit) {
      // Endet vor dem Beginn am selben Tag → geht über Mitternacht
      const endTag = ende === t.datum && t.end_zeit < t.start_zeit
        ? plusTage(ende, 1)
        : ende;
      z.push(`DTEND;TZID=${TZID}:${tag(endTag)}T${uhr(t.end_zeit)}`);
    } else if (t.bis_datum) {
      z.push(`DTEND;TZID=${TZID}:${tag(t.bis_datum)}T${uhr(t.start_zeit)}`);
    } else {
      z.push("DURATION:PT1H");
    }
  }
  if (t.ort) z.push(`LOCATION:${esc(t.ort)}`);
  if (t.beschreibung) z.push(`DESCRIPTION:${esc(t.beschreibung)}`);
  z.push("END:VEVENT");
  return z;
}

function aufgabeZuEvent(a: Aufgabe, jetzt: string, domain: string): string[] {
  const wer = a.zustaendig_name ? ` (${a.zustaendig_name})` : "";
  const beschreibung = [
    a.status === "in_arbeit" ? "Status: in Arbeit" : "Status: offen",
    a.zustaendig_name ? `Zuständig: ${a.zustaendig_name}` : "Noch niemand zuständig",
    a.beschreibung ?? "",
  ].filter(Boolean).join("\n");
  return [
    "BEGIN:VEVENT",
    `UID:aufgabe-${a.id}@${domain}`,
    `DTSTAMP:${jetzt}`,
    `LAST-MODIFIED:${utcStempel(a.updated_at)}`,
    `SUMMARY:${esc(`Frist: ${a.titel}${wer}`)}`,
    `DTSTART;VALUE=DATE:${tag(a.faellig)}`,
    `DTEND;VALUE=DATE:${tag(plusTage(a.faellig, 1))}`,
    `DESCRIPTION:${esc(beschreibung)}`,
    "CATEGORIES:Aufgabe",
    "TRANSP:TRANSPARENT",
    "END:VEVENT",
  ];
}

export function baueKalender(opts: {
  name: string;
  termine: Termin[];
  aufgaben: Aufgabe[];
  domain?: string;
  jetzt?: Date;
}): string {
  const domain = opts.domain ?? "vorstand-app";
  const jetzt = utcStempel(opts.jetzt ?? new Date());
  const zeilen = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Vorstands-App//DE",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(opts.name)}`,
    `X-WR-TIMEZONE:${TZID}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
    ...VTIMEZONE,
  ];
  for (const t of opts.termine) zeilen.push(...terminZuEvent(t, jetzt, domain));
  for (const a of opts.aufgaben) zeilen.push(...aufgabeZuEvent(a, jetzt, domain));
  zeilen.push("END:VCALENDAR");
  return zeilen.map(fold).join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------
//  Server
// ---------------------------------------------------------------------

/** Vergleich, der nicht verrät, wie viele Zeichen gestimmt haben */
function gleich(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function lies<T>(pfad: string): Promise<T> {
  const basis = Deno.env.get("SUPABASE_URL")!;
  // Standardmäßig von Supabase gesetzt. Falls nicht: Secret SERVICE_KEY anlegen.
  const schluessel = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_KEY")!;
  const headers: Record<string, string> = { apikey: schluessel };
  if (schluessel.startsWith("eyJ")) headers.Authorization = `Bearer ${schluessel}`; // alter JWT-Schlüssel
  const res = await fetch(`${basis}/rest/v1/${pfad}`, { headers });
  if (!res.ok) throw new Error(`${pfad}: ${res.status} ${await res.text()}`);
  return await res.json() as T;
}

async function antworte(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";

  const [abo] = await lies<{ token: string }[]>("kalender_abo?select=token&id=eq.1");
  if (!abo || !token || !gleich(token, abo.token)) {
    return new Response("Dieser Kalender-Link ist ungültig oder wurde erneuert.", {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  // Termine ab einem halben Jahr zurück
  const ab = new Date(Date.now() - 183 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const termine = await lies<Termin[]>(
    `termine?select=id,titel,datum,bis_datum,start_zeit,end_zeit,ort,beschreibung,updated_at` +
      `&or=(datum.gte.${ab},bis_datum.gte.${ab})&order=datum`,
  );

  let aufgaben: Aufgabe[] = [];
  if (url.searchParams.get("aufgaben") !== "0") {
    type Roh = Omit<Aufgabe, "zustaendig_name"> & { profiles: { name: string | null; email: string | null } | null };
    const roh = await lies<Roh[]>(
      `aufgaben?select=id,titel,beschreibung,faellig,status,updated_at,profiles!aufgaben_zustaendig_fkey(name,email)` +
        `&status=neq.erledigt&faellig=not.is.null&order=faellig`,
    );
    aufgaben = roh.map(({ profiles, ...a }) => ({
      ...a,
      zustaendig_name: profiles ? (profiles.name || profiles.email) : null,
    }));
  }

  const ics = baueKalender({
    name: Deno.env.get("KALENDER_NAME") ?? "Vorstand Grüne BK",
    termine,
    aufgaben,
    domain: new URL(Deno.env.get("SUPABASE_URL")!).hostname,
  });

  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="vorstand.ics"',
      "Cache-Control": "private, max-age=300",
    },
  });
}

// Nur in Supabase starten (beim lokalen Testen mit Node gibt es kein Deno)
// deno-lint-ignore no-explicit-any
const D = (globalThis as any).Deno;
if (D?.serve) {
  D.serve(async (req: Request) => {
    try {
      return await antworte(req);
    } catch (e) {
      console.error(e);
      return new Response("Fehler beim Erstellen des Kalenders.", { status: 500 });
    }
  });
}
