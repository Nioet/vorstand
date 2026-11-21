// Vorstands-App – Termine & Aufgaben
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
const wochentag = (s) => fmtWochentag.format(alsDatum(s)).replace(".", "");
const langesDatum = (s) => fmtLang.format(alsDatum(s));

const leer = (v) => { const x = (v ?? "").trim(); return x === "" ? null : x; };

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
  aboToken: null,
  zeitraum: "kommend",
  filter: "alle",
  seite: localStorage.getItem("vorstand-seite") || "termine",
  kanal: null,
};

const nameVon = (id) => {
  const p = S.profile.find((x) => x.id === id);
  return p ? p.name || p.email : null;
};

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
  const [t, a] = await Promise.all([
    sb.from("termine").select("*").order("datum").order("start_zeit", { nullsFirst: true }),
    sb.from("aufgaben").select("*").order("created_at"),
  ]);
  if (t.error) throw t.error;
  if (a.error) throw a.error;
  S.termine = t.data;
  S.aufgaben = a.data;
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
    const t = S.termine.find((x) => x.id === tId);
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

function starteLive() {
  stoppeLive();
  S.kanal = sb
    .channel("vorstand")
    .on("postgres_changes", { event: "*", schema: "public", table: "termine" }, nachladen)
    .on("postgres_changes", { event: "*", schema: "public", table: "aufgaben" }, nachladen)
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
function wechsleSeite(seite) {
  S.seite = seite;
  localStorage.setItem("vorstand-seite", seite);
  for (const s of ["termine", "aufgaben", "mehr"]) $("#seite-" + s).hidden = s !== seite;
  $$(".leiste button").forEach((b) => b.classList.toggle("aktiv", b.dataset.seite === seite));
  window.scrollTo(0, 0);
}
$$(".leiste button").forEach((b) => b.addEventListener("click", () => wechsleSeite(b.dataset.seite)));

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

function zeichneAlles() {
  zeichneTermine();
  zeichneAufgaben();
  zeichneMehr();
}

// ------------------------------------------------------------------
//  Termine
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

function zeichneTermine() {
  const h = heute();
  const kommend = S.zeitraum === "kommend";
  let eintraege = S.termine
    .filter((t) => (kommend ? (t.bis_datum || t.datum) >= h : (t.bis_datum || t.datum) < h))
    .map((t) => ({ art: "termin", datum: t.datum, sort: t.datum + (t.start_zeit || "00:00"), t }));

  if (kommend) {
    eintraege.push(
      ...S.aufgaben
        .filter((a) => a.faellig && a.status !== "erledigt" && a.faellig >= h)
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
    const block = `<span class="datum-block"><span class="wt">${esc(wochentag(e.datum))}</span><span class="tg">${alsDatum(e.datum).getDate()}</span></span>`;
    if (e.art === "termin") {
      const t = e.t;
      const laeuft = t.datum <= h && (t.bis_datum || t.datum) >= h;
      html += `<button class="termin${laeuft ? " heute" : ""}" data-termin="${t.id}">${block}
        <span class="termin-text">
          <strong>${esc(t.titel)}${kommend ? relMarke(t.datum) : ""}</strong>
          <span class="zeit">${esc(zeitText(t))}</span>
          ${t.ort ? `<span class="ort"><br>📍 ${esc(t.ort)}</span>` : ""}
          ${t.beschreibung ? `<span class="notiz"><br>${esc(t.beschreibung.length > 140 ? t.beschreibung.slice(0, 140) + " …" : t.beschreibung)}</span>` : ""}
        </span></button>`;
    } else {
      const a = e.a;
      const wer = nameVon(a.zustaendig);
      html += `<button class="termin frist" data-aufgabe="${a.id}">${block}
        <span class="termin-text">
          <strong>Frist: ${esc(a.titel)}${relMarke(a.faellig)}</strong>
          <span class="ort">👤 ${esc(wer || "noch niemand zuständig")}</span>
        </span></button>`;
    }
  }
  ziel.innerHTML = html;
}

$("#termin-liste").addEventListener("click", (e) => {
  const t = e.target.closest("[data-termin]");
  if (t) return oeffneTermin(S.termine.find((x) => x.id === t.dataset.termin));
  const a = e.target.closest("[data-aufgabe]");
  if (a) return oeffneAufgabe(S.aufgaben.find((x) => x.id === a.dataset.aufgabe));
});

// --- Termin-Dialog ---
const dT = $("#dialog-termin");
let bearbeiteterTermin = null;

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

function oeffneTermin(t = null) {
  bearbeiteterTermin = t;
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
  $("#t-loeschen").hidden = !t;
  ganztagsUmschalten();
  dT.returnValue = "";
  dT.showModal();
  if (!t) $("#t-titel").focus();
}
$('[data-aktion="neuer-termin"]').addEventListener("click", () => oeffneTermin());

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
  };
  const anfrage = bearbeiteterTermin
    ? sb.from("termine").update(daten).eq("id", bearbeiteterTermin.id)
    : sb.from("termine").insert(daten);
  const { error } = await anfrage;
  if (error) { console.error(error); meldung("Speichern hat nicht geklappt. Bitte noch einmal versuchen.", true); return wiederOeffnen(dT); }
  meldung(bearbeiteterTermin ? "Termin gespeichert." : "Termin eingetragen.");
  await ladeInhalte(); zeichneAlles();
});

