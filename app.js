// Vorstands-App – Termine, Aufgaben, Unterpunkte & Projekte
// Läuft ohne Build-Schritt direkt im Browser (z. B. auf GitHub Pages).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cfg = window.VORSTAND_CONFIG || {};
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const TITEL = cfg.titel || "Vorstand";
document.title = TITEL;
$$(".app-titel").forEach((h) => (h.textContent = TITEL));

// ------------------------------------------------------------------
//  Kleine Helfer
// ------------------------------------------------------------------
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const pad = (n) => String(n).padStart(2, "0");
const isoTag = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const heute = () => isoTag(new Date());
const alsDatum = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const tageBis = (s) => Math.round((alsDatum(s) - alsDatum(heute())) / 86400000);
const uhr = (t) => (t ? t.slice(0, 5) : "");

const fmtWochentag = new Intl.DateTimeFormat("de-DE", { weekday: "short" });
const fmtMonat = new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric" });
const fmtLang = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "long" });
const fmtKurz = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short" });
const wochentag = (s) => fmtWochentag.format(alsDatum(s)).replace(".", "");
const langesDatum = (s) => fmtLang.format(alsDatum(s));
const kurzesDatum = (s) => fmtKurz.format(alsDatum(s));

const plusTage = (s, n) => { const d = alsDatum(s); d.setDate(d.getDate() + n); return isoTag(d); };
const tageZwischen = (von, bis) => {
  const [a, b] = [von, bis].map((x) => { const [y, m, d] = x.split("-").map(Number); return Date.UTC(y, m - 1, d); });
  return Math.round((b - a) / 86400000);
};
const plusJahr = (s) => { const d = alsDatum(s); d.setFullYear(d.getFullYear() + 1); return isoTag(d); };

const leer = (v) => { const x = (v ?? "").trim(); return x === "" ? null : x; };
const nachText = (feld) => (x, y) => String(x[feld] ?? "").localeCompare(String(y[feld] ?? ""), "de");

let meldungTimer;
function meldung(text, fehler = false) {
  const el = $("#meldung");
  el.textContent = text;
  el.classList.toggle("fehler-meldung", fehler);
  el.hidden = false;
  clearTimeout(meldungTimer);
  meldungTimer = setTimeout(() => (el.hidden = true), fehler ? 6000 : 3000);
}

// Dialog nach einem Fehler mit den eingegebenen Werten erneut zeigen
function wiederOeffnen(dialog) {
  dialog.returnValue = "";
  dialog.showModal();
}

function zeige(id) {
  for (const x of ["laden", "anmeldung", "app"]) $("#" + x).hidden = x !== id;
}

// ------------------------------------------------------------------
//  Verbindung zu Supabase
// ------------------------------------------------------------------
if (!cfg.supabaseUrl || cfg.supabaseUrl.includes("DEIN-PROJEKT")) {
  zeige("anmeldung");
  $("#form-email").hidden = true;
  const f = $("#anmelde-fehler");
  f.textContent = "Die App ist noch nicht eingerichtet: Bitte in config.js die Supabase-Adresse und den Schlüssel eintragen.";
  f.hidden = false;
  throw new Error("config.js nicht ausgefüllt");
}

const sb = createClient(cfg.supabaseUrl, cfg.supabaseKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    // "implicit", damit der Link aus der E-Mail auch in einem anderen
    // Browser funktioniert als dem, in dem der Code angefordert wurde.
    flowType: "implicit",
  },
});

const S = {
  userId: null,
  ich: null,
  profile: [],
  termine: [],
  aufgaben: [],
  projekte: [],
  aboToken: null,
  zeitraum: "kommend",
  filter: "alle",
  projektFilter: "",
  projektOffen: null,
  zeigeAbgeschlossene: false,
  sortieren: false,       // ↑/↓ auf dem Aufgabenboard und im Projekt
  listen: {},             // zuletzt angezeigte Reihenfolgen (für ↑/↓)
  seite: localStorage.getItem("vorstand-seite") || "termine",
  kanal: null,
};

const nameVon = (id) => {
  const p = S.profile.find((x) => x.id === id);
  return p ? p.name || p.email : null;
};
const terminVon = (id) => (id ? S.termine.find((t) => t.id === id) || null : null);
const projektVon = (id) => (id ? S.projekte.find((p) => p.id === id) || null : null);
// Unterpunkte erben das Projekt ihres Termins
const projektIdVonAufgabe = (a) => a.projekt_id || terminVon(a.termin_id)?.projekt_id || null;
// Reihenfolge: eigene Position (automatisch nach Datum, von Hand änderbar)
const nachPosition = (x, y) =>
  (x.position ?? Infinity) - (y.position ?? Infinity) || String(x.created_at).localeCompare(String(y.created_at));
const unterpunkteVon = (terminId) =>
  S.aufgaben.filter((a) => a.termin_id === terminId).sort(nachPosition);

// ------------------------------------------------------------------
//  Anmeldung per E-Mail-Code (kein Passwort)
// ------------------------------------------------------------------
const anmeldeFehler = (text) => {
  const f = $("#anmelde-fehler");
  f.textContent = text || "";
  f.hidden = !text;
};

function zeigeCodeSchritt(email) {
  $("#form-email").hidden = true;
  $("#form-code").hidden = false;
  $("#email-anzeige").textContent = email;
  $("#code").value = "";
  $("#code").focus();
}

function zeigeEmailSchritt() {
  localStorage.removeItem("vorstand-login-email");
  $("#form-code").hidden = true;
  $("#form-email").hidden = false;
  anmeldeFehler("");
}

function zeigeAnmeldung() {
  zeige("anmeldung");
  const gemerkt = localStorage.getItem("vorstand-login-email");
  if (gemerkt) zeigeCodeSchritt(gemerkt); else zeigeEmailSchritt();
}

$("#form-email").addEventListener("submit", async (e) => {
  e.preventDefault();
  anmeldeFehler("");
  const knopf = e.submitter; if (knopf) knopf.disabled = true;
  const email = $("#email").value.trim().toLowerCase();
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname },
  });
  if (knopf) knopf.disabled = false;
  if (error) {
    const m = error.message || "";
    if (/signup|not allowed|not found/i.test(m)) {
      anmeldeFehler("Diese E-Mail-Adresse ist nicht freigeschaltet. Bitte wende dich an die Person, die die App betreut.");
    } else if (/seconds|rate|security purposes/i.test(m)) {
      anmeldeFehler("Bitte warte eine Minute und versuche es dann noch einmal.");
    } else {
      anmeldeFehler("Das hat nicht geklappt: " + m);
    }
    return;
  }
  localStorage.setItem("vorstand-login-email", email);
  zeigeCodeSchritt(email);
});

$("#form-code").addEventListener("submit", async (e) => {
  e.preventDefault();
  anmeldeFehler("");
  const knopf = e.submitter; if (knopf) knopf.disabled = true;
  const email = localStorage.getItem("vorstand-login-email");
  const token = $("#code").value.replace(/\D/g, "");
  const { error } = await sb.auth.verifyOtp({ email, token, type: "email" });
  if (knopf) knopf.disabled = false;
  if (error) {
    anmeldeFehler("Der Code stimmt nicht oder ist abgelaufen. Prüfe die neueste E-Mail oder fordere einen neuen Code an.");
  }
});

$("#andere-email").addEventListener("click", zeigeEmailSchritt);

$("#abmelden").addEventListener("click", async () => {
  await sb.auth.signOut();
  localStorage.removeItem("vorstand-login-email");
});

sb.auth.onAuthStateChange((_event, session) => {
  // Laut Supabase keine weiteren Aufrufe direkt im Callback → kurz entkoppeln
  setTimeout(() => sitzungGeaendert(session), 0);
});

