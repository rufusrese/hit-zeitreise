import json, re, sys, os, hashlib, time, urllib.request, urllib.parse, urllib.error, unicodedata
UA = "HitZeitreiseBuilder/1.1 (hobby project, one request per second)"
CACHE = "wpcache2"; os.makedirs(CACHE, exist_ok=True)

def api(host, params):
    params = {**params, "format": "json", "formatversion": "2"}
    url = f"https://{host}/w/api.php?" + urllib.parse.urlencode(params)
    fn = os.path.join(CACHE, hashlib.md5(url.encode()).hexdigest())
    if os.path.exists(fn): return json.load(open(fn))
    for a in range(30):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=30) as r:
                j = json.load(r)
            json.dump(j, open(fn, "w")); time.sleep(1); return j
        except urllib.error.HTTPError as e:
            wait = int(e.headers.get("Retry-After") or 20) if e.code == 429 else 5
            print("http", e.code, "wait", wait, flush=True); time.sleep(min(wait, 120) + 1)
        except Exception as e:
            print("err", e, flush=True); time.sleep(5)
    raise SystemExit("aufgegeben: zu viele Fehler")

def norm(s):
    s = unicodedata.normalize("NFKD", s.lower()); s = re.sub(r"\(.*?\)|\[.*?\]", " ", s)
    return re.sub(r"[^a-z0-9]+", " ", s).strip()

def first_artist(a):
    return re.split(r"\s+(?:feat\.?|ft\.?|featuring|with|vs\.?|x|&|und|and|mit)\s+|\s*,\s*", a, flags=re.I)[0]

def pages(host, q):
    j = api(host, {"action": "query", "generator": "search", "gsrsearch": q, "gsrlimit": 3,
                   "prop": "revisions", "rvprop": "content", "rvslots": "main", "redirects": 1})
    ps = sorted(j.get("query", {}).get("pages", []), key=lambda p: p.get("index", 99))
    return [(p["title"], p["revisions"][0]["slots"]["main"]["content"]) for p in ps if "revisions" in p]

def de_peak(title, artist, weeks):
    t1 = title.split(" / ")[0]; nt = norm(t1)
    for pt, txt in pages("de.wikipedia.org", f"{t1} {first_artist(artist)}"):
        hits = [(int(a), int(b)) for a, b in re.findall(r"\{\{\s*Charts\s*\|\s*DEU-S\s*\|\s*(\d+)\s*\|\s*(\d+)", txt)]
        if not hits: continue
        good = [h for h in hits if abs(h[1] - weeks) <= 2]
        title_ok = norm(pt).startswith(nt) or nt.startswith(norm(re.sub(r"\(.*?\)", "", pt)) or "#")
        if len(good) == 1 and (title_ok or len(hits) <= 3): return good[0][0], "de:" + pt
        if title_ok and len(hits) == 1: return hits[0][0], "de?:" + pt
    return None

def en_peak(title, artist):
    t1 = title.split(" / ")[0]; fa = first_artist(artist); nt, nfa = norm(t1), norm(fa)
    for pt, txt in pages("en.wikipedia.org", f"{t1} {fa} song"):
        for m in re.finditer(r"\{\{\s*single ?chart\s*\|\s*Germany\d?\s*\|\s*(\d+)\s*([^}]*)\}\}", txt, re.I):
            song = re.search(r"\|\s*song\s*=\s*([^|}]*)", m.group(2)); art = re.search(r"\|\s*artist\s*=\s*([^|}]*)", m.group(2))
            if song and art and norm(song.group(1)) == nt and nfa and nfa in norm(art.group(1)):
                return int(m.group(1)), "en:" + pt
    return None

raw = json.load(open("raw.json"))
todo = [s for s in raw if s["info"]["peak"] is None]
t0 = time.time()
for n, s in enumerate(todo, 1):
    s["wp"] = de_peak(s["title"], s["artist"], s["info"]["weeks"]) or en_peak(s["title"], s["artist"])
    if n % 50 == 0:
        json.dump(raw, open("raw2.json", "w"), ensure_ascii=False)
        print(f"{n}/{len(todo)} gefunden={sum(1 for x in todo[:n] if x['wp'])} {time.time()-t0:.0f}s", flush=True)
json.dump(raw, open("raw2.json", "w"), ensure_ascii=False)
print("FERTIG", len(todo), "gefunden", sum(1 for s in todo if s["wp"]), "top5", sum(1 for s in todo if s["wp"] and s["wp"][0] <= 5), flush=True)