$("#t-loeschen").addEventListener("click", async () => {
  const t = bearbeiteterTermin;
  if (!t || !confirm(`Den Termin „${t.titel}“ wirklich löschen?`)) return;
  const { error } = await sb.from("termine").delete().eq("id", t.id);
  if (error) return meldung("Löschen hat nicht geklappt.", true);
  dT.close();
  meldung("Termin gelöscht.");
  await ladeInhalte(); zeichneAlles();
});

// ------------------------------------------------------------------
//  Aufgaben
// ------------------------------------------------------------------
const SPALTEN = [
  { status: "offen", titel: "Offen" },
  { status: "in_arbeit", titel: "In Arbeit" },
  { status: "erledigt", titel: "Erledigt" },
];

function fristText(a) {
  if (!a.faellig) return "";
  if (a.status === "erledigt") return `📅 war bis ${esc(langesDatum(a.faellig))}`;
  const n = tageBis(a.faellig);
  if (n < 0) return `<span class="ueberfaellig">⚠️ überfällig seit ${-n === 1 ? "gestern" : `${-n} Tagen`}</span>`;
  if (n === 0) return `<span class="bald">📅 heute fällig</span>`;
  if (n === 1) return `<span class="bald">📅 morgen fällig</span>`;
  return `📅 bis ${esc(langesDatum(a.faellig))}`;
}

