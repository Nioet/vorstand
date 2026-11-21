# Vorstands-App – Termine & Aufgaben

Eine schlichte Web-App für den Vorstand:

- **Termine** als übersichtliche Liste, mit „Heute“/„Morgen“-Hinweisen
- **Aufgaben** in drei Spalten (Offen · In Arbeit · Erledigt), mit Zuständigen und Fristen, „Mach ich“-Knopf
- **Kalender-Abo**: alle Termine und Aufgaben-Fristen erscheinen automatisch im eigenen Handy-Kalender (iPhone, Android/Google, Outlook)
- **Anmeldung ohne Passwort**: E-Mail-Adresse eingeben → Code aus der E-Mail eintippen (oder auf den Link tippen). Danach bleibt man auf dem Gerät angemeldet.
- Änderungen erscheinen bei allen **sofort**, ohne Neuladen
- Läuft in jedem Browser, auf jedem Handy; lässt sich als „App“ auf den Startbildschirm legen

**Technik:** Supabase (PostgreSQL, Anmeldung, Edge Function) + statische Seite auf GitHub Pages. Kein Build-Schritt, keine Installation – nur Dateien hochladen.

```
index.html, app.js, style.css    → die App
config.js                        → HIER Supabase-Adresse + Schlüssel eintragen
manifest.webmanifest, icon-*     → für „Zum Startbildschirm hinzufügen“
supabase/migrations/…sql         → Datenbank (einmal ausführen)
supabase/functions/kalender/     → Kalender-Abo (.ics)
supabase/email-vorlagen/         → deutsche Anmelde-E-Mail mit Code
.github/workflows/wach-halten.yml→ optional: hält das Gratis-Projekt aktiv
```

---

## Stand für Grüne BK
Bereits erledigt: Supabase-Projekt **„Vorstand“** (Organisation „Grüne BK“, Frankfurt) angelegt, Datenbank eingerichtet, Kalender-Abo deployt, `config.js` ausgefüllt. **Schritte 1, 2, 5 und 6 entfallen also.** Offen sind nur noch 3, 4, 7 und 8.

---

## Einrichtung (ca. 30–45 Minuten, einmalig)

