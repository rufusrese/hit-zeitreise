# Hit-Zeitreise

Hitster-Variante ohne Karten/QR-Codes: Das Handy spielt über deinen Spotify-Account
einen zufälligen Song, der 1957–2026 in den Top 5 der deutschen Single-Charts war.
Danach tippt man auf **Auflösen** und sieht Jahr, Titel und Interpret.
Jedes Jahr kommt pro Spiel höchstens 3× dran (einstellbar), passend zu den physischen Jahreskarten.

## Voraussetzungen

- **Spotify Premium** (die Web API steuert die Wiedergabe nur bei Premium-Accounts)
- Eine eigene (kostenlose) Spotify-Developer-App für die Client ID
- Die App muss über **HTTPS** erreichbar sein (z. B. GitHub Pages), damit der Login auf dem Handy klappt.
  Lokal am PC geht auch `http://127.0.0.1:8000`.

## Einrichtung

1. App hosten, z. B. mit GitHub Pages: Diesen Ordner in ein Repo pushen →
   *Settings → Pages → Deploy from branch*. Die Adresse ist dann etwa
   `https://<user>.github.io/<repo>/`.
2. Auf <https://developer.spotify.com/dashboard> **Create app**:
   - Redirect URI: genau die Adresse der App, z. B. `https://<user>.github.io/<repo>/`
     (die App zeigt die richtige URI in den Einstellungen an)
   - APIs: **Web API** und **Web Playback SDK** anhaken
3. Client ID kopieren, in der App unter ⚙ eintragen, **Verbinden**.
4. Weitere Mitspieler müssen nicht eingeloggt sein, es spielt nur ein Handy.

## Spielen

- **Spotify-App öffnen** (einmal kurz etwas abspielen), damit das Handy als Gerät auftaucht.
  Alternativ unter ⚙ einen Bluetooth-Lautsprecher, PC oder eine Connect-Box auswählen.
- ▶ spielt einen zufälligen Song. **Nicht auf den Sperrbildschirm schauen**, dort zeigt Spotify den Titel an.
  Wer das vermeiden will, spielt auf einem anderen Gerät ab (Lautsprecher/PC).
- **Auflösen** zeigt Jahr, Titel und Interpret. Erst dann zählt das Jahr.
- **Song überspringen** (vor dem Auflösen): Der Song kommt nicht wieder, das Jahr zählt nicht.
- Unter **Jahreskarten** steht, wie oft jedes Jahr schon vergeben ist.
- Der Spielstand bleibt im Browser gespeichert, auch beim Neuladen. **Neues Spiel** unter ⚙ setzt ihn zurück.

## Daten

`songs.js` enthält 3577 Songs mit Höchstposition 1–5 in den deutschen Single-Charts,
deren erste Chartnotierung zwischen 1957 und 2026 liegt (Quelle: chartsurfer.de, Stand Oktober 2026).

Ausnahme ab 2010: chartsurfer zeigt dort nur noch Platz 1 an. Deshalb sind ab 2010 alle Top-10-Songs
enthalten, außer denen, für die Wikipedia einen Höchstplatz 6–10 belegt. Einzelne Songs ab 2010
waren also „nur“ in den Top 10.
Als Jahr gilt das Jahr der ersten Veröffentlichung bzw. des Charteinstiegs, nicht das Datum
eines späteren Remasters auf Spotify.

Die passenden Spotify-Tracks werden zur Laufzeit über die Suche gefunden (Titel + Interpret,
Live-/Remix-/Karaoke-Versionen werden abgewertet) und im Browser zwischengespeichert.
Findet sich kein passender Track, wird der Song still übersprungen.

`tools/` enthält die Skripte, mit denen die Liste erstellt wurde.
