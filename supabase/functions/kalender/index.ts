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
  projekt_name?: string | null;
  unterpunkte?: { titel: string; erledigt: boolean; wer: string | null; faellig: string | null; zeit?: string | null }[];
};

export type Aufgabe = {
  id: string;
  titel: string;
  beschreibung: string | null;
  faellig: string;           // nur Aufgaben mit Datum
  status: string;
  zustaendig_name: string | null;
  updated_at: string;
  termin_titel?: string | null;
  projekt_name?: string | null;
  faellig_zeit?: string | null;
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
const kurz = (d: string) => { const [, m, t] = d.split("-"); return `${Number(t)}.${Number(m)}.`; };
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

function terminZuEvent(t: Termin, jetzt: string, domain: string, appUrl?: string): string[] {
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
  const link = appUrl ? `${appUrl}?termin=${t.id}` : null;
  const punkte = (t.unterpunkte ?? []).map((u) => {
    const frist = u.faellig ? `bis ${kurz(u.faellig)}${u.zeit ? ` ${u.zeit.slice(0, 5)} Uhr` : ""}` : null;
    const extra = [u.wer, frist].filter(Boolean).join(", ");
    return `${u.erledigt ? "☑" : "☐"} ${u.titel}${extra ? ` (${extra})` : ""}`;
  });
  const text = [
    t.beschreibung,
    t.projekt_name ? `Projekt: ${t.projekt_name}` : null,
    punkte.length ? `Unterpunkte:\n${punkte.join("\n")}` : null,
    link ? `Bearbeiten in der App: ${link}` : null,
  ].filter(Boolean).join("\n\n");
  if (text) z.push(`DESCRIPTION:${esc(text)}`);
  if (t.projekt_name) z.push(`CATEGORIES:${esc(t.projekt_name)}`);
  if (link) z.push(`URL:${link}`);
  z.push("END:VEVENT");
  return z;
}

function aufgabeZuEvent(a: Aufgabe, jetzt: string, domain: string, appUrl?: string): string[] {
  const wer = a.zustaendig_name ? ` (${a.zustaendig_name})` : "";
  const beschreibung = [
    a.status === "in_arbeit" ? "Status: in Arbeit" : "Status: offen",
    a.zustaendig_name ? `Zuständig: ${a.zustaendig_name}` : "Noch niemand zuständig",
    a.termin_titel ? `Für den Termin: ${a.termin_titel}` : "",
    a.projekt_name ? `Projekt: ${a.projekt_name}` : "",
    a.beschreibung ?? "",
    appUrl ? `\nBearbeiten in der App: ${appUrl}?aufgabe=${a.id}` : "",
  ].filter(Boolean).join("\n");
  return [
    "BEGIN:VEVENT",
    `UID:aufgabe-${a.id}@${domain}`,
    `DTSTAMP:${jetzt}`,
    `LAST-MODIFIED:${utcStempel(a.updated_at)}`,
    `SUMMARY:${esc(`Frist: ${a.titel}${wer}`)}`,
    // Mit Uhrzeit als kurzer Termin zu dieser Zeit, sonst ganztägig
    ...(a.faellig_zeit
      ? [`DTSTART;TZID=${TZID}:${tag(a.faellig)}T${uhr(a.faellig_zeit)}`, "DURATION:PT30M"]
      : [`DTSTART;VALUE=DATE:${tag(a.faellig)}`, `DTEND;VALUE=DATE:${tag(plusTage(a.faellig, 1))}`]),
    `DESCRIPTION:${esc(beschreibung)}`,
    ...(appUrl ? [`URL:${appUrl}?aufgabe=${a.id}`] : []),
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
  appUrl?: string;
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
  for (const t of opts.termine) zeilen.push(...terminZuEvent(t, jetzt, domain, opts.appUrl));
  for (const a of opts.aufgaben) zeilen.push(...aufgabeZuEvent(a, jetzt, domain, opts.appUrl));
  zeilen.push("END:VCALENDAR");
  return zeilen.map(fold).join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------
//  Server
// ---------------------------------------------------------------------

type Person = { id: string; name: string | null; email: string | null };

/** Wie in der App: nur der Vorname, bei Gleichheit mit Anfangsbuchstaben des Nachnamens */
export function anzeigeNamen(profile: Person[]): Map<string, string> {
  const teile = (p: Person) => (p.name || "").trim().split(/\s+/).filter(Boolean);
  const vor = (p: Person) => teile(p)[0] || (p.email || "").split("@")[0] || "?";
  const anzahl = new Map<string, number>();
  for (const p of profile) anzahl.set(vor(p).toLowerCase(), (anzahl.get(vor(p).toLowerCase()) ?? 0) + 1);
  const namen = new Map<string, string>();
  for (const p of profile) {
    const t = teile(p);
    namen.set(p.id, (anzahl.get(vor(p).toLowerCase()) ?? 0) > 1 && t.length > 1
      ? `${t[0]} ${t[t.length - 1][0].toUpperCase()}.`
      : vor(p));
  }
  return namen;
}

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
  type TerminRoh = Termin & { projekt_id: string | null };
  type AufgabeRoh = Omit<Aufgabe, "zustaendig_name"> & {
    termin_id: string | null;
    projekt_id: string | null;
    zustaendig: string | null;
  };
  const [termineRoh, aufgabenRoh, projekte, profile] = await Promise.all([
    lies<TerminRoh[]>(
      `termine?select=id,titel,datum,bis_datum,start_zeit,end_zeit,ort,beschreibung,updated_at,projekt_id` +
        `&or=(datum.gte.${ab},bis_datum.gte.${ab})&order=datum`,
    ),
    // offene Aufgaben + alle Unterpunkte (auch erledigte, für die Checkliste)
    lies<AufgabeRoh[]>(
      `aufgaben?select=id,titel,beschreibung,faellig,faellig_zeit,status,updated_at,created_at,termin_id,projekt_id,zustaendig` +
        `&or=(status.neq.erledigt,termin_id.not.is.null)&order=created_at`,
    ),
    lies<{ id: string; name: string }[]>("projekte?select=id,name"),
    lies<Person[]>("profiles?select=id,name,email"),
  ]);
  const namen = anzeigeNamen(profile);
  const projektName = new Map(projekte.map((p) => [p.id, p.name]));
  const terminById = new Map(termineRoh.map((t) => [t.id, t]));
  const werVon = (a: AufgabeRoh) => (a.zustaendig ? namen.get(a.zustaendig) ?? null : null);

  const termine: Termin[] = termineRoh.map((t) => ({
    ...t,
    projekt_name: t.projekt_id ? projektName.get(t.projekt_id) ?? null : null,
    unterpunkte: aufgabenRoh
      .filter((a) => a.termin_id === t.id)
      .map((a) => ({ titel: a.titel, erledigt: a.status === "erledigt", wer: werVon(a), faellig: a.faellig, zeit: a.faellig_zeit ?? null })),
  }));

  let aufgaben: Aufgabe[] = [];
  if (url.searchParams.get("aufgaben") !== "0") {
    aufgaben = aufgabenRoh
      .filter((a) => a.status !== "erledigt" && a.faellig)
      .map((a) => {
        const t = a.termin_id ? terminById.get(a.termin_id) : undefined;
        const pid = a.projekt_id ?? t?.projekt_id ?? null; // Unterpunkte erben das Projekt des Termins
        return {
          id: a.id,
          titel: a.titel,
          beschreibung: a.beschreibung,
          faellig: a.faellig as string,
          faellig_zeit: a.faellig_zeit ?? null,
          status: a.status,
          updated_at: a.updated_at,
          zustaendig_name: werVon(a),
          termin_titel: t?.titel ?? null,
          projekt_name: pid ? projektName.get(pid) ?? null : null,
        };
      });
  }

  const ics = baueKalender({
    name: Deno.env.get("KALENDER_NAME") ?? "Vorstand Grüne BK",
    termine,
    aufgaben,
    domain: new URL(Deno.env.get("SUPABASE_URL")!).hostname,
    // Adresse der Web-App, damit jeder Eintrag einen "Bearbeiten"-Link bekommt
    appUrl: Deno.env.get("APP_URL") ?? "https://nioet.github.io/vorstand/",
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
