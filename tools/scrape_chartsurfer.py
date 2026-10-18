import re, html, os, sys, json, time, hashlib, urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = "https://www.chartsurfer.de"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36"
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")
os.makedirs(CACHE, exist_ok=True)


def get(path):
    fn = os.path.join(CACHE, hashlib.md5(path.encode()).hexdigest() + ".html")
    if os.path.exists(fn):
        return open(fn, encoding="utf-8").read()
    for attempt in range(5):
        try:
            req = urllib.request.Request(BASE + path, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                s = r.read().decode("utf-8", "replace")
            open(fn, "w", encoding="utf-8").write(s)
            time.sleep(0.2)
            return s
        except Exception as e:
            print("retry", path, e, file=sys.stderr)
            time.sleep(3 * (attempt + 1))
    return ""


def text(s):
    s = re.sub(r"<script.*?</script>", "", s, flags=re.S)
    t = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", html.unescape(t))


ITEM = re.compile(r'<div><a class="style-1 font-weight-bold" href="(/artist/[^"]+)">(.*?)</a> von (.*?)</div>')


def year_songs(y):
    out, page = [], 1
    while True:
        p = f"/archiv/single-charts-deutschland/{y}_top10" + ("" if page == 1 else f"-{page}")
        s = get(p)
        items = ITEM.findall(s)
        out += [(u, html.unescape(t).strip(), html.unescape(re.sub(r"<[^>]+>", "", a)).strip()) for u, t, a in items]
        if f'{y}_top10-{page + 1}"' not in s:
            break
        page += 1
    return out


def song_info(url):
    t = text(get(url))
    m = re.search(r"Deutschland Wochen Gesamt (\d+) Top-10 Wochen (\d+) Nr\.1 Wochen (\d+) Erste Notierung: (\S+) Letzte Notierung: (\S+) H\S+: (\S+)", t)
    if not m:
        return None
    rel = [int(x) for x in re.findall(r"\[(?:\d\d\.\d\d\.)?(\d{4}) ", t)]
    first = m.group(4)
    return {
        "peak": int(m.group(6)) if m.group(6).isdigit() else None,
        "first": first,
        "firstYear": int(first[-4:]) if re.match(r"\d\d\.\d\d\.\d{4}", first) else None,
        "minRelease": min(rel) if rel else None,
        "weeks": int(m.group(1)),
    }


def main():
    years = range(1957, 2027)
    songs = {}
    with ThreadPoolExecutor(4) as ex:
        for y, lst in zip(years, ex.map(year_songs, years)):
            print(y, len(lst), file=sys.stderr)
            for u, t, a in lst:
                songs.setdefault(u, {"url": u, "title": t, "artist": a})
    urls = list(songs)
    print("songs", len(urls), file=sys.stderr)
    done = 0
    with ThreadPoolExecutor(4) as ex:
        for u, info in zip(urls, ex.map(song_info, urls)):
            songs[u]["info"] = info
            done += 1
            if done % 200 == 0:
                print("done", done, file=sys.stderr)
    json.dump(list(songs.values()), open(sys.argv[1], "w"), ensure_ascii=False, indent=0)


main()
