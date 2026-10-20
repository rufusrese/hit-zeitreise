# Hit-Zeitreise

Hitster-Variante mit eigenem Server: Songs hören, Jahr raten. Läuft unter
<https://hit-zeitreise.duckdns.org>.

## Funktionen

- **Accounts:** Registrierung mit Benutzername und Passwort. Der erste Account wird Admin.
- **Spotify:** Jeder Nutzer verbindet sein eigenes Spotify (Premium). Abgespielt wird direkt im Browser
  (Web Playback SDK) oder auf einem Spotify-Gerät.
- **Kataloge:** Der Katalog „Deutsche Top-5-Hits 1957–2026“ (3577 Songs) steht allen zur Verfügung.
  Eigene Kataloge legt man an per CSV-Import, per Spotify-Suche oder durch manuelles Eintragen.
  Kataloge lassen sich mit anderen Nutzern teilen (nur lesen) und kopieren.
- **Spielen:** Zufälliger Song aus einem Katalog, Auflösen zeigt Jahr, Titel und Interpret.
  Pro Spiel kommt jedes Jahr höchstens N-mal dran (Standard 3).
- **Karten drucken:** PDF mit 6, 12, 20 oder 30 Karten (8,5 / 6,5 / 4,8 / 3,8 cm) pro A4-Blatt. Vorderseite mit QR-Code,
  Rückseite gespiegelt mit Jahr, Interpret und Titel, dazu Schnittlinien. Man wählt eine Anzahl
  Blätter, die Songs werden zufällig gezogen und als gedruckt gemerkt. Beim nächsten Mal kommen
  nur noch ungedruckte Songs.
- **QR-Scanner:** Unter „Scannen“ oder mit der Kamera-App des Handys. Die Karte öffnet
  `/k/<id>` und spielt den Song ab.

## CSV-Format

Spalten `Titel`, `Interpret`, `Erscheinungsjahr` und optional `Spotify` (Link oder URI).
Als Trennzeichen gehen `;`, `,` oder Tab. Die Kopfzeile darf fehlen, dann gilt diese Reihenfolge.
Als Jahr ist auch ein Datum wie `1984-05-01` oder `01.05.1984` erlaubt.

## Spotify einrichten

Eine Spotify-App im Entwicklungsmodus erlaubt **maximal 5 Spotify-Nutzer**. Jeder davon muss im
Dashboard unter *User Management* eingetragen sein.

1. Auf <https://developer.spotify.com/dashboard> in der App die Redirect URI
   `https://hit-zeitreise.duckdns.org/` hinzufügen. APIs: Web API und Web Playback SDK.
2. Als Admin in der App unter **Mehr → Admin** die Client ID als Standard eintragen.
3. Wer nicht in die 5 Plätze passt, legt eine eigene Spotify-App an und trägt deren Client ID
   unter **Mehr → Eigene Spotify-App verwenden** ein.

## Betrieb

- Server: `ubuntu@164.30.74.140`, App in `/opt/hit-zeitreise` (Docker-Container `hit-zeitreise`
  im Netz `caddy_net`). Die Daten (SQLite) liegen in `/opt/hit-zeitreise/data`.
- Caddy: Block `hit-zeitreise.duckdns.org` in `/opt/caddy/Caddyfile`, leitet auf `hit-zeitreise:3000`.
- Update ausrollen: `./deploy.sh` (rsync und `docker compose up -d --build`).
- Lokal starten: `npm install`, dann `npm run dev` (Port 3000).

## Daten des Standard-Katalogs

`seed/top5.json`: Songs mit Höchstposition 1–5 in den deutschen Single-Charts, Erstnotierung
1957–2026 (Quelle: chartsurfer.de, Stand Oktober 2026). Ab 2010 zeigt chartsurfer nur Platz 1,
deshalb sind ab dort alle Top-10-Songs enthalten, außer denen, für die Wikipedia Platz 6–10 belegt.
Die Skripte dazu liegen in `tools/`.
