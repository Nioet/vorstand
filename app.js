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
const fmtZahl = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" });
const wochentag = (s) => fmtWochentag.format(alsDatum(s)).replace(".", "");
// Platzsparend: "Fr., 28.05.27" bzw. "28.05.27"
const kurzesDatum = (s) => fmtZahl.format(alsDatum(s));
const langesDatum = (s) => `${wochentag(s)}.,\u00a0${kurzesDatum(s)}`;
// Infoblöcke, die nur als Ganzes umbrechen: "👤 Almut · 📅 nächster Termin: Sa., 28.11.26"
const bloecke = (teile) => teile.filter(Boolean).map((t) => `<span class="block">${t}</span>`).join(" · ");

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

// Auf Handys nicht von selbst ins Textfeld springen (sonst klappt die Tastatur auf)
const istTouch = () => matchMedia("(pointer: coarse)").matches;

// X oben rechts schließt jedes Fenster, ohne zu speichern
document.addEventListener("click", (e) => {
  const zu = e.target.closest("[data-schliessen]");
  if (zu) zu.closest("dialog").close("abbrechen");
});

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
  rueckmeldungen: [],
  aboToken: null,
  aboTokenTeilen: null,
  zeitraum: "kommend",
  filter: "meine", // Aufgaben öffnen mit den eigenen
  projektFilter: "",
  projektOffen: null,
  zeigeAbgeschlossene: false,
  sortieren: false,       // ↑/↓ auf dem Aufgabenboard und im Projekt
  listen: {},             // zuletzt angezeigte Reihenfolgen (für ↑/↓)
  seite: localStorage.getItem("vorstand-seite") || "termine",
  kanal: null,
};

// Angezeigt wird überall nur der Vorname. Haben zwei denselben Vornamen,
// kommt der Anfangsbuchstabe des Nachnamens dazu ("Anna M.").
function anzeigeNamen(profile) {
  const teile = (p) => (p.name || "").trim().split(/\s+/).filter(Boolean);
  const vor = (p) => teile(p)[0] || (p.email || "").split("@")[0] || "?";
  const anzahl = {};
  for (const p of profile) anzahl[vor(p).toLowerCase()] = (anzahl[vor(p).toLowerCase()] || 0) + 1;
  const namen = {};
  for (const p of profile) {
    const t = teile(p);
    namen[p.id] = anzahl[vor(p).toLowerCase()] > 1 && t.length > 1
      ? `${t[0]} ${t[t.length - 1][0].toUpperCase()}.`
      : vor(p);
  }
  return namen;
}
let namenCache = { quelle: null, namen: {} };
const nameVon = (id) => {
  if (!id || !S.profile.some((x) => x.id === id)) return null;
  if (namenCache.quelle !== S.profile) namenCache = { quelle: S.profile, namen: anzeigeNamen(S.profile) };
  return namenCache.namen[id];
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
  const { data, error } = await sb.from("profiles").select("id,name,email,aktiv,admin").order("name", { nullsFirst: false });
  if (error) throw error;
  S.profile = data;
  S.ich = data.find((p) => p.id === S.userId) || null;
}

async function ladeInhalte() {
  const [t, a, p, r] = await Promise.all([
    sb.from("termine").select("*").order("datum").order("start_zeit", { nullsFirst: true }),
    sb.from("aufgaben").select("*").order("position", { nullsFirst: false }).order("created_at"),
    sb.from("projekte").select("*").order("name"),
    sb.from("rueckmeldungen").select("termin_id,person,dabei"),
  ]);
  // Rückmeldungen sind Zusatz: Fehlt die Tabelle o. Ä., läuft der Rest trotzdem
  S.rueckmeldungen = r.error ? [] : r.data;
  if (r.error) console.error(r.error);
  if (t.error) throw t.error;
  if (a.error) throw a.error;
  if (p.error) throw p.error;
  S.termine = t.data;
  S.aufgaben = a.data;
  S.projekte = p.data;
}

async function ladeAbo() {
  const { data } = await sb.from("kalender_abo").select("id,token");
  S.aboToken = data?.find((x) => x.id === 1)?.token || null;
  S.aboTokenTeilen = data?.find((x) => x.id === 2)?.token || null;
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
    meldung("Willkommen! Trag bitte zuerst deinen Vornamen ein.");
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
    .on("postgres_changes", { event: "*", schema: "public", table: "rueckmeldungen" }, nachladen)
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
  if (seite === "mehr") ladeProtokoll();
}

// ------------------------------------------------------------------
//  Änderungsprotokoll (nur für Konten mit admin = true)
// ------------------------------------------------------------------
const FELDNAMEN = {
  titel: "Titel", name: "Name", datum: "Datum", bis_datum: "Enddatum", start_zeit: "Uhrzeit", end_zeit: "Uhrzeit",
  ort: "Ort", beschreibung: "Notiz", projekt_id: "Projekt", zustaendig: "Zuständig", zustaendig_extern: "Zuständig",
  faellig: "Frist", faellig_zeit: "Frist", termin_id: "Termin", status: "Status", extern: "extern", gehoert_zu: "Verknüpfung",
  abgeschlossen: "abgeschlossen", in_planung: "in Planung", link: "Link",
};
const ARTIKEL = { Termin: "den Termin", Aufgabe: "die Aufgabe", Unterpunkt: "den Unterpunkt", Projekt: "das Projekt" };

function protokollSatz(e) {
  const wer = e.person ? nameVon(e.person) : "Jemand";
  const titel = e.titel ? `„${e.titel}“` : "";
  if (e.art === "Rückmeldung") {
    const was = { zugesagt: "zugesagt", abgesagt: "abgesagt", "zurückgenommen": "die Rückmeldung zurückgenommen" }[e.aktion] || e.aktion;
    return e.aktion === "zurückgenommen" ? `${wer} hat bei ${titel} ${was}` : `${wer} hat für ${titel} ${was}`;
  }
  const anzahl = e.anzahl > 1;
  const objekt = anzahl
    ? `${e.anzahl} ${e.art === "Unterpunkt" ? "Unterpunkte" : e.art === "Aufgabe" ? "Aufgaben" : e.art + "e"}`
    : `${ARTIKEL[e.art] || e.art} ${titel}`;
  const ort = e.kontext ? ` im Termin „${e.kontext}“` : "";
  const verb = {
    angelegt: "angelegt", "geändert": "geändert", "gelöscht": "gelöscht", erledigt: "erledigt",
    angefangen: "angefangen", wieder_offen: "wieder geöffnet", "übernommen": "übernommen",
  }[e.aktion] || e.aktion;
  const felder = [...new Set((e.felder || []).map((f) => FELDNAMEN[f] || f))];
  return `${wer} hat ${objekt}${ort} ${verb}${felder.length ? ` (${felder.join(", ")})` : ""}`;
}

// Gleiche Vorgänge derselben Person kurz hintereinander zusammenfassen
// (z. B. beim Duplizieren eines Termins mit vielen Unterpunkten)
function protokollBuendeln(liste) {
  const aus = [];
  for (const e of liste) {
    const v = aus[aus.length - 1];
    if (v && e.art !== "Rückmeldung" && v.art === e.art && v.aktion === e.aktion && v.person === e.person &&
        v.kontext === e.kontext && v.aktion !== "geändert" &&
        Math.abs(new Date(v.zeit) - new Date(e.zeit)) < 120000) {
      v.anzahl = (v.anzahl || 1) + 1;
    } else aus.push({ ...e });
  }
  return aus;
}

