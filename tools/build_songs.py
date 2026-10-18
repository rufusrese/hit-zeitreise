"""Erzeugt songs.js aus der Ausgabe von scrape_chartsurfer.py.

Aufnahme: Höchstposition 1–5 in DE, Jahr zwischen 1957 und 2026.
Ab 2010 zeigt chartsurfer nur Platz 1 an; für die übrigen Top-10-Songs wird die
Höchstposition (soweit vorhanden) aus Wikipedia genommen, sonst wird der Song aufgenommen.
Jahr = Jahr der ersten DE-Chartnotierung; liegt die früheste bekannte
Veröffentlichung 1–2 Jahre davor (z. B. Dezember-Release, später Hit),
wird das Veröffentlichungsjahr genommen.
"""
import json, re, sys, unicodedata

MIN_Y, MAX_Y, MAX_PEAK = 1957, 2026, 5

# Alte Songs, die erst Jahre später in DE in die Top 5 kamen: Originaljahr verwenden.
YEAR_OVERRIDES = {
    ("Sam Cooke", "Wonderful World"): 1960,
    ("Mama Cass With The Mamas & The Papas", "Dream A Little Dream Of Me"): 1968,
    ("Chris Rea", "Driving Home For Christmas"): 1986,
    ("Jose Feliciano", "Feliz Navidad"): 1970,
    ("Monty Python", "Always Look On The Bright Side Of Life"): 1979,
    ("Jeanette Dimech", "Porque Te Vas"): 1974,
}


def key(artist, title):
    s = unicodedata.normalize("NFKD", (artist + "|" + title).lower())
    return re.sub(r"[^a-z0-9|]+", "", s)


def main(src, dst):
    raw = json.load(open(src, encoding="utf-8"))
    out, seen, missing = [], {}, 0
    for s in raw:
        info = s.get("info")
        if not info:
            missing += 1
            continue
        peak = info["peak"]
        if peak is None and s.get("wp"):  # chartsurfer verbirgt DE-Platz 2–100 ab 2010 -> Wikipedia
            peak = s["wp"][0]
        if peak is None:  # Platz unbekannt, aber laut chartsurfer Top 10 -> aufnehmen
            peak = MAX_PEAK
        if not peak or peak > MAX_PEAK or not info["firstYear"]:
            continue
        year = info["firstYear"]
        rel = info.get("minRelease")
        if rel and year - 2 <= rel < year:
            year = rel
        year = YEAR_OVERRIDES.get((s["artist"], s["title"]), year)
        if not MIN_Y <= year <= MAX_Y:
            continue
        k = key(s["artist"], s["title"])
        if k in seen and seen[k][0] <= year:
            continue
        seen[k] = [year, s["artist"], s["title"]]
    out = sorted(seen.values())
    with open(dst, "w", encoding="utf-8") as f:
        f.write("// Generiert von tools/build_songs.py – [Jahr, Interpret, Titel]\n")
        f.write("window.SONGS = [\n")
        f.write(",\n".join(json.dumps(x, ensure_ascii=False) for x in out))
        f.write("\n];\n")
    print(f"{len(out)} Songs, {missing} ohne Daten", file=sys.stderr)


main(*sys.argv[1:3])