async function sitzungGeaendert(session) {
  if (!session) {
    S.userId = null;
    stoppeLive();
    zeigeAnmeldung();
    return;
  }
  if (S.userId === session.user.id) return;
  S.userId = session.user.id;
  localStorage.removeItem("vorstand-login-email");
  await starteApp();
}

// ------------------------------------------------------------------
//  Daten laden
// ------------------------------------------------------------------
async function ladeProfile() {
  const { data, error } = await sb.from("profiles").select("id,name,email,aktiv").order("name", { nullsFirst: false });
  if (error) throw error;
  S.profile = data;
  S.ich = data.find((p) => p.id === S.userId) || null;
}

async function ladeInhalte() {
  const [t, a, p] = await Promise.all([
    sb.from("termine").select("*").order("datum").order("start_zeit", { nullsFirst: true }),
    sb.from("aufgaben").select("*").order("position", { nullsFirst: false }).order("created_at"),
    sb.from("projekte").select("*").order("name"),
  ]);
  if (t.error) throw t.error;
  if (a.error) throw a.error;
  if (p.error) throw p.error;
  S.termine = t.data;
  S.aufgaben = a.data;
  S.projekte = p.data;
}

async function ladeAbo() {
  const { data } = await sb.from("kalender_abo").select("token").maybeSingle();
  S.aboToken = data?.token || null;
  zeichneAbo();
}

async function starteApp() {
  zeige("laden");
  try {
    await ladeProfile();
    if (!S.ich || !S.ich.aktiv) {
      zeige("anmeldung");
      zeigeEmailSchritt();
      anmeldeFehler("Dein Zugang ist nicht (mehr) freigeschaltet.");
      await sb.auth.signOut();
      return;
    }
    await Promise.all([ladeInhalte(), ladeAbo()]);
  } catch (err) {
    console.error(err);
    zeige("anmeldung");
    zeigeEmailSchritt();
    anmeldeFehler("Die Daten konnten nicht geladen werden. Bitte später noch einmal versuchen.");
    return;
  }
  zeige("app");
  zeichneAlles();
  wechsleSeite(S.seite);
  starteLive();
  if (!S.ich.name) {
    wechsleSeite("mehr");
    $("#mein-name").focus();
    meldung("Willkommen! Trag bitte zuerst deinen Namen ein.");
  }
  oeffneDirektlink();
}

// Link aus dem Handy-Kalender (…/?termin=ID oder …/?aufgabe=ID) öffnet den Eintrag
function oeffneDirektlink() {
  const q = new URLSearchParams(location.search);
  const tId = q.get("termin");
  const aId = q.get("aufgabe");
  if (!tId && !aId) return;
  history.replaceState(null, "", location.pathname);
  if (tId) {
    const t = terminVon(tId);
    wechsleSeite("termine");
    if (t) oeffneTermin(t); else meldung("Diesen Termin gibt es nicht mehr.", true);
  } else {
    const a = S.aufgaben.find((x) => x.id === aId);
    wechsleSeite("aufgaben");
    if (a) oeffneAufgabe(a); else meldung("Diese Aufgabe gibt es nicht mehr.", true);
  }
}

// Live: Änderungen der anderen erscheinen sofort
let nachladenTimer;
function nachladen() {
  clearTimeout(nachladenTimer);
  nachladenTimer = setTimeout(async () => {
    try { await ladeInhalte(); zeichneAlles(); } catch (e) { console.error(e); }
  }, 300);
}

async function neuLadenUndZeichnen() {
  try { await ladeInhalte(); } catch (e) { console.error(e); }
  zeichneAlles();
}

function starteLive() {
  stoppeLive();
  S.kanal = sb
    .channel("vorstand")
    .on("postgres_changes", { event: "*", schema: "public", table: "termine" }, nachladen)
    .on("postgres_changes", { event: "*", schema: "public", table: "aufgaben" }, nachladen)
    .on("postgres_changes", { event: "*", schema: "public", table: "projekte" }, nachladen)
    .subscribe();
}
function stoppeLive() {
  if (S.kanal) { sb.removeChannel(S.kanal); S.kanal = null; }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.userId && !$("#app").hidden) nachladen();
});

// ------------------------------------------------------------------
//  Navigation
// ------------------------------------------------------------------
const SEITEN = ["termine", "aufgaben", "projekte", "mehr"];

function wechsleSeite(seite) {
  if (!SEITEN.includes(seite)) seite = "termine";
  S.seite = seite;
  localStorage.setItem("vorstand-seite", seite);
  for (const s of SEITEN) $("#seite-" + s).hidden = s !== seite;
  $$(".leiste button").forEach((b) => b.classList.toggle("aktiv", b.dataset.seite === seite));
  window.scrollTo(0, 0);
}
$$(".leiste button").forEach((b) =>
  b.addEventListener("click", () => {
    // Nochmal auf "Projekte" tippen führt zurück zur Übersicht
    if (b.dataset.seite === "projekte" && S.seite === "projekte" && S.projektOffen) {
      S.projektOffen = null;
      zeichneProjekte();
    }
    wechsleSeite(b.dataset.seite);
  }),
);

$$("[data-zeitraum]").forEach((b) =>
  b.addEventListener("click", () => {
    S.zeitraum = b.dataset.zeitraum;
    $$("[data-zeitraum]").forEach((x) => x.classList.toggle("aktiv", x === b));
    zeichneTermine();
  }),
);
$$("[data-filter]").forEach((b) =>
  b.addEventListener("click", () => {
    S.filter = b.dataset.filter;
    $$("[data-filter]").forEach((x) => x.classList.toggle("aktiv", x === b));
    zeichneAufgaben();
  }),
);
$("#aufgaben-projekt").addEventListener("change", (e) => {
  S.projektFilter = e.target.value;
  zeichneAufgaben();
});
$("#zeige-abgeschlossene").addEventListener("change", (e) => {
  S.zeigeAbgeschlossene = e.target.checked;
  zeichneProjekte();
});

function zeichneAlles() {
  zeichneTermine();
  zeichneAufgaben();
  zeichneProjekte();
  zeichneMehr();
  if (dT.open) zeichneUnterpunkte();
}

// Alle Klicks im Inhalt an einer Stelle: Karten, Knöpfe, Aktionen
$(".inhalt").addEventListener("click", (e) => {
  const ziel = e.target;

  const duplT = ziel.closest("[data-dupl-termin]");
  if (duplT) return oeffneTerminDuplizieren(terminVon(duplT.dataset.duplTermin));
  const duplP = ziel.closest("[data-dupl-projekt]");
  if (duplP) return oeffneProjektDuplizieren(projektVon(duplP.dataset.duplProjekt));

  const tun = ziel.closest("[data-tun]");
  const karte = tun?.closest("[data-id]");
  if (tun && karte) {
    const a = S.aufgaben.find((x) => x.id === karte.dataset.id);
    if (a) aufgabenAktion(a, tun.dataset.tun, karte.dataset.liste);
    return;
  }

  const termin = ziel.closest("[data-termin]");
  if (termin) return oeffneTermin(terminVon(termin.dataset.termin));

  const frist = ziel.closest("[data-aufgabe]");
  if (frist) return oeffneAufgabe(S.aufgaben.find((x) => x.id === frist.dataset.aufgabe));

  const projekt = ziel.closest("[data-projekt]");
  if (projekt) {
    S.projektOffen = projekt.dataset.projekt;
    zeichneProjekte();
    window.scrollTo(0, 0);
    return;
  }

  const aktion = ziel.closest("[data-aktion]")?.dataset.aktion;
  const p = projektVon(S.projektOffen);
  switch (aktion) {
    case "neuer-termin": return oeffneTermin(null);
    case "neue-aufgabe": return oeffneAufgabe(null, { projekt_id: S.projektFilter || null });
    case "neues-projekt": return oeffneProjekt(null);
    case "projekte-zurueck": S.projektOffen = null; zeichneProjekte(); return window.scrollTo(0, 0);
    case "projekt-bearbeiten": return p && oeffneProjekt(p);
    case "projekt-termin": return p && oeffneTermin(null, { projekt_id: p.id });
    case "projekt-aufgabe": return p && oeffneAufgabe(null, { projekt_id: p.id });
    case "sortieren-umschalten":
      S.sortieren = !S.sortieren;
      zeichneAufgaben(); zeichneProjekte();
      if (S.sortieren) meldung("Mit ↑ und ↓ die Reihenfolge ändern.");
      return;
    case "nach-datum": return alleNachDatum();
  }
});