### 1. Supabase-Projekt anlegen
1. Auf [supabase.com](https://supabase.com) ein Konto anlegen → **New project**.
2. **Region: Frankfurt (eu-central-1)** wählen, damit die Daten in Deutschland liegen.
3. Datenbank-Passwort sicher aufbewahren (wird für die App selbst nicht gebraucht).

### 2. Datenbank einrichten
1. Im Dashboard links **SQL Editor** → **New query**.
2. Den kompletten Inhalt von `supabase/migrations/20261121000000_vorstand.sql` einfügen → **Run**.
   Das Skript kann gefahrlos mehrfach ausgeführt werden.

### 3. Anmeldung einstellen
Unter **Authentication**:
1. **Sign In / Providers → Email**: aktiviert lassen.
2. **„Allow new users to sign up“ ausschalten.** So kann sich niemand selbst registrieren – nur Personen, die ihr anlegt, kommen rein.
3. **URL Configuration**: *Site URL* = die Adresse eurer App auf GitHub Pages (siehe Schritt 7, z. B. `https://euer-name.github.io/vorstand/`). Dieselbe Adresse auch unter *Redirect URLs* eintragen.

### 4. E-Mail-Versand (wichtig!)
Ohne eigenen Mailserver verschickt Supabase Anmelde-Mails **nur an Mitglieder eures Supabase-Teams** und nur sehr wenige pro Stunde. Deshalb:

1. **Authentication → Emails → SMTP Settings** → *Enable custom SMTP*.
2. Die Zugangsdaten eines vorhandenen Postfachs eintragen, z. B. des Kreisverbands-Postfachs (Host, Port, Benutzername, Passwort, Absender – stehen in den Einstellungen eures Mail-Anbieters bzw. kommen von der Person, die eure Mails verwaltet).
3. Unter **Authentication → Rate Limits** die Zahl der E-Mails pro Stunde bei Bedarf erhöhen.
4. **Emails → Templates → Magic Link**: Inhalt von `supabase/email-vorlagen/magic-link.html` einfügen, Betreff z. B. `Dein Anmelde-Code: {{ .Token }}`.
   → Die Mail enthält dann **Code und Knopf**. Der Code ist wichtig für alle, die die App vom Startbildschirm aus öffnen (vor allem iPhone), weil der Link sonst im normalen Browser statt in der App landet.

### 5. Kalender-Abo (Edge Function) einrichten
**Variante A – im Dashboard (ohne Programmieren):**
1. **Edge Functions → Deploy a new function → Via Editor**.
2. Name: **`kalender`** (genau so).
3. Den Inhalt von `supabase/functions/kalender/index.ts` einfügen → **Deploy**.
4. In den Einstellungen der Funktion **„Verify JWT“ / „Enforce JWT verification“ ausschalten** – Kalender-Apps können sich nicht anmelden; geschützt ist der Feed stattdessen durch den geheimen Link.
5. Optional unter **Edge Functions → Secrets**: `KALENDER_NAME` = z. B. `Vorstand Grüne Musterstadt` (so heißt der Kalender dann im Handy).

**Variante B – mit der Supabase CLI:**
```bash
supabase link --project-ref <projekt-ref>
supabase db push
supabase functions deploy kalender --no-verify-jwt
supabase secrets set KALENDER_NAME="Vorstand Grüne Musterstadt"
```

### 6. Schlüssel in `config.js` eintragen
Unter **Project Settings → API Keys** (oder oben auf **Connect**):
- **Project URL** → `supabaseUrl`
- **Publishable key** (oder bei älteren Projekten der **anon key**) → `supabaseKey`
- `titel` nach Wunsch, z. B. `"Vorstand Grüne Musterstadt"`

Der Publishable-/anon-Schlüssel darf öffentlich im Code stehen: Ohne Anmeldung lässt die Datenbank niemanden etwas lesen oder schreiben. **Den „secret“ bzw. „service_role“-Schlüssel niemals in die App schreiben!**

### 7. Auf GitHub Pages veröffentlichen
1. Auf GitHub ein neues Repository anlegen (z. B. `vorstand`). Es darf öffentlich sein – es stehen keine Geheimnisse drin.
2. Alle Dateien dieses Ordners hochladen (**Add file → Upload files**, auch den Ordner `.github`, falls ihr das Wachhalten nutzen wollt).
3. **Settings → Pages → Source: Deploy from a branch → Branch: `main` / `(root)`** → Save.
4. Nach ein bis zwei Minuten läuft die App unter `https://<euer-name>.github.io/vorstand/`.
5. Diese Adresse in Supabase als *Site URL* eintragen (Schritt 3), falls noch nicht geschehen.

### 8. Vorstandsmitglieder freischalten
**Authentication → Users → Add user → Create new user**
- E-Mail-Adresse eintragen, irgendein Passwort (wird nie gebraucht), **„Auto Confirm User“ anhaken**.
- Den Namen trägt jede Person beim ersten Anmelden selbst ein (oder ihr tragt ihn in der Tabelle `profiles` ein).

Dann den Link zur App an alle schicken – fertig.

### 9. Optional: Gratis-Projekt wach halten
Kostenlose Supabase-Projekte werden nach etwa einer Woche ohne Nutzung pausiert. Die Datei `.github/workflows/wach-halten.yml` ruft einmal täglich den Kalender ab:
- Im GitHub-Repo **Settings → Secrets and variables → Actions → New repository secret**
- Name `KALENDER_URL`, Wert: der Abo-Link aus der App (Bereich „Mehr“ → „Link kopieren“).

---

## Im Alltag

| Was | Wie |
|---|---|
| Jemand Neues kommt in den Vorstand | Schritt 8 |
| Jemand verlässt den Vorstand | In der Tabelle `profiles` bei der Person `aktiv` auf `false` setzen (Einträge bleiben erhalten) – oder unter Authentication → Users löschen. **Danach in der App unter „Mehr“ einen neuen Kalender-Link erzeugen** und den anderen Bescheid geben. |
| Code kommt nicht an | Spam-Ordner prüfen; in Supabase unter *Authentication → Logs* nachsehen; SMTP-Daten prüfen. |
| Google Kalender zeigt Änderungen spät | Normal: Google aktualisiert abonnierte Kalender nur alle paar Stunden. iPhone und Outlook sind schneller. |
| App-Name auf dem Startbildschirm ändern | In `manifest.webmanifest` und `index.html` („apple-mobile-web-app-title“) `Vorstand` ersetzen. |

## Datenschutz
- Daten liegen bei Supabase in Frankfurt; Supabase bietet einen Auftragsverarbeitungsvertrag (DPA) an – den solltet ihr abschließen.
- Gespeichert werden nur Namen und E-Mail-Adressen des Vorstands, Termine und Aufgaben. **Bitte keine Mitgliederdaten** in Termine oder Notizen schreiben.
- Der Kalender-Link ist ein Geheimnis: Wer ihn hat, sieht Termine und Aufgaben (nur lesend). Deshalb beim Ausscheiden von Personen erneuern.

## Ideen für später
- Wiederkehrende Termine (z. B. „jeden ersten Dienstag“)
- Kommentare an Aufgaben
- Öffentlicher Zweit-Kalender für Mitglieder (nur ausgewählte Termine)
- E-Mail-Erinnerung an fällige Aufgaben