function aufgabeHtml(a) {
  const wer = nameVon(a.zustaendig);
  const istMeine = a.zustaendig === S.userId;
  let knoepfe = "";
  if (a.status === "offen") {
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
  return `<article class="aufgabe${a.status === "erledigt" ? " ist-erledigt" : ""}" data-id="${a.id}">
    <button class="titel-knopf" data-tun="bearbeiten">${esc(a.titel)}</button>
    <div class="meta">👤 ${esc(wer ? (istMeine ? `${wer} (ich)` : wer) : "noch niemand")}${frist ? " · " + frist : ""}</div>
    <div class="knoepfe">${knoepfe}</div>
  </article>`;
}

function zeichneAufgaben() {
  let liste = S.aufgaben;
  if (S.filter === "meine") liste = liste.filter((a) => a.zustaendig === S.userId);
  if (S.filter === "niemand") liste = liste.filter((a) => !a.zustaendig);

  const nachFrist = (x, y) =>
    (x.faellig || "9999") < (y.faellig || "9999") ? -1 :
    (x.faellig || "9999") > (y.faellig || "9999") ? 1 :
    x.created_at < y.created_at ? -1 : 1;

  let html = "";
  for (const sp of SPALTEN) {
    let teil = liste.filter((a) => a.status === sp.status);
    teil = sp.status === "erledigt"
      ? teil.sort((x, y) => ((x.erledigt_am || "") < (y.erledigt_am || "") ? 1 : -1))
      : teil.sort(nachFrist);
    const karten = teil.map(aufgabeHtml).join("") || `<p class="leer">Nichts hier.</p>`;
    html += `<section class="spalte"><h2>${sp.titel} <span class="anzahl">${teil.length}</span></h2>
      ${sp.status === "erledigt" && teil.length ? `<details><summary>Anzeigen</summary>${karten}</details>` : karten}
    </section>`;
  }
  $("#aufgaben-board").innerHTML = html;
}

async function aendereAufgabe(a, aenderung, text) {
  const vorher = { ...a };
  Object.assign(a, aenderung);            // sofort anzeigen …
  zeichneAufgaben(); zeichneTermine();
  const { error } = await sb.from("aufgaben").update(aenderung).eq("id", a.id);
  if (error) {                            // … und bei Fehler zurücknehmen
    Object.assign(a, vorher);
    zeichneAufgaben(); zeichneTermine();
    return meldung("Das hat nicht geklappt. Bitte noch einmal versuchen.", true);
  }
  if (text) meldung(text);
}

$("#aufgaben-board").addEventListener("click", (e) => {
  const knopf = e.target.closest("[data-tun]");
  if (!knopf) return;
  const a = S.aufgaben.find((x) => x.id === knopf.closest("[data-id]").dataset.id);
  if (!a) return;
  switch (knopf.dataset.tun) {
    case "bearbeiten": return oeffneAufgabe(a);
    case "nehmen": return aendereAufgabe(a, { zustaendig: S.userId, status: "in_arbeit" }, "Danke, die Aufgabe gehört jetzt dir.");
    case "anfangen": return aendereAufgabe(a, { status: "in_arbeit" });
    case "zurueck": return aendereAufgabe(a, { status: "offen" });
    case "erledigt": return aendereAufgabe(a, { status: "erledigt" }, "Erledigt – super! 🎉");
    case "oeffnen": return aendereAufgabe(a, { status: "offen" });
  }
});

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

function oeffneAufgabe(a = null) {
  bearbeiteteAufgabe = a;
  $("#aufgabe-ueberschrift").textContent = a ? "Aufgabe bearbeiten" : "Neue Aufgabe";
  $("#a-titel").value = a?.titel || "";
  personenAuswahl(a?.zustaendig);
  $("#a-faellig").value = a?.faellig || "";
  $("#a-status").value = a?.status || "offen";
  $("#a-notiz").value = a?.beschreibung || "";
  $("#a-loeschen").hidden = !a;
  dA.returnValue = "";
  dA.showModal();
  if (!a) $("#a-titel").focus();
}
$('[data-aktion="neue-aufgabe"]').addEventListener("click", () => oeffneAufgabe());

dA.addEventListener("close", async () => {
  if (dA.returnValue !== "speichern") return;
  const daten = {
    titel: $("#a-titel").value.trim(),
    zustaendig: $("#a-wer").value || null,
    faellig: $("#a-faellig").value || null,
    status: $("#a-status").value,
    beschreibung: leer($("#a-notiz").value),
  };
  const anfrage = bearbeiteteAufgabe
    ? sb.from("aufgaben").update(daten).eq("id", bearbeiteteAufgabe.id)
    : sb.from("aufgaben").insert(daten);
  const { error } = await anfrage;
  if (error) { console.error(error); meldung("Speichern hat nicht geklappt. Bitte noch einmal versuchen.", true); return wiederOeffnen(dA); }
  meldung(bearbeiteteAufgabe ? "Aufgabe gespeichert." : "Aufgabe angelegt.");
  await ladeInhalte(); zeichneAlles();
});

$("#a-loeschen").addEventListener("click", async () => {
  const a = bearbeiteteAufgabe;
  if (!a || !confirm(`Die Aufgabe „${a.titel}“ wirklich löschen?`)) return;
  const { error } = await sb.from("aufgaben").delete().eq("id", a.id);
  if (error) return meldung("Löschen hat nicht geklappt.", true);
  dA.close();
  meldung("Aufgabe gelöscht.");
  await ladeInhalte(); zeichneAlles();
});

// ------------------------------------------------------------------
//  Mehr: Name, Kalender-Abo, Vorstandsliste
// ------------------------------------------------------------------
function zeichneMehr() {
  $("#mein-name").value = S.ich?.name || "";
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