// ------------------------------------------------------------------
//  Bausteine für Karten
// ------------------------------------------------------------------
function zeitText(t) {
  if (t.bis_datum && t.bis_datum !== t.datum) {
    const von = t.start_zeit ? `ab ${uhr(t.start_zeit)} Uhr, ` : "";
    return `${von}bis ${langesDatum(t.bis_datum)}${t.end_zeit ? `, ${uhr(t.end_zeit)} Uhr` : ""}`;
  }
  if (!t.start_zeit) return "ganztägig";
  return t.end_zeit ? `${uhr(t.start_zeit)}–${uhr(t.end_zeit)} Uhr` : `${uhr(t.start_zeit)} Uhr`;
}

function relMarke(datum) {
  const n = tageBis(datum);
  if (n === 0) return '<span class="marke">Heute</span>';
  if (n === 1) return '<span class="marke">Morgen</span>';
  return "";
}

const datumBlock = (d) =>
  `<span class="datum-block"><span class="wt">${esc(wochentag(d))}</span><span class="tg">${alsDatum(d).getDate()}</span></span>`;

function projektEtikett(projektId) {
  const p = projektVon(projektId);
  return p ? `<span class="etikett">📁 ${esc(p.name)}</span>` : "";
}

function terminKarte(t, { mitMarke = true, mitProjekt = true } = {}) {
  const h = heute();
  const laeuft = t.datum <= h && (t.bis_datum || t.datum) >= h;
  const punkte = unterpunkteVon(t.id);
  const fertig = punkte.filter((a) => a.status === "erledigt").length;
  const etiketten = [
    punkte.length ? `<span class="etikett${fertig === punkte.length ? " fertig" : ""}">☑ ${fertig} von ${punkte.length} erledigt</span>` : "",
    mitProjekt ? projektEtikett(t.projekt_id) : "",
  ].join("");
  return `<div class="karte-zeile"><button class="termin${laeuft ? " heute" : ""}" data-termin="${t.id}">${datumBlock(t.datum)}
    <span class="termin-text">
      <strong>${esc(t.titel)}${mitMarke ? relMarke(t.datum) : ""}</strong>
      <span class="zeit">${esc(zeitText(t))}</span>
      ${t.ort ? `<span class="ort"><br>📍 ${esc(t.ort)}</span>` : ""}
      ${t.beschreibung ? `<span class="notiz"><br>${esc(t.beschreibung.length > 140 ? t.beschreibung.slice(0, 140) + " …" : t.beschreibung)}</span>` : ""}
      ${etiketten ? `<span class="etiketten">${etiketten}</span>` : ""}
    </span></button>
    <button class="dupl-knopf" data-dupl-termin="${t.id}" aria-label="Termin „${esc(t.titel)}“ duplizieren" title="Duplizieren">＋</button></div>`;
}

function fristText(a) {
  if (!a.faellig) return "";
  if (a.status === "erledigt") return `📅 war bis ${esc(langesDatum(a.faellig))}`;
  const n = tageBis(a.faellig);
  if (n < 0) return `<span class="ueberfaellig">⚠️ überfällig seit ${-n === 1 ? "gestern" : `${-n} Tagen`}</span>`;
  if (n === 0) return `<span class="bald">📅 heute fällig</span>`;
  if (n === 1) return `<span class="bald">📅 morgen fällig</span>`;
  return `📅 bis ${esc(langesDatum(a.faellig))}`;
}

function aufgabeHtml(a, { mitProjekt = true, liste = null } = {}) {
  const wer = nameVon(a.zustaendig);
  const istMeine = a.zustaendig === S.userId;
  const sortierbar = S.sortieren && liste && a.status !== "erledigt";
  let knoepfe = "";
  if (sortierbar) {
    const ids = S.listen[liste] || [];
    const i = ids.indexOf(a.id);
    knoepfe = `<button class="knopf klein pfeil" data-tun="hoch" aria-label="Nach oben" ${i <= 0 ? "disabled" : ""}>↑ Hoch</button>
               <button class="knopf klein pfeil" data-tun="runter" aria-label="Nach unten" ${i === ids.length - 1 ? "disabled" : ""}>↓ Runter</button>`;
  } else if (a.status === "offen") {
    knoepfe = !a.zustaendig
      ? `<button class="knopf klein" data-tun="nehmen">🙋 Mach ich</button>`
      : `<button class="knopf klein" data-tun="anfangen">▶ Anfangen</button>`;
    knoepfe += `<button class="knopf klein haupt" data-tun="erledigt">✓ Erledigt</button>`;
  } else if (a.status === "in_arbeit") {
    knoepfe = `<button class="knopf klein" data-tun="zurueck">↩ Zurück</button>
               <button class="knopf klein haupt" data-tun="erledigt">✓ Erledigt</button>`;
  } else {
    knoepfe = `<button class="knopf klein" data-tun="oeffnen">↩ Wieder öffnen</button>`;
  }
  const frist = fristText(a);
  const t = terminVon(a.termin_id);
  const etiketten = [
    t ? `<span class="etikett termin-etikett">📅 ${esc(t.titel)} · ${esc(kurzesDatum(t.datum))}</span>` : "",
    mitProjekt ? projektEtikett(projektIdVonAufgabe(a)) : "",
  ].join("");
  return `<article class="aufgabe${a.status === "erledigt" ? " ist-erledigt" : ""}" data-id="${a.id}"${liste ? ` data-liste="${liste}"` : ""}>
    ${sortierbar ? "" : `<button class="dupl-knopf" data-tun="duplizieren" aria-label="„${esc(a.titel)}“ duplizieren" title="Duplizieren">＋</button>`}
    <button class="titel-knopf" data-tun="bearbeiten">${esc(a.titel)}</button>
    <div class="meta">👤 ${esc(wer ? (istMeine ? `${wer} (ich)` : wer) : "noch niemand")}${frist ? " · " + frist : ""}</div>
    ${etiketten ? `<div class="etiketten">${etiketten}</div>` : ""}
    <div class="knoepfe">${knoepfe}</div>
  </article>`;
}

const nachFrist = (x, y) =>
  (x.faellig || "9999") < (y.faellig || "9999") ? -1 :
  (x.faellig || "9999") > (y.faellig || "9999") ? 1 :
  x.created_at < y.created_at ? -1 : 1;