let protokollEintraege = [];

// Eintrag aus dem Protokoll öffnen
function oeffneAusProtokoll(e) {
  const weg = () => meldung("Das gibt es inzwischen nicht mehr.", true);
  if (e.art === "Termin" || e.art === "Rückmeldung") {
    const t = terminVon(e.objekt_id);
    return t ? oeffneTermin(t) : weg();
  }
  if (e.art === "Aufgabe" || e.art === "Unterpunkt") {
    const a = S.aufgaben.find((x) => x.id === e.objekt_id);
    if (!a) return weg();
    // Mehrere Unterpunkte auf einmal: den Termin mit der ganzen Liste öffnen
    if (e.anzahl > 1 && a.termin_id && terminVon(a.termin_id)) return oeffneTermin(terminVon(a.termin_id));
    return oeffneAufgabe(a);
  }
  if (e.art === "Projekt") {
    if (!S.projekte.some((p) => p.id === e.objekt_id)) return weg();
    S.projektOffen = e.objekt_id;
    wechsleSeite("projekte");
    zeichneProjekte();
  }
}
$("#protokoll-liste").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-protokoll]");
  if (b) oeffneAusProtokoll(protokollEintraege[Number(b.dataset.protokoll)]);
});

async function ladeProtokoll() {
  const karte = $("#protokoll-karte");
  karte.hidden = !S.ich?.admin;
  if (!S.ich?.admin) return;
  const seit = new Date(Date.now() - 3 * 86400000).toISOString();
  const { data, error } = await sb.from("protokoll").select("*").gte("zeit", seit).order("zeit", { ascending: false }).limit(500);
  if (error) { console.error(error); $("#protokoll-liste").innerHTML = `<li class="klein">Konnte nicht geladen werden.</li>`; return; }
  const liste = protokollBuendeln(data);
  protokollEintraege = liste;
  $("#protokoll-liste").innerHTML = liste.length
    ? liste.map((e, i) => {
        const d = new Date(e.zeit);
        const tag = isoTag(d);
        const zeit = `${kurzesDatum(tag)}, ${pad(d.getHours())}:${pad(d.getMinutes())}\u00a0Uhr`;
        const inhalt = `<span class="protokoll-zeit">${esc(zeit)},</span> ${esc(protokollSatz(e))}`;
        return `<li>${e.objekt_id && e.aktion !== "gelöscht"
          ? `<button type="button" class="protokoll-knopf" data-protokoll="${i}">${inhalt}</button>`
          : inhalt}</li>`;
      }).join("")
    : `<li class="klein">In den letzten drei Tagen hat sich nichts geändert.</li>`;
}
$$(".leiste button").forEach((b) =>
  b.addEventListener("click", () => {
    // Nochmal auf "Projekte" tippen führt zurück zur Übersicht
    if (b.dataset.seite === "projekte" && S.seite === "projekte" && S.projektOffen) {
      S.projektOffen = null;
      zeichneProjekte();
    }
    // Beim Öffnen der Aufgaben zuerst die eigenen zeigen
    if (b.dataset.seite === "aufgaben" && S.seite !== "aufgaben") setzeFilter("meine");
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
function setzeFilter(filter) {
  S.filter = filter;
  $$("[data-filter]").forEach((x) => x.classList.toggle("aktiv", x.dataset.filter === filter));
  if (S.aufgaben) zeichneAufgaben();
}
$$("[data-filter]").forEach((b) => b.addEventListener("click", () => setzeFilter(b.dataset.filter)));
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
    case "neue-planung": return oeffneProjekt(null, { in_planung: true });
    case "projekt-starten": return p && projektStarten(p);
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

// Externe Termine, die mit einem unserer Termine verknüpft sind
const verknuepfteVon = (id) =>
  S.termine.filter((x) => x.gehoert_zu === id).sort((a, b) => (a.datum + (a.start_zeit || "")).localeCompare(b.datum + (b.start_zeit || "")));
const istVerknuepft = (t) => !!(t.gehoert_zu && S.termine.some((x) => x.id === t.gehoert_zu));

// Externe Termine: klein und dunkelgrün – nur Datum, was und wer von uns hingeht
function externKarte(t) {
  const wer = nameVon(t.zustaendig);
  const mehrtaegig = t.bis_datum && t.bis_datum !== t.datum;
  const punkte = unterpunkteVon(t.id);
  const offen = punkte.filter((a) => a.status !== "erledigt").length;
  const rueck = rueckBloecke(t.id);
  return `<button class="termin-extern${t.zustaendig ? " uebernommen" : ""}" data-termin="${t.id}">
    <span class="te-datum" ${mehrtaegig ? `title="bis ${esc(kurzesDatum(t.bis_datum))}"` : ""}><span class="wt">${esc(wochentag(t.datum))}</span><span class="tg">${alsDatum(t.datum).getDate()}${mehrtaegig ? "+" : ""}</span></span>
    <span class="te-text">
      <span class="te-titel">${esc(t.titel)}</span>
      ${wer || punkte.length || rueck.some(Boolean) ? `<span class="te-wer">${bloecke([
        wer ? `👤 ${esc(wer)}${t.zustaendig === S.userId ? " (ich)" : ""}` : "",
        ...rueck,
        punkte.length ? `☑ ${punkte.length - offen} von ${punkte.length}` : "",
      ])}</span>` : ""}
    </span>
  </button>`;
}

// Rückmeldungen: wer ist dabei, wer kann nicht
function rueckVon(terminId) {
  const zeilen = (S.rueckmeldungen || []).filter((r) => r.termin_id === terminId);
  return {
    dabei: zeilen.filter((r) => r.dabei).map((r) => r.person),
    nicht: zeilen.filter((r) => !r.dabei).map((r) => r.person),
    meine: zeilen.find((r) => r.person === S.userId) || null,
  };
}
// Für die Karten: „✓ Anna, Nils · ✗ Mehmet“
function rueckBloecke(terminId) {
  const r = rueckVon(terminId);
  return [
    r.dabei.length ? `<span class="rz ja">✓</span>\u00a0${esc(namenListe(r.dabei).join(", "))}` : "",
    r.nicht.length ? `<span class="rz nein">✗</span>\u00a0${esc(namenListe(r.nicht).join(", "))}` : "",
  ];
}
const namenListe = (ids) => ids.map((id) => nameVon(id) + (id === S.userId ? " (ich)" : "")).sort((x, y) => x.localeCompare(y, "de"));

function terminKarte(t, { mitMarke = true, mitProjekt = true } = {}) {
  if (t.extern) return externKarte(t);
  const rueckText = bloecke(rueckBloecke(t.id));
  const h = heute();
  const laeuft = t.datum <= h && (t.bis_datum || t.datum) >= h;
  const punkte = unterpunkteVon(t.id);
  const fertig = punkte.filter((a) => a.status === "erledigt").length;
  const etiketten = [
    mitProjekt ? projektEtikett(t.projekt_id) : "",
  ].join("");
  return `<div class="karte-zeile"><button class="termin${laeuft ? " heute" : ""}" data-termin="${t.id}">${datumBlock(t.datum)}
    <span class="termin-text">
      <span class="plus-platz" aria-hidden="true"></span>
      <strong>${esc(t.titel)}${mitMarke ? relMarke(t.datum) : ""}</strong>
      <span class="zeit zeile-block">${esc(zeitText(t))}</span>
      ${t.ort ? `<span class="ort zeile-block">📍 ${esc(t.ort)}</span>` : ""}
      ${rueckText ? `<span class="rueck zeile-block" title="Rückmeldungen">${rueckText}</span>` : ""}
      ${t.beschreibung ? `<span class="notiz zeile-block">${esc(t.beschreibung.length > 140 ? t.beschreibung.slice(0, 140) + " …" : t.beschreibung)}</span>` : ""}
      ${etiketten ? `<span class="etiketten">${etiketten}</span>` : ""}
    </span>${punkte.length ? fortschritt(fertig, punkte.length) : ""}</button>
    <button class="dupl-knopf" data-dupl-termin="${t.id}" aria-label="Termin „${esc(t.titel)}“ duplizieren" title="Duplizieren">＋</button></div>`;
}

function fristText(a) {
  if (!a.faellig) return "";
  const zeit = a.faellig_zeit ? `${uhr(a.faellig_zeit)}\u00a0Uhr` : "";
  if (a.status === "erledigt") return `📅 war bis ${esc(langesDatum(a.faellig))}${zeit ? ", " + zeit : ""}`;
  const n = tageBis(a.faellig);
  const jetzt = new Date();
  const vorbei = n === 0 && zeit && a.faellig_zeit.slice(0, 5) < `${pad(jetzt.getHours())}:${pad(jetzt.getMinutes())}`;
  if (n < 0) return `<span class="ueberfaellig">⚠️ überfällig seit ${-n === 1 ? "gestern" : `${-n} Tagen`}</span>`;
  if (vorbei) return `<span class="ueberfaellig">⚠️ überfällig seit ${zeit}</span>`;
  if (n === 0) return `<span class="bald">📅 heute ${zeit ? "bis " + zeit : "fällig"}</span>`;
  if (n === 1) return `<span class="bald">📅 morgen ${zeit ? "bis " + zeit : "fällig"}</span>`;
  return `📅 bis ${esc(langesDatum(a.faellig))}${zeit ? ", " + zeit : ""}`;
}

// Zuständig: Vorstandsmitglied oder externe Person (Freitext)
const werVon = (a) =>
  a.zustaendig ? nameVon(a.zustaendig) : a.zustaendig_extern ? `${a.zustaendig_extern} (extern)` : "";
const istVergeben = (a) => !!(a.zustaendig || a.zustaendig_extern);

function aufgabeHtml(a, { mitProjekt = true, liste = null } = {}) {
  const wer = werVon(a);
  const istMeine = a.zustaendig === S.userId;
  const sortierbar = S.sortieren && liste && a.status !== "erledigt";
  let knoepfe = "";
  if (sortierbar) {
    const ids = S.listen[liste] || [];
    const i = ids.indexOf(a.id);
    knoepfe = `<button class="knopf klein pfeil" data-tun="hoch" aria-label="Nach oben" ${i <= 0 ? "disabled" : ""}>↑ Hoch</button>
               <button class="knopf klein pfeil" data-tun="runter" aria-label="Nach unten" ${i === ids.length - 1 ? "disabled" : ""}>↓ Runter</button>`;
  } else if (a.status === "offen") {
    knoepfe = !istVergeben(a)
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
    <div class="aufgabe-kopf">
      <div class="aufgabe-text">
        <button class="titel-knopf" data-tun="bearbeiten">${esc(a.titel)}</button>
        ${wer || frist ? `<div class="meta">${bloecke([wer ? `👤 ${esc(istMeine ? `${wer} (ich)` : wer)}` : "", frist])}</div>` : ""}
      </div>
      ${sortierbar ? "" : `<button class="dupl-knopf" data-tun="duplizieren" aria-label="„${esc(a.titel)}“ duplizieren" title="Duplizieren">＋</button>`}
    </div>
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
    .filter((t) => !istVerknuepft(t))
    .filter((t) => (kommend ? (t.bis_datum || t.datum) >= h : (t.bis_datum || t.datum) < h))
    .map((t) => ({ art: "termin", datum: t.datum, sort: t.datum + (t.start_zeit || "00:00"), t }));

  if (kommend) {
    // Fristen von Aufgaben (ohne Unterpunkte – die stehen beim Termin)
    eintraege.push(
      ...S.aufgaben
        .filter((a) => a.faellig && a.status !== "erledigt" && a.faellig >= h && !a.termin_id)
        .map((a) => ({ art: "frist", datum: a.faellig, sort: a.faellig + (a.faellig_zeit ? a.faellig_zeit.slice(0, 5) : "23:59"), a })),
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
      const wer = werVon(a);
      const proj = projektEtikett(projektIdVonAufgabe(a));
      html += `<button class="termin frist" data-aufgabe="${a.id}">${datumBlock(a.faellig)}
        <span class="termin-text">
          <strong>Frist: ${esc(a.titel)}${relMarke(a.faellig)}</strong>
          ${a.faellig_zeit ? `<span class="zeit">bis ${uhr(a.faellig_zeit)} Uhr</span><br>` : ""}
          ${wer ? `<span class="ort">👤 ${esc(wer)}</span>` : ""}
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
  const mitNeu = select.id === "t-projekt" || select.id === "a-projekt";
  select.innerHTML =
    `<option value="">— kein Projekt —</option>` +
    liste.map((p) => `<option value="${p.id}">${esc(p.name)}${p.abgeschlossen ? " (abgeschlossen)" : p.in_planung ? " (in Planung)" : ""}</option>`).join("") +
    (mitNeu ? `<option value="__neu">＋ Neues Projekt erstellen</option>` : "");
  select.value = gewaehlt || "";
  select.dataset.vorher = select.value;
}

// Ohne eigenen Titel heißt ein Projekt-Termin wie das Projekt
function titelVorgabeAktualisieren() {
  const p = projektVon($("#t-projekt").value);
  const feld = $("#t-titel");
  feld.required = !p;
  feld.placeholder = p ? p.name : "z. B. Vorstandssitzung";
  const hinweis = $("#t-titel-hinweis");
  hinweis.hidden = !p || feld.value.trim() !== "";
  hinweis.textContent = p ? `Leer lassen, dann heißt der Termin „${p.name}“.` : "";
}
$("#t-projekt").addEventListener("change", titelVorgabeAktualisieren);
$("#t-titel").addEventListener("input", titelVorgabeAktualisieren);

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
  const importiert = !!t?.quelle;
  $("#termin-ueberschrift").textContent = importiert ? "Termin vom Kreisverband" : t ? "Termin bearbeiten" : "Neuer Termin";
  $("#t-felder").hidden = importiert;
  $("#t-info").hidden = !importiert;
  if (importiert) $("#t-info").innerHTML = terminInfo(t);
  $("#t-extern").checked = !!t?.extern;
  personenOptionen($("#t-wer"), t?.zustaendig);
  eigeneTerminOptionen(t);
  externUmschalten();
  zeichneVerknuepfte(t);
  zeichneRueckmeldung(t);
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
  titelVorgabeAktualisieren();
  $("#t-neuer-punkt").value = "";
  $("#t-loeschen").hidden = !t || importiert;
  ganztagsUmschalten();
  zeichneUnterpunkte();
  dT.returnValue = "";
  dT.showModal();
  if (!t && !istTouch()) $("#t-titel").focus();
}

function zeichneRueckmeldung(t) {
  $("#t-rueck").hidden = !t;
  if (!t) return;
  const r = rueckVon(t.id);
  $$("[data-rueck]").forEach((b) => {
    const an = !!r.meine && r.meine.dabei === (b.dataset.rueck === "ja");
    b.classList.toggle("gewaehlt", an);
    b.setAttribute("aria-pressed", an ? "true" : "false");
  });
  const zeile = (zeichen, wort, ids) => ids.length
    ? `<p><span class="rueck-zeichen ${zeichen === "✓" ? "ja" : "nein"}">${zeichen}</span> <strong>${wort}:</strong> ${esc(namenListe(ids).join(", "))}</p>` : "";
  $("#t-rueck-liste").innerHTML =
    zeile("✓", "Dabei", r.dabei) + zeile("✗", "Kann nicht", r.nicht);
}

$("#t-rueck").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-rueck]");
  const t = bearbeiteterTermin;
  if (!b || !t) return;
  const dabei = b.dataset.rueck === "ja";
  const meine = rueckVon(t.id).meine;
  const alt = S.rueckmeldungen;
  // Sofort anzeigen, dann speichern
  S.rueckmeldungen = alt.filter((r) => !(r.termin_id === t.id && r.person === S.userId));
  let ergebnis;
  if (meine && meine.dabei === dabei) {
    ergebnis = await sb.from("rueckmeldungen").delete().eq("termin_id", t.id).eq("person", S.userId);
  } else {
    S.rueckmeldungen.push({ termin_id: t.id, person: S.userId, dabei });
    ergebnis = await sb.from("rueckmeldungen").upsert({ termin_id: t.id, person: S.userId, dabei }, { onConflict: "termin_id,person" });
  }
  if (ergebnis.error) {
    console.error(ergebnis.error);
    S.rueckmeldungen = alt;
    meldung("Die Rückmeldung hat nicht geklappt.", true);
  }
  zeichneRueckmeldung(t);
  zeichneAlles();
});

function externUmschalten() {
  $("#t-wer-bereich").hidden = !$("#t-extern").checked;
  $("#t-uebernehmen").hidden = !(bearbeiteterTermin?.extern && $("#t-extern").checked && !istVerknuepft(bearbeiteterTermin));
  // Ein Termin, der selbst externe Termine sammelt, wird nicht seinerseits verknüpft
  $("#t-verknuepft").hidden = $("#t-extern").checked || !bearbeiteterTermin || !verknuepfteVon(bearbeiteterTermin.id).length;
}

// Auswahl „Gehört zu unserem Termin“: Termine am selben Tag zuerst, dann nach Abstand
function eigeneTerminOptionen(t) {
  const bezug = t?.datum || $("#t-datum").value || heute();
  const grenze = isoTag(new Date(Date.now() - 30 * 86400000));
  const abstand = (x) => Math.abs(alsDatum(x.datum) - alsDatum(bezug));
  const liste = S.termine
    .filter((x) => !x.extern && x.id !== t?.id && ((x.bis_datum || x.datum) >= grenze || x.id === t?.gehoert_zu))
    .sort((a, b) => abstand(a) - abstand(b) || a.datum.localeCompare(b.datum));
  $("#t-gehoert").innerHTML =
    `<option value="">— nicht verknüpft —</option>` +
    liste.map((x) => `<option value="${x.id}">${x.datum === bezug ? "★ " : ""}${esc(kurzesDatum(x.datum))} – ${esc(x.titel)}</option>`).join("");
  $("#t-gehoert").value = t?.gehoert_zu || "";
}

function zeichneVerknuepfte(t) {
  const liste = t ? verknuepfteVon(t.id) : [];
  $("#t-verknuepft-liste").innerHTML = liste
    .map((x) => `<div class="verknuepft-zeile">${externKarte(x).replace("data-termin=", 'type="button" data-verknuepft-oeffnen=')}
      <button type="button" class="punkt-weg" data-verknuepfung-loesen="${x.id}" aria-label="Verknüpfung mit „${esc(x.titel)}“ lösen" title="Verknüpfung lösen">✕</button></div>`)
    .join("");
  externUmschalten();
}

// Aus einem externen Termin einen eigenen machen: Daten übernehmen, extern damit verknüpfen
$("#t-uebernehmen").addEventListener("click", async () => {
  const x = bearbeiteterTermin;
  if (!x) return;
  const notiz = [x.beschreibung, x.link ? `Mehr dazu: ${x.link}` : ""].filter(Boolean).join("\n\n");
  const { data, error } = await sb.from("termine").insert({
    titel: x.titel, datum: x.datum, bis_datum: x.bis_datum, start_zeit: x.start_zeit, end_zeit: x.end_zeit,
    ort: x.ort, beschreibung: notiz || null, projekt_id: $("#t-projekt").value || x.projekt_id || null,
  }).select("id").single();
  if (error) { console.error(error); return meldung("Das hat nicht geklappt.", true); }
  const { error: e2 } = await sb.from("termine")
    .update({ gehoert_zu: data.id, zustaendig: $("#t-wer").value || null })
    .eq("id", x.id);
  if (e2) meldung("Eigener Termin angelegt, aber die Verknüpfung hat nicht geklappt.", true);
  dT.close("abbrechen");
  await neuLadenUndZeichnen();
  const neu = terminVon(data.id);
  if (neu) { oeffneTermin(neu); meldung("Eigener Termin angelegt und verknüpft – jetzt anpassen und speichern."); }
});

$("#t-verknuepft-liste").addEventListener("click", async (e) => {
  const oeffnen = e.target.closest("[data-verknuepft-oeffnen]");
  const loesen = e.target.closest("[data-verknuepfung-loesen]");
  if (oeffnen) {
    const x = terminVon(oeffnen.dataset.verknuepftOeffnen);
    dT.close("abbrechen");
    if (x) setTimeout(() => oeffneTermin(x), 50);
  } else if (loesen) {
    const id = loesen.dataset.verknuepfungLoesen;
    const { error } = await sb.from("termine").update({ gehoert_zu: null }).eq("id", id);
    if (error) return meldung("Das hat nicht geklappt.", true);
    const x = terminVon(id);
    if (x) x.gehoert_zu = null;
    zeichneVerknuepfte(bearbeiteterTermin);
    meldung("Verknüpfung gelöst – der Termin steht wieder in der Übersicht.");
  }
});
$("#t-extern").addEventListener("change", externUmschalten);

// Ansicht für Termine von der Website: alles zum Lesen, dazu der Link
function terminInfo(t) {
  const datum = t.bis_datum && t.bis_datum !== t.datum ? `${langesDatum(t.datum)} bis ${langesDatum(t.bis_datum)}` : langesDatum(t.datum);
  const zeit = t.start_zeit ? (t.end_zeit ? `${uhr(t.start_zeit)}–${uhr(t.end_zeit)}\u00a0Uhr` : `${uhr(t.start_zeit)}\u00a0Uhr`) : "";
  return `<h3 class="ti-titel">${esc(t.titel)}</h3>
    <p class="ti-zeile">📅 ${bloecke([esc(datum), zeit])}</p>
    ${t.ort ? `<p class="ti-zeile">📍 ${esc(t.ort)}</p>` : ""}
    ${t.beschreibung ? `<p class="ti-text">${esc(t.beschreibung)}</p>` : ""}
    ${t.link ? `<a class="knopf klein ti-link" href="${esc(t.link)}" target="_blank" rel="noopener">Auf der Website ansehen ↗</a>` : ""}
    <p class="klein ti-hinweis">Kommt automatisch von der Website des Kreisverbands und wird stündlich aktualisiert. Hier haltet ihr fest, wer hingeht, und könnt Unterpunkte anlegen.</p>`;
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
      const wer = werVon(a);
      const meta = bloecke([wer ? `👤 ${esc(wer)}` : "", a.faellig ? fristText(a) : ""]);
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
  if (dT.returnValue !== "speichern") { if (!bearbeiteterTermin) nachAnlegen.termin = null; return; }
  const extern = $("#t-extern").checked;
  const zustaendig = extern ? $("#t-wer").value || null : null;
  if (bearbeiteterTermin?.quelle) {
    // Termin von der Website: nur unsere Ergänzungen speichern
    const offen = $("#t-neuer-punkt").value.trim();
    const { error } = await sb.from("termine")
      .update({ zustaendig, projekt_id: $("#t-projekt").value || null, gehoert_zu: $("#t-gehoert").value || null })
      .eq("id", bearbeiteterTermin.id);
    if (!error && offen) await sb.from("aufgaben").insert({ titel: offen, termin_id: bearbeiteterTermin.id });
    if (error) { console.error(error); meldung("Speichern hat nicht geklappt. Bitte noch einmal versuchen.", true); return wiederOeffnen(dT); }
    meldung("Gespeichert.");
    return neuLadenUndZeichnen();
  }
  const datum = $("#t-datum").value;
  let bis = $("#t-bis").value || null;
  const start = $("#t-ganztags").checked ? null : $("#t-start").value || null;
  const ende = start ? $("#t-ende").value || null : null;
  if (bis && bis < datum) { meldung("Der letzte Tag liegt vor dem ersten Tag.", true); return wiederOeffnen(dT); }
  if (bis === datum) bis = null;

  const titel = $("#t-titel").value.trim() || projektVon($("#t-projekt").value)?.name || "";
  if (!titel) { meldung("Bitte gib dem Termin einen Titel.", true); return wiederOeffnen(dT); }
  const daten = {
    titel,
    datum,
    bis_datum: bis,
    start_zeit: start,
    end_zeit: ende,
    ort: leer($("#t-ort").value),
    beschreibung: leer($("#t-notiz").value),
    projekt_id: $("#t-projekt").value || null,
    extern,
    zustaendig,
    gehoert_zu: extern ? $("#t-gehoert").value || null : null,
  };
  // Noch nicht hinzugefügter Text im Unterpunkt-Feld soll nicht verloren gehen
  const offen = $("#t-neuer-punkt").value.trim();
  if (offen && !bearbeiteterTermin) entwurfPunkte.push(offen);

  let fehler, neueTerminId;
  if (bearbeiteterTermin) {
    ({ error: fehler } = await sb.from("termine").update(daten).eq("id", bearbeiteterTermin.id));
    if (!fehler && offen) await sb.from("aufgaben").insert({ titel: offen, termin_id: bearbeiteterTermin.id });
  } else {
    const { data, error } = await sb.from("termine").insert(daten).select("id").single();
    fehler = error;
    neueTerminId = data?.id;
    if (!error && entwurfPunkte.length) {
      const { error: e2 } = await sb.from("aufgaben").insert(entwurfPunkte.map((titel) => ({ titel, termin_id: data.id })));
      if (e2) meldung("Termin gespeichert, aber die Unterpunkte nicht.", true);
    }
  }
  if (fehler) { console.error(fehler); meldung("Speichern hat nicht geklappt. Bitte noch einmal versuchen.", true); return wiederOeffnen(dT); }
  meldung(bearbeiteterTermin ? "Termin gespeichert." : "Termin eingetragen.");
  entwurfPunkte = [];
  await neuLadenUndZeichnen();
  if (neueTerminId && nachAnlegen.termin) { const f = nachAnlegen.termin; nachAnlegen.termin = null; f(neueTerminId); }
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
    aktive.map((p) => `<option value="${p.id}">📁 ${esc(p.name)}${p.in_planung ? " (in Planung)" : ""}</option>`).join("");
  auswahl.value = S.projektFilter;
  auswahl.hidden = !S.projekte.length;

  let liste = S.aufgaben;
  if (S.filter === "meine") liste = liste.filter((a) => a.zustaendig === S.userId);
  if (S.filter === "niemand") liste = liste.filter((a) => !istVergeben(a));
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

function personenOptionen(select, gewaehlt, mitExtern = false) {
  const aktive = S.profile.filter((p) => p.aktiv || p.id === gewaehlt);
  select.innerHTML =
    `<option value="">— noch niemand —</option>` +
    aktive.map((p) => `<option value="${p.id}">${esc(nameVon(p.id))}${p.id === S.userId ? " (ich)" : ""}</option>`).join("") +
    (mitExtern ? `<option value="extern">✏️ Jemand anderes …</option>` : "");
  select.value = gewaehlt || "";
}

function externFeldUmschalten() {
  const extern = $("#a-wer").value === "extern";
  $("#a-extern").hidden = !extern;
  if (!extern) $("#a-extern").value = "";
}
$("#a-wer").addEventListener("change", () => {
  externFeldUmschalten();
  if ($("#a-wer").value === "extern") $("#a-extern").focus();
});

function personenAuswahl(a) {
  personenOptionen($("#a-wer"), a?.zustaendig_extern ? "extern" : a?.zustaendig, true);
  // Vorschläge: externe Namen, die schon einmal vorkamen
  const bekannt = [...new Set(S.aufgaben.map((x) => x.zustaendig_extern).filter(Boolean))].sort((x, y) => x.localeCompare(y, "de"));
  $("#a-extern-liste").innerHTML = bekannt.map((n) => `<option value="${esc(n)}">`).join("");
  externFeldUmschalten();
  $("#a-extern").value = a?.zustaendig_extern || "";
}

function terminAuswahl(gewaehlt) {
  // Kommende Termine und die der letzten 30 Tage, dazu der aktuell gewählte
  const grenze = isoTag(new Date(Date.now() - 30 * 86400000));
  const liste = S.termine.filter((t) => (t.bis_datum || t.datum) >= grenze || t.id === gewaehlt);
  $("#a-termin").innerHTML =
    `<option value="">— keinem Termin —</option>` +
    liste.map((t) => `<option value="${t.id}">${esc(kurzesDatum(t.datum))} – ${esc(t.titel)}${t.extern ? " (extern)" : ""}</option>`).join("") +
    `<option value="__neu">＋ Neuen Termin erstellen</option>`;
  $("#a-termin").value = gewaehlt || "";
  $("#a-termin").dataset.vorher = $("#a-termin").value;
}

// „Neues Projekt / Neuen Termin erstellen“ direkt aus der Auswahlliste.
// Nach dem Speichern wird das Neue in der Liste ausgewählt.
const nachAnlegen = { projekt: null, termin: null };
const neuAusAuswahl = {
  "t-projekt": () => ["projekt", (id) => { projektOptionen($("#t-projekt"), id); titelVorgabeAktualisieren(); }],
  "a-projekt": () => ["projekt", (id) => projektOptionen($("#a-projekt"), id)],
  "a-termin": () => ["termin", (id) => { terminAuswahl(id); projektAnzeigeAktualisieren(); },
    { projekt_id: $("#a-projekt-bereich").hidden ? null : $("#a-projekt").value || null }],
};
document.addEventListener("change", (e) => {
  const sel = e.target;
  if (!(sel instanceof HTMLSelectElement) || !neuAusAuswahl[sel.id]) return;
  if (sel.value !== "__neu") { sel.dataset.vorher = sel.value; return; }
  // Auswahl zurücksetzen, bis das Neue gespeichert ist; andere Reaktionen auf die Änderung unterdrücken
  sel.value = sel.dataset.vorher || "";
  e.stopImmediatePropagation();
  const [art, fertig, vorgabe = {}] = neuAusAuswahl[sel.id]();
  nachAnlegen[art] = fertig;
  if (art === "projekt") oeffneProjekt(null, vorgabe);
  else oeffneTermin(null, vorgabe);
}, true);

// Unterpunkte haben kein eigenes Projekt: Es gilt das Projekt ihres Termins.
let letzterTermin = null;
function projektAnzeigeAktualisieren() {
  const t = terminVon($("#a-termin").value);
  $("#a-projekt-bereich").hidden = !!t;
  const info = $("#a-projekt-vom-termin");
  info.hidden = !t;
  if (t) {
    const p = projektVon(t.projekt_id);
    info.innerHTML = p
      ? `📁 Projekt: <strong>${esc(p.name)}</strong> (vom Termin)`
      : "Der Termin gehört zu keinem Projekt.";
  } else if (letzterTermin) {
    // Vom Termin gelöst: bisheriges Projekt übernehmen, damit nichts aus dem Projekt fällt
    const vorher = terminVon(letzterTermin)?.projekt_id;
    if (vorher && !$("#a-projekt").value) projektOptionen($("#a-projekt"), vorher);
  }
  letzterTermin = t ? t.id : null;
}
$("#a-termin").addEventListener("change", projektAnzeigeAktualisieren);

// Uhrzeit nur zusammen mit einem Datum
function zeitFeldUmschalten() {
  const ohneDatum = !$("#a-faellig").value;
  $("#a-zeit").disabled = ohneDatum;
  if (ohneDatum) $("#a-zeit").value = "";
}
$("#a-faellig").addEventListener("change", zeitFeldUmschalten);
$("#a-faellig").addEventListener("input", zeitFeldUmschalten);

function oeffneAufgabe(a = null, vorgabe = {}) {
  bearbeiteteAufgabe = a;
  $("#aufgabe-ueberschrift").textContent = a ? (a.termin_id ? "Unterpunkt bearbeiten" : "Aufgabe bearbeiten") : "Neue Aufgabe";
  $("#a-titel").value = a?.titel || "";
  personenAuswahl(a);
  $("#a-faellig").value = a?.faellig || "";
  $("#a-zeit").value = uhr(a?.faellig_zeit);
  zeitFeldUmschalten();
  $("#a-status").value = a?.status || "offen";
  $("#a-notiz").value = a?.beschreibung || "";
  terminAuswahl(a ? a.termin_id : vorgabe.termin_id);
  projektOptionen($("#a-projekt"), a ? a.projekt_id : vorgabe.projekt_id);
  letzterTermin = null;
  projektAnzeigeAktualisieren();
  $("#a-loeschen").hidden = !a;
  dA.returnValue = "";
  dA.showModal();
  if (!a && !istTouch()) $("#a-titel").focus();
}

dA.addEventListener("close", async () => {
  if (dA.returnValue !== "speichern") return;
  const daten = {
    titel: $("#a-titel").value.trim(),
    zustaendig: ($("#a-wer").value !== "extern" && $("#a-wer").value) || null,
    zustaendig_extern: $("#a-wer").value === "extern" ? leer($("#a-extern").value) : null,
    faellig: $("#a-faellig").value || null,
    faellig_zeit: ($("#a-faellig").value && $("#a-zeit").value) || null,
    status: $("#a-status").value,
    beschreibung: leer($("#a-notiz").value),
    termin_id: $("#a-termin").value || null,
    // Mit Termin gilt dessen Projekt (die Datenbank erzwingt das ebenfalls)
    projekt_id: $("#a-termin").value ? null : $("#a-projekt").value || null,
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
  const terminSchluessel = (t) => t.datum + (t.start_zeit || "00:00");
  const naechster = termine
    .filter((t) => (t.bis_datum || t.datum) >= h)
    .sort((a, b) => terminSchluessel(a).localeCompare(terminSchluessel(b)))[0] || null;
  // Für Balken und Zählung zählen nur die eigenen Aufgaben des Projekts (ohne Termin);
  // Unterpunkte haben ihren eigenen Balken am Termin.
  const freie = aufgaben.filter((a) => !a.termin_id);
  const freieErledigt = freie.filter((a) => a.status === "erledigt").length;
  const punkteNaechster = naechster ? unterpunkteVon(naechster.id) : [];
  return {
    aufgaben, erledigt, offen: aufgaben.length - erledigt, termine, naechster,
    freie, freieErledigt, freieOffen: freie.length - freieErledigt,
    punkteNaechster, punkteNaechsterErledigt: punkteNaechster.filter((a) => a.status === "erledigt").length,
  };
}

const balken = (anteil) => `<span class="fortschritt" aria-hidden="true"><span style="width:${Math.round(anteil * 100)}%"></span></span>`;
// Balken mit Beschriftung darauf, über die volle Breite
function fortschritt(erledigt, gesamt, wort = "erledigt") {
  const anteil = gesamt ? erledigt / gesamt : 0;
  return `<span class="fortschritt-text${erledigt === gesamt ? " fertig" : ""}" role="img" aria-label="${erledigt} von ${gesamt} ${wort}">
    <span class="fuellung" style="width:${Math.round(anteil * 100)}%"></span>
    <span class="label">☑ ${erledigt} von ${gesamt} ${wort}</span></span>`;
}

function zeichneProjekte() {
  const detail = $("#projekt-detail");
  const uebersicht = $("#projekte-uebersicht");
  const p = projektVon(S.projektOffen);
  if (S.projektOffen && !p) S.projektOffen = null;

  if (!p) {
    detail.hidden = true;
    uebersicht.hidden = false;
    const karte = (x) => {
      const z = projektZahlen(x);
      const wer = nameVon(x.zustaendig);
      const meta = bloecke([
        wer ? `👤 ${esc(wer)}${x.zustaendig === S.userId ? " (ich)" : ""}` : "",
        z.naechster ? `📅 nächster Termin: ${esc(langesDatum(z.naechster.datum))}` : "",
        z.naechster && z.punkteNaechster.length ? `☑ ${z.punkteNaechsterErledigt} von ${z.punkteNaechster.length}` : "",
        !z.freie.length && !z.termine.length ? "noch leer" : "",
        x.abgeschlossen ? "✔ abgeschlossen" : "",
      ]);
      const klasse = x.abgeschlossen ? " ist-abgeschlossen" : x.in_planung ? " ist-planung" : "";
      return `<div class="karte-zeile"><button class="projekt-karte${klasse}" data-projekt="${x.id}">
        <span class="plus-platz" aria-hidden="true"></span>
        <strong>📁 ${esc(x.name)}</strong>
        ${x.beschreibung ? `<span class="beschreibung">${esc(x.beschreibung.length > 120 ? x.beschreibung.slice(0, 120) + " …" : x.beschreibung)}</span>` : ""}
        ${z.freie.length ? fortschritt(z.freieErledigt, z.freie.length, z.freie.length === 1 ? "Aufgabe erledigt" : "Aufgaben erledigt") : ""}
        ${meta ? `<span class="meta">${meta}</span>` : ""}
      </button>
      <button class="dupl-knopf" data-dupl-projekt="${x.id}" aria-label="Projekt „${esc(x.name)}“ duplizieren" title="Duplizieren">＋</button></div>`;
    };
    // Projekte mit kommenden Terminen zuerst, nach dem nächsten Termin; danach die übrigen nach Name
    const sortiert = (liste) => {
      const schluessel = new Map(liste.map((x) => {
        const n = projektZahlen(x).naechster;
        return [x.id, n ? n.datum + (n.start_zeit || "00:00") : null];
      }));
      return liste.sort((a, b) => {
        const sa = schluessel.get(a.id), sb = schluessel.get(b.id);
        if (sa && sb && sa !== sb) return sa.localeCompare(sb);
        if (sa && !sb) return -1;
        if (!sa && sb) return 1;
        return nachText("name")(a, b);
      });
    };
    const laufend = sortiert(S.projekte.filter((x) => !x.abgeschlossen && !x.in_planung));
    const planung = sortiert(S.projekte.filter((x) => !x.abgeschlossen && x.in_planung));
    const fertig = S.zeigeAbgeschlossene ? sortiert(S.projekte.filter((x) => x.abgeschlossen)) : [];

    $("#projekte-liste").innerHTML =
      [...laufend, ...fertig].map(karte).join("") ||
      `<p class="leer">${S.projekte.length ? "Gerade keine laufenden Projekte." : "Noch keine Projekte. Ein Projekt sammelt Termine und Aufgaben, z. B. „Neujahrsempfang“ oder „Wahlkampf“."}</p>`;
    $("#planung-liste").innerHTML =
      planung.map(karte).join("") ||
      `<p class="leer">Hier sammelt ihr Vorhaben, die noch nicht feststehen.</p>`;
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
  const offen = z.freie.filter((a) => a.status !== "erledigt").sort(nachPosition);
  S.listen["projekt-offen"] = offen.map((a) => a.id);
  const fertig = z.freie.filter((a) => a.status === "erledigt");
  const hatUnterpunkte = z.aufgaben.length > z.freie.length;

  detail.innerHTML = `
    <button class="knopf leise" data-aktion="projekte-zurueck">← Alle Projekte</button>
    <div class="karte projekt-kopf karte-zeile">
      <button class="dupl-knopf" data-dupl-projekt="${p.id}" aria-label="Projekt duplizieren" title="Duplizieren">＋</button>
      <h2 style="padding-right:3.2rem">📁 ${esc(p.name)}${p.abgeschlossen ? ' <span class="marke">abgeschlossen</span>' : p.in_planung ? ' <span class="marke planung">in Planung</span>' : ""}</h2>
      ${p.beschreibung ? `<p>${esc(p.beschreibung)}</p>` : ""}
      <p>👤 ${p.zustaendig ? `Zuständig: <strong>${esc(nameVon(p.zustaendig) || "?")}</strong>${p.zustaendig === S.userId ? " (ich)" : ""}` : "Noch niemand zuständig"}</p>
      ${z.freie.length ? `<p>${fortschritt(z.freieErledigt, z.freie.length, z.freie.length === 1 ? "Aufgabe erledigt" : "Aufgaben erledigt")}</p>` : ""}
      ${p.in_planung && !p.abgeschlossen ? `<button class="knopf haupt breit" data-aktion="projekt-starten">▶ Projekt starten</button>` : ""}
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
      ${hatUnterpunkte ? `<p class="klein">Hier stehen die Aufgaben des Projekts ohne Termin. Die Unterpunkte der Termine findet ihr direkt bei den Terminen.</p>` : ""}
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

async function projektStarten(p) {
  const { error } = await sb.from("projekte").update({ in_planung: false }).eq("id", p.id);
  if (error) return meldung("Das hat nicht geklappt.", true);
  meldung("Projekt gestartet – es steht jetzt oben bei den Projekten.");
  await neuLadenUndZeichnen();
}

function oeffneProjekt(p = null, vorgabe = {}) {
  bearbeitetesProjekt = p;
  const planung = p ? !!p.in_planung : !!vorgabe.in_planung;
  $("#projekt-ueberschrift").textContent = p ? "Projekt bearbeiten" : planung ? "Neues Projekt in Planung" : "Neues Projekt";
  $("#p-planung").checked = planung;
  $("#p-name").value = p?.name || "";
  $("#p-beschreibung").value = p?.beschreibung || "";
  $("#p-abgeschlossen").checked = !!p?.abgeschlossen;
  personenOptionen($("#p-zustaendig"), p?.zustaendig);
  $("#p-abgeschlossen-zeile").hidden = !p;
  $("#p-loeschen").hidden = !p;
  dP.returnValue = "";
  dP.showModal();
  if (!p && !istTouch()) $("#p-name").focus();
}

dP.addEventListener("close", async () => {
  if (dP.returnValue !== "speichern") { if (!bearbeitetesProjekt) nachAnlegen.projekt = null; return; }
  const daten = {
    name: $("#p-name").value.trim(),
    beschreibung: leer($("#p-beschreibung").value),
    abgeschlossen: $("#p-abgeschlossen").checked,
    zustaendig: $("#p-zustaendig").value || null,
    in_planung: $("#p-planung").checked,
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
  if (neueId && nachAnlegen.projekt) {
    // Aus einer Auswahlliste angelegt: dort auswählen, nicht zur Projektseite springen
    const f = nachAnlegen.projekt; nachAnlegen.projekt = null;
    await neuLadenUndZeichnen();
    return f(neueId);
  }
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
      zustaendig_extern: a.zustaendig_extern,
      faellig: a.faellig,
      faellig_zeit: a.faellig_zeit,
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
  zeigeLetzteSicherung();
  if (document.activeElement !== $("#mein-name")) $("#mein-name").value = S.ich?.name || "";
  $("#vorstand-liste").innerHTML = S.profile
    .filter((p) => p.aktiv)
    .map((p) => `<li><strong>${esc(p.name ? nameVon(p.id) : "(noch ohne Namen)")}</strong><br>
      ${p.email ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : ""}</li>`)
    .join("");
}

const aboUrl = (token = S.aboToken) => `${cfg.supabaseUrl.replace(/\/$/, "")}/functions/v1/kalender?token=${token}`;

function zeichneAbo() {
  const ok = !!S.aboToken;
  $("#abo-webcal").href = ok ? aboUrl().replace(/^https?:/, "webcal:") : "#";
  $("#abo-kopieren").disabled = !ok;
  $("#teilen-kopieren").disabled = !S.aboTokenTeilen;
}

async function linkKopieren(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.append(ta); ta.select();
    document.execCommand("copy"); ta.remove();
  }
  meldung("Link kopiert.");
}
$("#teilen-kopieren").addEventListener("click", () => linkKopieren(aboUrl(S.aboTokenTeilen)));

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
  const { data, error } = await sb.rpc("abo_token_erneuern", { welcher: 1 });
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
  namenCache.quelle = null;
  zeichneAlles();
  meldung("Vorname gespeichert.");
});

// ------------------------------------------------------------------
//  Datensicherung: herunterladen und wiederherstellen
// ------------------------------------------------------------------
const SICHERUNG_TABELLEN = ["projekte", "termine", "aufgaben"]; // Reihenfolge wegen Verknüpfungen

async function alleZeilen(tabelle) {
  const zeilen = [];
  for (let von = 0; ; von += 1000) {
    const { data, error } = await sb.from(tabelle).select("*").order("id").range(von, von + 999);
    if (error) throw error;
    zeilen.push(...data);
    if (data.length < 1000) return zeilen;
  }
}

function zeigeLetzteSicherung() {
  const el = $("#letzte-sicherung");
  const zuletzt = localStorage.getItem("vorstand-letzte-sicherung");
  if (!zuletzt) {
    el.textContent = "Auf diesem Gerät wurde noch nicht gesichert.";
    el.classList.remove("alt");
    return;
  }
  const tage = -tageBis(zuletzt.slice(0, 10));
  el.textContent = `Letzte Sicherung auf diesem Gerät: ${langesDatum(zuletzt.slice(0, 10))}` +
    (tage === 0 ? " (heute)" : tage === 1 ? " (gestern)" : ` (vor ${tage} Tagen)`);
  el.classList.toggle("alt", tage > 35);
}

$("#sichern").addEventListener("click", async (e) => {
  const knopf = e.currentTarget;
  knopf.disabled = true;
  try {
    const daten = {
      app: "vorstands-app",
      version: 1,
      exportiert_am: new Date().toISOString(),
      exportiert_von: S.ich?.name || S.ich?.email || null,
      profile: S.profile.map(({ id, name, email, aktiv }) => ({ id, name, email, aktiv })),
    };
    for (const t of SICHERUNG_TABELLEN) daten[t] = await alleZeilen(t);

    const name = `vorstand-sicherung-${heute()}.json`;
    const datei = new File([JSON.stringify(daten, null, 2)], name, { type: "application/json" });
    // Auf dem Handy über "Teilen" (z. B. in Dateien oder die Nextcloud-App), sonst normal herunterladen
    const handy = matchMedia("(pointer: coarse)").matches;
    if (handy && navigator.canShare?.({ files: [datei] })) {
      try {
        await navigator.share({ files: [datei], title: "Vorstand – Datensicherung" });
      } catch (err) {
        if (err.name === "AbortError") return; // abgebrochen
        throw err;
      }
    } else {
      const url = URL.createObjectURL(datei);
      const a = Object.assign(document.createElement("a"), { href: url, download: name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
    localStorage.setItem("vorstand-letzte-sicherung", new Date().toISOString());
    zeigeLetzteSicherung();
    meldung(`Gesichert: ${daten.termine.length} Termine, ${daten.aufgaben.length} Aufgaben, ${daten.projekte.length} Projekte.`);
  } catch (err) {
    console.error(err);
    meldung("Die Sicherung hat nicht geklappt.", true);
  } finally {
    knopf.disabled = false;
  }
});

$("#sicherung-datei").addEventListener("change", async (e) => {
  const datei = e.target.files?.[0];
  e.target.value = "";
  if (!datei) return;
  let daten;
  try {
    daten = JSON.parse(await datei.text());
    if (daten.app !== "vorstands-app" || !Array.isArray(daten.termine)) throw new Error("falsches Format");
  } catch {
    return meldung("Das ist keine Sicherungsdatei dieser App.", true);
  }
  const wann = daten.exportiert_am ? langesDatum(daten.exportiert_am.slice(0, 10)) : "unbekannt";
  if (!confirm(
    `Sicherung vom ${wann} wiederherstellen?\n\n` +
    `${daten.termine.length} Termine, ${(daten.aufgaben || []).length} Aufgaben, ${(daten.projekte || []).length} Projekte.\n` +
    "Gelöschtes kommt zurück, Geändertes wird auf den Stand der Sicherung gesetzt. Neuere Einträge bleiben."
  )) return;

  try {
    // Verweise auf Personen, die es nicht mehr gibt, werden geleert
    const personen = new Set(S.profile.map((p) => p.id));
    const person = (id) => (id && personen.has(id) ? id : null);
    const projekte = (daten.projekte || []).map((p) => ({ ...p, zustaendig: person(p.zustaendig), erstellt_von: person(p.erstellt_von) }));
    const projektIds = new Set([...projekte.map((p) => p.id), ...S.projekte.map((p) => p.id)]);
    const termine = daten.termine.map((t) => ({
      ...t,
      erstellt_von: person(t.erstellt_von),
      projekt_id: t.projekt_id && projektIds.has(t.projekt_id) ? t.projekt_id : null,
    }));
    const terminIds = new Set([...termine.map((t) => t.id), ...S.termine.map((t) => t.id)]);
    for (const t of termine) {
      t.zustaendig = person(t.zustaendig);
      if (t.gehoert_zu && !terminIds.has(t.gehoert_zu)) t.gehoert_zu = null;
    }
    const aufgaben = (daten.aufgaben || []).map((a) => ({
      ...a,
      zustaendig: person(a.zustaendig),
      erstellt_von: person(a.erstellt_von),
      projekt_id: a.projekt_id && projektIds.has(a.projekt_id) ? a.projekt_id : null,
      termin_id: a.termin_id && terminIds.has(a.termin_id) ? a.termin_id : null,
    }));

    for (const [tabelle, zeilen] of [["projekte", projekte], ["termine", termine], ["aufgaben", aufgaben]]) {
      for (let i = 0; i < zeilen.length; i += 500) {
        const { error } = await sb.from(tabelle).upsert(zeilen.slice(i, i + 500), { onConflict: "id" });
        if (error) throw error;
      }
    }
    meldung("Sicherung wiederhergestellt.");
    await neuLadenUndZeichnen();
  } catch (err) {
    console.error(err);
    meldung("Wiederherstellen hat nicht geklappt: " + (err.message || err), true);
  }
});

// Start: Falls niemand angemeldet ist, kommt sofort die Anmeldung
const { data: { session } } = await sb.auth.getSession();
if (!session) zeigeAnmeldung();