// ------------------------------------------------------------------
//  Termine
// ------------------------------------------------------------------
function zeichneTermine() {
  const h = heute();
  const kommend = S.zeitraum === "kommend";
  const eintraege = S.termine
    .filter((t) => (kommend ? (t.bis_datum || t.datum) >= h : (t.bis_datum || t.datum) < h))
    .map((t) => ({ art: "termin", datum: t.datum, sort: t.datum + (t.start_zeit || "00:00"), t }));

  if (kommend) {
    // Fristen von Aufgaben (ohne Unterpunkte – die stehen beim Termin)
    eintraege.push(
      ...S.aufgaben
        .filter((a) => a.faellig && a.status !== "erledigt" && a.faellig >= h && !a.termin_id)
        .map((a) => ({ art: "frist", datum: a.faellig, sort: a.faellig + "23:59", a })),
    );
  }
  eintraege.sort((x, y) => (x.sort < y.sort ? -1 : x.sort > y.sort ? 1 : 0));
  if (!kommend) eintraege.reverse();

  const ziel = $("#termin-liste");
  if (!eintraege.length) {
    ziel.innerHTML = `<p class="leer">${kommend ? "Keine kommenden Termine." : "Noch keine vergangenen Termine."}</p>`;
    return;
  }

  let html = "";
  let monat = "";
  for (const e of eintraege) {
    const m = fmtMonat.format(alsDatum(e.datum));
    if (m !== monat) { html += `<h2 class="monat">${esc(m)}</h2>`; monat = m; }
    if (e.art === "termin") {
      html += terminKarte(e.t, { mitMarke: kommend });
    } else {
      const a = e.a;
      const wer = nameVon(a.zustaendig);
      const proj = projektEtikett(projektIdVonAufgabe(a));
      html += `<button class="termin frist" data-aufgabe="${a.id}">${datumBlock(a.faellig)}
        <span class="termin-text">
          <strong>Frist: ${esc(a.titel)}${relMarke(a.faellig)}</strong>
          <span class="ort">👤 ${esc(wer || "noch niemand zuständig")}</span>
          ${proj ? `<span class="etiketten">${proj}</span>` : ""}
        </span></button>`;
    }
  }
  ziel.innerHTML = html;
}

// --- Termin-Dialog ---
const dT = $("#dialog-termin");
let bearbeiteterTermin = null;
let entwurfPunkte = []; // Unterpunkte eines noch nicht gespeicherten Termins
let punkteSortieren = false;

function projektOptionen(select, gewaehlt) {
  const liste = S.projekte.filter((p) => !p.abgeschlossen || p.id === gewaehlt).sort(nachText("name"));
  select.innerHTML =
    `<option value="">— kein Projekt —</option>` +
    liste.map((p) => `<option value="${p.id}">${esc(p.name)}${p.abgeschlossen ? " (abgeschlossen)" : ""}</option>`).join("");
  select.value = gewaehlt || "";
}

function ganztagsUmschalten() {
  const ganz = $("#t-ganztags").checked;
  $(".zeiten").hidden = ganz;
  if (ganz) { $("#t-start").value = ""; $("#t-ende").value = ""; }
}
$("#t-ganztags").addEventListener("change", ganztagsUmschalten);

$("#t-start").addEventListener("change", () => {
  const s = $("#t-start").value;
  if (s && !$("#t-ende").value) {
    const [hh, mm] = s.split(":").map(Number);
    if (hh + 2 < 24) $("#t-ende").value = `${pad(hh + 2)}:${pad(mm)}`;
  }
});

function oeffneTermin(t = null, vorgabe = {}) {
  bearbeiteterTermin = t;
  entwurfPunkte = [];
  punkteSortieren = false;
  $("#termin-ueberschrift").textContent = t ? "Termin bearbeiten" : "Neuer Termin";
  $("#t-titel").value = t?.titel || "";
  $("#t-datum").value = t?.datum || heute();
  $("#t-ganztags").checked = t ? !t.start_zeit : false;
  $("#t-start").value = uhr(t?.start_zeit);
  $("#t-ende").value = uhr(t?.end_zeit);
  $("#t-bis").value = t?.bis_datum || "";
  $("#t-mehrtaegig").open = !!t?.bis_datum;
  $("#t-ort").value = t?.ort || "";
  $("#t-notiz").value = t?.beschreibung || "";
  projektOptionen($("#t-projekt"), t ? t.projekt_id : vorgabe.projekt_id);
  $("#t-neuer-punkt").value = "";
  $("#t-loeschen").hidden = !t;
  ganztagsUmschalten();
  zeichneUnterpunkte();
  dT.returnValue = "";
  dT.showModal();
  if (!t) $("#t-titel").focus();
}

function zeichneUnterpunkte() {
  const liste = $("#t-unterpunkte");
  if (!bearbeiteterTermin) {
    $("#t-sortier-leiste").hidden = true;
    liste.innerHTML = entwurfPunkte
      .map((titel, i) => `<li class="punkt"><span class="punkt-text"><span class="punkt-titel">${esc(titel)}</span></span>
        <button type="button" class="punkt-weg" data-entwurf-weg="${i}" aria-label="Entfernen">✕</button></li>`)
      .join("");
    $("#t-punkte-hinweis").textContent = entwurfPunkte.length
      ? "Wer sich kümmert und bis wann: nach dem Speichern auf den Unterpunkt tippen."
      : "";
    return;
  }
  const punkte = unterpunkteVon(bearbeiteterTermin.id);
  liste.innerHTML = punkte
    .map((a, i) => {
      const wer = nameVon(a.zustaendig);
      const meta = [wer ? `👤 ${esc(wer)}` : "👤 noch niemand", a.faellig ? fristText(a) : ""].filter(Boolean).join(" · ");
      const pfeile = punkteSortieren
        ? `<button type="button" class="punkt-pfeil" data-punkt-hoch="${a.id}" aria-label="Nach oben" ${i === 0 ? "disabled" : ""}>↑</button>
           <button type="button" class="punkt-pfeil" data-punkt-runter="${a.id}" aria-label="Nach unten" ${i === punkte.length - 1 ? "disabled" : ""}>↓</button>`
        : "";
      return `<li class="punkt${a.status === "erledigt" ? " erledigt" : ""}">
        <input type="checkbox" data-punkt-haken="${a.id}" ${a.status === "erledigt" ? "checked" : ""} aria-label="${esc(a.titel)} erledigt">
        <button type="button" class="punkt-text" data-punkt-bearbeiten="${a.id}">
          <span class="punkt-titel">${esc(a.titel)}</span><span class="punkt-meta">${meta}</span>
        </button>${pfeile}</li>`;
    })
    .join("");
  $("#t-sortier-leiste").hidden = punkte.length < 2;
  $("#t-sortieren").textContent = punkteSortieren ? "✓ Fertig sortiert" : "↕ Reihenfolge ändern";
  $("#t-sortieren").classList.toggle("aktiv", punkteSortieren);
  $("#t-nach-datum").hidden = !punkteSortieren;
  $("#t-punkte-hinweis").textContent = punkte.length
    ? "Tippe auf einen Unterpunkt, um festzulegen, wer ihn bis wann erledigt."
    : "Noch keine Unterpunkte.";
}

async function punktHinzufuegen() {
  const feld = $("#t-neuer-punkt");
  const titel = feld.value.trim();
  if (!titel) return feld.focus();
  feld.value = "";
  if (!bearbeiteterTermin) {
    entwurfPunkte.push(titel);
    zeichneUnterpunkte();
    return feld.focus();
  }
  const { error } = await sb.from("aufgaben").insert({ titel, termin_id: bearbeiteterTermin.id });
  if (error) { feld.value = titel; return meldung("Hinzufügen hat nicht geklappt.", true); }
  await neuLadenUndZeichnen();
  feld.focus();
}
$("#t-punkt-dazu").addEventListener("click", punktHinzufuegen);
// Enter im Feld fügt hinzu, statt den ganzen Termin zu speichern
$("#t-neuer-punkt").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); punktHinzufuegen(); }
});

$("#t-unterpunkte").addEventListener("click", (e) => {
  const weg = e.target.closest("[data-entwurf-weg]");
  if (weg) { entwurfPunkte.splice(Number(weg.dataset.entwurfWeg), 1); return zeichneUnterpunkte(); }
  const bearb = e.target.closest("[data-punkt-bearbeiten]");
  if (bearb) return oeffneAufgabe(S.aufgaben.find((a) => a.id === bearb.dataset.punktBearbeiten));
  const pfeil = e.target.closest("[data-punkt-hoch], [data-punkt-runter]");
  if (pfeil && bearbeiteterTermin) {
    const richtung = pfeil.dataset.punktHoch ? "hoch" : "runter";
    const a = S.aufgaben.find((x) => x.id === (pfeil.dataset.punktHoch || pfeil.dataset.punktRunter));
    if (a) verschiebe(a, richtung, unterpunkteVon(bearbeiteterTermin.id).map((x) => x.id));
  }
});
$("#t-sortieren").addEventListener("click", () => {
  punkteSortieren = !punkteSortieren;
  zeichneUnterpunkte();
});
$("#t-nach-datum").addEventListener("click", async () => {
  if (!bearbeiteterTermin) return;
  const { error } = await sb.rpc("aufgaben_nach_datum", { nur_termin: bearbeiteterTermin.id });
  if (error) return meldung("Das hat nicht geklappt.", true);
  meldung("Unterpunkte nach Datum sortiert.");
  await neuLadenUndZeichnen();
});
$("#t-unterpunkte").addEventListener("change", async (e) => {
  const haken = e.target.closest("[data-punkt-haken]");
  if (!haken) return;
  const a = S.aufgaben.find((x) => x.id === haken.dataset.punktHaken);
  if (a) await aendereAufgabe(a, { status: haken.checked ? "erledigt" : "offen" });
});

dT.addEventListener("close", async () => {
  if (dT.returnValue !== "speichern") return;
  const datum = $("#t-datum").value;
  let bis = $("#t-bis").value || null;
  const start = $("#t-ganztags").checked ? null : $("#t-start").value || null;
  const ende = start ? $("#t-ende").value || null : null;
  if (bis && bis < datum) { meldung("Der letzte Tag liegt vor dem ersten Tag.", true); return wiederOeffnen(dT); }
  if (bis === datum) bis = null;

  const daten = {
    titel: $("#t-titel").value.trim(),
    datum,
    bis_datum: bis,
    start_zeit: start,
    end_zeit: ende,
    ort: leer($("#t-ort").value),
    beschreibung: leer($("#t-notiz").value),
    projekt_id: $("#t-projekt").value || null,
  };
  // Noch nicht hinzugefügter Text im Unterpunkt-Feld soll nicht verloren gehen
  const offen = $("#t-neuer-punkt").value.trim();
  if (offen && !bearbeiteterTermin) entwurfPunkte.push(offen);

  let fehler;
  if (bearbeiteterTermin) {
    ({ error: fehler } = await sb.from("termine").update(daten).eq("id", bearbeiteterTermin.id));
    if (!fehler && offen) await sb.from("aufgaben").insert({ titel: offen, termin_id: bearbeiteterTermin.id });
  } else {
    const { data, error } = await sb.from("termine").insert(daten).select("id").single();
    fehler = error;
    if (!error && entwurfPunkte.length) {
      const { error: e2 } = await sb.from("aufgaben").insert(entwurfPunkte.map((titel) => ({ titel, termin_id: data.id })));
      if (e2) meldung("Termin gespeichert, aber die Unterpunkte nicht.", true);
    }
  }
  if (fehler) { console.error(fehler); meldung("Speichern hat nicht geklappt. Bitte noch einmal versuchen.", true); return wiederOeffnen(dT); }
  meldung(bearbeiteterTermin ? "Termin gespeichert." : "Termin eingetragen.");
  entwurfPunkte = [];
  await neuLadenUndZeichnen();
});

$("#t-loeschen").addEventListener("click", async () => {
  const t = bearbeiteterTermin;
  if (!t) return;
  const n = unterpunkteVon(t.id).length;
  const frage = n
    ? `Den Termin „${t.titel}“ und seine ${n} Unterpunkte wirklich löschen?`
    : `Den Termin „${t.titel}“ wirklich löschen?`;
  if (!confirm(frage)) return;
  const { error } = await sb.from("termine").delete().eq("id", t.id);
  if (error) return meldung("Löschen hat nicht geklappt.", true);
  dT.close();
  meldung("Termin gelöscht.");
  await neuLadenUndZeichnen();
});

// ------------------------------------------------------------------
//  Aufgaben
// ------------------------------------------------------------------
const SPALTEN = [
  { status: "offen", titel: "Offen" },
  { status: "in_arbeit", titel: "In Arbeit" },
  { status: "erledigt", titel: "Erledigt" },
];

function zeichneAufgaben() {
  // Projekt-Auswahl aktuell halten
  const auswahl = $("#aufgaben-projekt");
  const aktive = S.projekte.filter((p) => !p.abgeschlossen || p.id === S.projektFilter).sort(nachText("name"));
  if (S.projektFilter && !projektVon(S.projektFilter)) S.projektFilter = "";
  auswahl.innerHTML =
    `<option value="">Alle Projekte</option>` +
    aktive.map((p) => `<option value="${p.id}">📁 ${esc(p.name)}</option>`).join("");
  auswahl.value = S.projektFilter;
  auswahl.hidden = !S.projekte.length;

  let liste = S.aufgaben;
  if (S.filter === "meine") liste = liste.filter((a) => a.zustaendig === S.userId);
  if (S.filter === "niemand") liste = liste.filter((a) => !a.zustaendig);
  if (S.projektFilter) liste = liste.filter((a) => projektIdVonAufgabe(a) === S.projektFilter);

  let html = "";
  for (const sp of SPALTEN) {
    let teil = liste.filter((a) => a.status === sp.status);
    teil = sp.status === "erledigt"
      ? teil.sort((x, y) => ((x.erledigt_am || "") < (y.erledigt_am || "") ? 1 : -1))
      : teil.sort(nachPosition);
    const key = "board-" + sp.status;
    S.listen[key] = teil.map((a) => a.id);
    const karten = teil.map((a) => aufgabeHtml(a, { mitProjekt: !S.projektFilter, liste: key })).join("") || `<p class="leer">Nichts hier.</p>`;
    html += `<section class="spalte"><h2>${sp.titel} <span class="anzahl">${teil.length}</span></h2>
      ${sp.status === "erledigt" && teil.length ? `<details><summary>Anzeigen</summary>${karten}</details>` : karten}
    </section>`;
  }
  $("#aufgaben-board").innerHTML = html;
  sortierKnoepfeAktualisieren();
}

function sortierKnoepfeAktualisieren() {
  $$('[data-aktion="sortieren-umschalten"]').forEach((b) => {
    b.textContent = S.sortieren ? "✓ Fertig sortiert" : "↕ Reihenfolge ändern";
    b.classList.toggle("aktiv", S.sortieren);
  });
  $$('[data-aktion="nach-datum"]').forEach((b) => (b.hidden = !S.sortieren));
}

async function aendereAufgabe(a, aenderung, text) {
  const vorher = { ...a };
  Object.assign(a, aenderung);            // sofort anzeigen …
  zeichneAlles();
  const { error } = await sb.from("aufgaben").update(aenderung).eq("id", a.id);
  if (error) {                            // … und bei Fehler zurücknehmen
    Object.assign(a, vorher);
    zeichneAlles();
    return meldung("Das hat nicht geklappt. Bitte noch einmal versuchen.", true);
  }
  if (text) meldung(text);
}

function aufgabenAktion(a, tun, liste) {
  switch (tun) {
    case "hoch":
    case "runter": return verschiebe(a, tun, S.listen[liste] || []);
    case "bearbeiten": return oeffneAufgabe(a);
    case "nehmen": return aendereAufgabe(a, { zustaendig: S.userId, status: "in_arbeit" }, "Danke, die Aufgabe gehört jetzt dir.");
    case "anfangen": return aendereAufgabe(a, { status: "in_arbeit" });
    case "zurueck": return aendereAufgabe(a, { status: "offen" });
    case "erledigt": return aendereAufgabe(a, { status: "erledigt" }, "Erledigt – super! 🎉");
    case "oeffnen": return aendereAufgabe(a, { status: "offen" });
    case "duplizieren": return dupliziereAufgabe(a);
  }
}

// --- Reihenfolge von Hand ---
async function verschiebe(a, richtung, ids) {
  const i = ids.indexOf(a.id);
  const schritt = richtung === "hoch" ? -1 : 1;
  const nachbar = S.aufgaben.find((x) => x.id === ids[i + schritt]);
  if (i < 0 || !nachbar) return;
  const dahinter = S.aufgaben.find((x) => x.id === ids[i + 2 * schritt]);
  const neu = dahinter ? (nachbar.position + dahinter.position) / 2 : nachbar.position + schritt * 1000;
  await aendereAufgabe(a, { position: neu });
  // Fokus auf demselben Knopf lassen, damit man mehrmals tippen kann
  const knopf = $(`[data-id="${a.id}"] [data-tun="${richtung}"]`) || $(`[data-punkt-${richtung}="${a.id}"]`);
  if (knopf && !knopf.disabled) knopf.focus();
}

async function alleNachDatum() {
  if (!confirm("Eigene Reihenfolge verwerfen und alle Aufgaben wieder nach Datum sortieren?")) return;
  const { error } = await sb.rpc("aufgaben_nach_datum", {});
  if (error) return meldung("Das hat nicht geklappt.", true);
  meldung("Nach Datum sortiert.");
  await neuLadenUndZeichnen();
}

// --- Aufgaben-Dialog ---
const dA = $("#dialog-aufgabe");
let bearbeiteteAufgabe = null;

function personenAuswahl(gewaehlt) {
  const aktive = S.profile.filter((p) => p.aktiv);
  $("#a-wer").innerHTML =
    `<option value="">— noch niemand —</option>` +
    aktive.map((p) => `<option value="${p.id}">${esc(p.name || p.email)}${p.id === S.userId ? " (ich)" : ""}</option>`).join("");
  $("#a-wer").value = gewaehlt || "";
}

function terminAuswahl(gewaehlt) {
  // Kommende Termine und die der letzten 30 Tage, dazu der aktuell gewählte
  const grenze = isoTag(new Date(Date.now() - 30 * 86400000));
  const liste = S.termine.filter((t) => (t.bis_datum || t.datum) >= grenze || t.id === gewaehlt);
  $("#a-termin").innerHTML =
    `<option value="">— keinem Termin —</option>` +
    liste.map((t) => `<option value="${t.id}">${esc(kurzesDatum(t.datum))} – ${esc(t.titel)}</option>`).join("");
  $("#a-termin").value = gewaehlt || "";
}

function projektHinweisAktualisieren() {
  const mitTermin = !!$("#a-termin").value;
  const t = terminVon($("#a-termin").value);
  $("#a-projekt-hinweis").hidden = !(mitTermin && t?.projekt_id);
}
$("#a-termin").addEventListener("change", projektHinweisAktualisieren);

function oeffneAufgabe(a = null, vorgabe = {}) {
  bearbeiteteAufgabe = a;
  $("#aufgabe-ueberschrift").textContent = a ? (a.termin_id ? "Unterpunkt bearbeiten" : "Aufgabe bearbeiten") : "Neue Aufgabe";
  $("#a-titel").value = a?.titel || "";
  personenAuswahl(a?.zustaendig);
  $("#a-faellig").value = a?.faellig || "";
  $("#a-status").value = a?.status || "offen";
  $("#a-notiz").value = a?.beschreibung || "";
  terminAuswahl(a ? a.termin_id : vorgabe.termin_id);
  projektOptionen($("#a-projekt"), a ? a.projekt_id : vorgabe.projekt_id);
  projektHinweisAktualisieren();
  $("#a-loeschen").hidden = !a;
  dA.returnValue = "";
  dA.showModal();
  if (!a) $("#a-titel").focus();
}

dA.addEventListener("close", async () => {
  if (dA.returnValue !== "speichern") return;
  const daten = {
    titel: $("#a-titel").value.trim(),
    zustaendig: $("#a-wer").value || null,
    faellig: $("#a-faellig").value || null,
    status: $("#a-status").value,
    beschreibung: leer($("#a-notiz").value),
    termin_id: $("#a-termin").value || null,
    projekt_id: $("#a-projekt").value || null,
  };
  const anfrage = bearbeiteteAufgabe
    ? sb.from("aufgaben").update(daten).eq("id", bearbeiteteAufgabe.id)
    : sb.from("aufgaben").insert(daten);
  const { error } = await anfrage;
  if (error) { console.error(error); meldung("Speichern hat nicht geklappt. Bitte noch einmal versuchen.", true); return wiederOeffnen(dA); }
  meldung(bearbeiteteAufgabe ? "Gespeichert." : "Aufgabe angelegt.");
  await neuLadenUndZeichnen();
});

$("#a-loeschen").addEventListener("click", async () => {
  const a = bearbeiteteAufgabe;
  if (!a || !confirm(`„${a.titel}“ wirklich löschen?`)) return;
  const { error } = await sb.from("aufgaben").delete().eq("id", a.id);
  if (error) return meldung("Löschen hat nicht geklappt.", true);
  dA.close();
  meldung("Gelöscht.");
  await neuLadenUndZeichnen();
});

// ------------------------------------------------------------------
//  Projekte
// ------------------------------------------------------------------
function projektZahlen(p) {
  const h = heute();
  const aufgaben = S.aufgaben.filter((a) => projektIdVonAufgabe(a) === p.id);
  const erledigt = aufgaben.filter((a) => a.status === "erledigt").length;
  const termine = S.termine.filter((t) => t.projekt_id === p.id);
  const naechster = termine.filter((t) => (t.bis_datum || t.datum) >= h).sort(nachText("datum"))[0] || null;
  return { aufgaben, erledigt, offen: aufgaben.length - erledigt, termine, naechster };
}

const balken = (anteil) => `<span class="fortschritt" aria-hidden="true"><span style="width:${Math.round(anteil * 100)}%"></span></span>`;

function zeichneProjekte() {
  const detail = $("#projekt-detail");
  const uebersicht = $("#projekte-uebersicht");
  const p = projektVon(S.projektOffen);
  if (S.projektOffen && !p) S.projektOffen = null;

  if (!p) {
    detail.hidden = true;
    uebersicht.hidden = false;
    const liste = S.projekte
      .filter((x) => S.zeigeAbgeschlossene || !x.abgeschlossen)
      .sort((x, y) => (x.abgeschlossen === y.abgeschlossen ? nachText("name")(x, y) : x.abgeschlossen ? 1 : -1));
    $("#projekte-liste").innerHTML = liste.length
      ? liste.map((x) => {
          const z = projektZahlen(x);
          const meta = [
            z.aufgaben.length ? `✅ ${z.offen} offen` : "noch keine Aufgaben",
            z.naechster ? `📅 nächster Termin: ${esc(langesDatum(z.naechster.datum))}` : "",
            x.abgeschlossen ? "✔ abgeschlossen" : "",
          ].filter(Boolean).join(" · ");
          return `<div class="karte-zeile"><button class="projekt-karte${x.abgeschlossen ? " ist-abgeschlossen" : ""}" data-projekt="${x.id}">
            <strong>📁 ${esc(x.name)}</strong>
            ${x.beschreibung ? `<span class="beschreibung">${esc(x.beschreibung.length > 120 ? x.beschreibung.slice(0, 120) + " …" : x.beschreibung)}</span>` : ""}
            ${z.aufgaben.length ? balken(z.erledigt / z.aufgaben.length) : ""}
            <span class="meta">${meta}</span>
          </button>
          <button class="dupl-knopf" data-dupl-projekt="${x.id}" aria-label="Projekt „${esc(x.name)}“ duplizieren" title="Duplizieren">＋</button></div>`;
        }).join("")
      : `<p class="leer">${S.projekte.length ? "Keine offenen Projekte." : "Noch keine Projekte. Ein Projekt sammelt Termine und Aufgaben, z. B. „Neujahrsempfang“ oder „Wahlkampf“."}</p>`;
    $("#zeige-abgeschlossene").checked = S.zeigeAbgeschlossene;
    $("#zeige-abgeschlossene").parentElement.hidden = !S.projekte.some((x) => x.abgeschlossen);
    return;
  }

  uebersicht.hidden = true;
  detail.hidden = false;
  const z = projektZahlen(p);
  const h = heute();
  const kommende = z.termine.filter((t) => (t.bis_datum || t.datum) >= h).sort(nachText("datum"));
  const vergangene = z.termine.filter((t) => (t.bis_datum || t.datum) < h).sort(nachText("datum")).reverse();
  const offen = z.aufgaben.filter((a) => a.status !== "erledigt").sort(nachPosition);
  S.listen["projekt-offen"] = offen.map((a) => a.id);
  const fertig = z.aufgaben.filter((a) => a.status === "erledigt");

  detail.innerHTML = `
    <button class="knopf leise" data-aktion="projekte-zurueck">← Alle Projekte</button>
    <div class="karte projekt-kopf karte-zeile">
      <button class="dupl-knopf" data-dupl-projekt="${p.id}" aria-label="Projekt duplizieren" title="Duplizieren">＋</button>
      <h2 style="padding-right:3.2rem">📁 ${esc(p.name)}${p.abgeschlossen ? ' <span class="marke">abgeschlossen</span>' : ""}</h2>
      ${p.beschreibung ? `<p>${esc(p.beschreibung)}</p>` : ""}
      ${z.aufgaben.length ? `${balken(z.erledigt / z.aufgaben.length)}<p class="klein">${z.erledigt} von ${z.aufgaben.length} Aufgaben erledigt</p>` : ""}
      <button class="knopf breit" data-aktion="projekt-bearbeiten">Projekt bearbeiten</button>
    </div>

    <section class="projekt-detail-abschnitt">
      <h2>Termine</h2>
      <button class="knopf haupt breit" data-aktion="projekt-termin">＋ Termin für dieses Projekt</button>
      <div style="margin-top:.8rem">
        ${kommende.map((t) => terminKarte(t, { mitProjekt: false })).join("") || `<p class="leer">Keine kommenden Termine.</p>`}
      </div>
      ${vergangene.length ? `<details class="einklappen"><summary>Vergangene Termine (${vergangene.length})</summary>
        ${vergangene.map((t) => terminKarte(t, { mitMarke: false, mitProjekt: false })).join("")}</details>` : ""}
    </section>

    <section class="projekt-detail-abschnitt">
      <h2>Aufgaben</h2>
      <button class="knopf haupt breit" data-aktion="projekt-aufgabe">＋ Aufgabe für dieses Projekt</button>
      ${offen.length > 1 ? `<div class="sortier-leiste" style="margin-top:.6rem">
        <button class="knopf klein" data-aktion="sortieren-umschalten">↕ Reihenfolge ändern</button>
        <button class="knopf klein" data-aktion="nach-datum" hidden>📅 Nach Datum sortieren</button>
      </div>` : ""}
      <div style="margin-top:.8rem">
        ${offen.map((a) => aufgabeHtml(a, { mitProjekt: false, liste: "projekt-offen" })).join("") || `<p class="leer">Keine offenen Aufgaben.</p>`}
      </div>
      ${fertig.length ? `<details class="einklappen"><summary>Erledigt (${fertig.length})</summary>
        ${fertig.map((a) => aufgabeHtml(a, { mitProjekt: false })).join("")}</details>` : ""}
    </section>`;
  sortierKnoepfeAktualisieren();
}

// --- Projekt-Dialog ---
const dP = $("#dialog-projekt");
let bearbeitetesProjekt = null;

function oeffneProjekt(p = null) {
  bearbeitetesProjekt = p;
  $("#projekt-ueberschrift").textContent = p ? "Projekt bearbeiten" : "Neues Projekt";
  $("#p-name").value = p?.name || "";
  $("#p-beschreibung").value = p?.beschreibung || "";
  $("#p-abgeschlossen").checked = !!p?.abgeschlossen;
  $("#p-abgeschlossen-zeile").hidden = !p;
  $("#p-loeschen").hidden = !p;
  dP.returnValue = "";
  dP.showModal();
  if (!p) $("#p-name").focus();
}

dP.addEventListener("close", async () => {
  if (dP.returnValue !== "speichern") return;
  const daten = {
    name: $("#p-name").value.trim(),
    beschreibung: leer($("#p-beschreibung").value),
    abgeschlossen: $("#p-abgeschlossen").checked,
  };
  let fehler, neueId;
  if (bearbeitetesProjekt) {
    ({ error: fehler } = await sb.from("projekte").update(daten).eq("id", bearbeitetesProjekt.id));
  } else {
    const { data, error } = await sb.from("projekte").insert(daten).select("id").single();
    fehler = error; neueId = data?.id;
  }
  if (fehler) { console.error(fehler); meldung("Speichern hat nicht geklappt. Bitte noch einmal versuchen.", true); return wiederOeffnen(dP); }
  meldung(bearbeitetesProjekt ? "Projekt gespeichert." : "Projekt angelegt.");
  if (neueId) { S.projektOffen = neueId; wechsleSeite("projekte"); }
  await neuLadenUndZeichnen();
});

$("#p-loeschen").addEventListener("click", async () => {
  const p = bearbeitetesProjekt;
  if (!p) return;
  if (!confirm(`Das Projekt „${p.name}“ löschen? Seine Termine und Aufgaben bleiben erhalten, gehören dann aber zu keinem Projekt mehr.`)) return;
  const { error } = await sb.from("projekte").delete().eq("id", p.id);
  if (error) return meldung("Löschen hat nicht geklappt.", true);
  dP.close();
  S.projektOffen = null;
  meldung("Projekt gelöscht.");
  await neuLadenUndZeichnen();
});

// ------------------------------------------------------------------
//  Duplizieren
// ------------------------------------------------------------------
const aufzaehlung = (teile) =>
  teile.length <= 1 ? teile.join("") : teile.slice(0, -1).join(", ") + " und " + teile[teile.length - 1];

// --- Termin: fragt nach dem neuen Datum ---
const dDT = $("#dialog-dupl-termin");
let duplQuelle = null;

function dtGanztagsUmschalten() {
  $("#dt-zeiten").hidden = $("#dt-ganztags").checked;
}
$("#dt-ganztags").addEventListener("change", dtGanztagsUmschalten);
$("#dt-start").addEventListener("change", () => {
  const s = $("#dt-start").value;
  if (s && !$("#dt-ende").value) {
    const [hh, mm] = s.split(":").map(Number);
    if (hh + 2 < 24) $("#dt-ende").value = `${pad(hh + 2)}:${pad(mm)}`;
  }
});

function oeffneTerminDuplizieren(t) {
  if (!t) return;
  duplQuelle = t;
  // Vorschlag: eine Woche später, aber nicht in der Vergangenheit
  let vorschlag = plusTage(t.datum, 7);
  while (vorschlag < heute()) vorschlag = plusTage(vorschlag, 7);
  const n = unterpunkteVon(t.id).length;
  const teile = [
    t.ort ? "Ort" : null,
    t.beschreibung ? "Notiz" : null,
    t.projekt_id ? "Projekt" : null,
    n ? `${n} Unterpunkt${n === 1 ? "" : "en"}` : null,
  ].filter(Boolean);
  $("#dt-info").textContent = teile.length
    ? `„${t.titel}“ wird mit ${aufzaehlung(teile)} kopiert.`
    : `„${t.titel}“ wird kopiert.`;
  $("#dt-hinweis").textContent = n
    ? "Die Unterpunkte sind danach wieder offen. Ihre Fristen verschieben sich mit dem Datum."
    : "";
  $("#dt-datum").value = vorschlag;
  $("#dt-ganztags").checked = !t.start_zeit;
  $("#dt-start").value = uhr(t.start_zeit);
  $("#dt-ende").value = uhr(t.end_zeit);
  dtGanztagsUmschalten();
  dDT.returnValue = "";
  dDT.showModal();
}

dDT.addEventListener("close", async () => {
  if (dDT.returnValue !== "ok" || !duplQuelle) return;
  const ganz = $("#dt-ganztags").checked;
  const start = ganz ? null : $("#dt-start").value || null;
  const datum = $("#dt-datum").value;
  const { error } = await sb.rpc("termin_duplizieren", {
    quelle: duplQuelle.id,
    neues_datum: datum,
    neue_start_zeit: start,
    neue_end_zeit: start ? $("#dt-ende").value || null : null,
  });
  if (error) { console.error(error); meldung("Duplizieren hat nicht geklappt.", true); return wiederOeffnen(dDT); }
  if (datum >= heute() && S.zeitraum !== "kommend") $('[data-zeitraum="kommend"]').click();
  meldung(`Termin dupliziert: ${langesDatum(datum)}.`);
  await neuLadenUndZeichnen();
});

// --- Projekt: fragt nach Name und neuem Startdatum ---
const dDP = $("#dialog-dupl-projekt");
let duplProjekt = null;
let duplAnker = null; // frühestes Datum im Projekt

function oeffneProjektDuplizieren(p) {
  if (!p) return;
  duplProjekt = p;
  const z = projektZahlen(p);
  const termineDaten = z.termine.map((t) => t.datum).sort();
  const fristen = z.aufgaben.map((a) => a.faellig).filter(Boolean).sort();
  duplAnker = termineDaten[0] || fristen[0] || null;

  const weitere = z.aufgaben.filter((a) => !a.termin_id || !z.termine.some((t) => t.id === a.termin_id)).length;
  const punkte = z.aufgaben.length - weitere;
  const teile = [
    z.termine.length ? `${z.termine.length} Termin${z.termine.length === 1 ? "" : "e"}` : null,
    punkte ? `${punkte} Unterpunkt${punkte === 1 ? "" : "e"}` : null,
    weitere ? `${weitere} Aufgabe${weitere === 1 ? "" : "n"}` : null,
  ].filter(Boolean);
  $("#dp-info").textContent = teile.length
    ? `Kopiert werden ${aufzaehlung(teile)}. Alles ist danach wieder offen.`
    : "Das Projekt hat noch keine Termine oder Aufgaben – kopiert werden Name und Beschreibung.";

  // Jahreszahl im Namen hochzählen, sonst "(Kopie)"
  const jahr = p.name.match(/\b(20\d{2})\b/);
  $("#dp-name").value = jahr ? p.name.replace(jahr[1], String(Number(jahr[1]) + 1)) : `${p.name} (Kopie)`;

  $("#dp-datum-bereich").hidden = !duplAnker;
  $("#dp-datum-label").textContent = termineDaten[0] ? "Erster Termin im neuen Projekt" : "Erste Frist im neuen Projekt";
  $("#dp-datum").value = duplAnker ? plusJahr(duplAnker) : "";
  $("#dp-datum").required = !!duplAnker;
  dDP.returnValue = "";
  dDP.showModal();
}

dDP.addEventListener("close", async () => {
  if (dDP.returnValue !== "ok" || !duplProjekt) return;
  const verschiebung = duplAnker ? tageZwischen(duplAnker, $("#dp-datum").value) : 0;
  const { data, error } = await sb.rpc("projekt_duplizieren", {
    quelle: duplProjekt.id,
    neuer_name: $("#dp-name").value.trim(),
    verschiebung_tage: verschiebung,
  });
  if (error) { console.error(error); meldung("Duplizieren hat nicht geklappt.", true); return wiederOeffnen(dDP); }
  S.projektOffen = data;
  wechsleSeite("projekte");
  meldung("Projekt dupliziert.");
  await neuLadenUndZeichnen();
});

// --- Aufgabe: sofort kopieren und zum Anpassen öffnen ---
async function dupliziereAufgabe(a) {
  const { data, error } = await sb
    .from("aufgaben")
    .insert({
      titel: a.titel,
      beschreibung: a.beschreibung,
      zustaendig: a.zustaendig,
      faellig: a.faellig,
      termin_id: a.termin_id,
      projekt_id: a.projekt_id,
      status: "offen",
    })
    .select("id")
    .single();
  if (error) { console.error(error); return meldung("Duplizieren hat nicht geklappt.", true); }
  await neuLadenUndZeichnen();
  const kopie = S.aufgaben.find((x) => x.id === data.id);
  if (kopie) oeffneAufgabe(kopie);
  meldung("Kopie angelegt – du kannst sie jetzt anpassen.");
}

// ------------------------------------------------------------------
//  Mehr: Name, Kalender-Abo, Vorstandsliste
// ------------------------------------------------------------------
function zeichneMehr() {
  if (document.activeElement !== $("#mein-name")) $("#mein-name").value = S.ich?.name || "";
  $("#vorstand-liste").innerHTML = S.profile
    .filter((p) => p.aktiv)
    .map((p) => `<li><strong>${esc(p.name || "(noch ohne Namen)")}</strong><br>
      ${p.email ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : ""}</li>`)
    .join("");
}

const aboUrl = () => `${cfg.supabaseUrl.replace(/\/$/, "")}/functions/v1/kalender?token=${S.aboToken}`;

function zeichneAbo() {
  const ok = !!S.aboToken;
  $("#abo-webcal").href = ok ? aboUrl().replace(/^https?:/, "webcal:") : "#";
  $("#abo-kopieren").disabled = !ok;
}

$("#abo-kopieren").addEventListener("click", async () => {
  const text = aboUrl();
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.append(ta); ta.select();
    document.execCommand("copy"); ta.remove();
  }
  meldung("Link kopiert.");
});

$("#abo-erneuern").addEventListener("click", async () => {
  if (!confirm("Neuen Kalender-Link erzeugen? Alle bisherigen Abos hören dann auf zu funktionieren und müssen neu eingerichtet werden.")) return;
  const { data, error } = await sb.rpc("abo_token_erneuern");
  if (error) return meldung("Das hat nicht geklappt.", true);
  S.aboToken = data;
  zeichneAbo();
  meldung("Neuer Link erzeugt. Bitte allen Bescheid geben.");
});

$("#form-name").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#mein-name").value.trim();
  if (!name) return;
  const { error } = await sb.from("profiles").update({ name }).eq("id", S.userId);
  if (error) return meldung("Speichern hat nicht geklappt.", true);
  S.ich.name = name;
  const p = S.profile.find((x) => x.id === S.userId); if (p) p.name = name;
  zeichneAlles();
  meldung("Name gespeichert.");
});

// Start: Falls niemand angemeldet ist, kommt sofort die Anmeldung
const { data: { session } } = await sb.auth.getSession();
if (!session) zeigeAnmeldung();
