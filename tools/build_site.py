#!/usr/bin/env python3
"""LORPcade site generator. Standard library only.

    python3 tools/build_site.py [--out _site]

Games are prebuilt: any folder that has an index.html is a game, and it is published as is
at /<folder-name>/. Looked for in two places, so use whichever you prefer:
    <repo>/<game>/index.html          (a folder at the top level of the repo)
    <repo>/games/<game>/index.html    (a folder inside games/)

An optional game.json next to the index.html sets the title, blurb, colour etc. (see README).
Nothing is compiled here; this only writes the home screen and copies the game folders.
"""
import argparse
import colorsys
import hashlib
import html
import json
import os
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE_SRC = Path(__file__).resolve().parent / "site"
ASSETS = "arcade-assets"  # the home screen's own files; can't be used as a game name
SLUG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
# Cabinet images picked up automatically, in priority order: cover.* first (cover.webp is what a game's build.bat makes:
# 512x512, quality 75), then the older thumb.* names.
COVERS = tuple(f"{stem}.{ext}" for stem in ("cover", "thumb") for ext in ("webp", "jpg", "jpeg", "png", "gif"))
KNOWN_KEYS = {"title", "accent", "order", "hidden", "thumbnail", "highscore"}  # everything else in game.json is ignored
MENU_MUSIC = "main_menu.opus"  # tools/site/music/main_menu.opus -> played on the home screen when Sound is on
HEX_RE = re.compile(r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
NOT_GAMES = {"tools", "games", ASSETS, "node_modules"}  # top-level folders never treated as games
RESERVED_SLUGS = {"sync", "backup", "hiscore", "profile"}  # would collide with the cloud-save keys (lorpcade:sync:..., see README)
SYNC_FILES = ("lorpcade-sync.js", "sync-config.json")  # tools/site/ -> <site>/arcade-assets/ (shared by the home screen and every game)


def die(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def warn(msg):
    print(f"warning: {msg}", file=sys.stderr)


# ---------------------------------------------------------------- detection

def discover():
    """-> {slug: folder}. A game is a folder containing index.html."""
    found = {}
    for base in (ROOT, ROOT / "games"):
        if not base.is_dir():
            continue
        for p in sorted(base.iterdir()):
            if not p.is_dir() or p.name.startswith((".", "_")) or not (p / "index.html").is_file():
                continue
            if base == ROOT and p.name in NOT_GAMES:
                continue
            if p.name in RESERVED_SLUGS:
                warn(f"skipping {p.relative_to(ROOT)}: '{p.name}' is reserved by the cloud-save keys; rename the folder")
                continue
            if not SLUG_RE.match(p.name) or p.name == ASSETS:
                warn(f"skipping {p.relative_to(ROOT)}: folder names may only use letters, digits, '_' and '-' "
                     f"(and can't be '{ASSETS}')")
                continue
            if p.name in found:
                die(f"two game folders are both called '{p.name}': {found[p.name].relative_to(ROOT)} and "
                    f"{p.relative_to(ROOT)}")
            found[p.name] = p
    return found


# ---------------------------------------------------------------- manifest

def auto_accent(slug):
    hue = int(hashlib.sha1(slug.encode()).hexdigest()[:4], 16) % 360
    r, g, b = colorsys.hls_to_rgb(hue / 360, 0.6, 1.0)
    return "#%02x%02x%02x" % (round(r * 255), round(g * 255), round(b * 255))


def norm_hex(value):
    if not isinstance(value, str) or not HEX_RE.match(value):
        return None
    v = value.lower()
    return "#" + "".join(c * 2 for c in v[1:]) if len(v) == 4 else v


def load_game(slug, folder):
    raw = {}
    mf = folder / "game.json"
    if mf.is_file():
        try:
            raw = json.loads(mf.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            die(f"{mf.relative_to(ROOT)} is not valid JSON: {e}")
        if not isinstance(raw, dict):
            die(f"{mf.relative_to(ROOT)} must be a JSON object")

    def text(key):
        v = raw.get(key)
        return v.strip() if isinstance(v, str) else ""

    ignored = sorted(set(raw) - KNOWN_KEYS)
    if ignored:
        warn(f"{slug}/game.json: ignoring {', '.join(ignored)} (the home screen only shows name, cover and high score)")

    if raw.get("accent") and not norm_hex(raw["accent"]):
        warn(f"{slug}/game.json: 'accent' should look like #ff2e97; using an automatic colour")

    thumb = None  # path relative to the game folder (it is published along with the game)
    wanted = ([raw["thumbnail"]] if isinstance(raw.get("thumbnail"), str) else []) + list(COVERS)
    for name in wanted:
        if (folder / name).is_file():
            thumb = name.replace("\\", "/").lstrip("/")
            break

    # Optional: where this game keeps its best score in localStorage (see README, "High scores").
    hs, hiscore = raw.get("highscore"), None
    if isinstance(hs, str) and hs.strip():
        hs = {"key": hs.strip()}
    if isinstance(hs, dict) and isinstance(hs.get("key"), str) and hs["key"].strip():
        digits = hs.get("digits", 6)
        hiscore = {
            "key": hs["key"].strip(),
            "field": hs["field"].strip() if isinstance(hs.get("field"), str) else "",
            "digits": max(0, min(12, digits)) if isinstance(digits, int) and not isinstance(digits, bool) else 6,
        }
    elif hs is not None:
        warn(f"{slug}/game.json: 'highscore' should be a localStorage key, or an object with a \"key\"; ignoring it")

    order = raw.get("order", 100)
    return {
        "slug": slug,
        "title": text("title") or slug.replace("_", " ").replace("-", " ").title(),
        "accent": norm_hex(raw.get("accent")) or auto_accent(slug),
        "order": order if isinstance(order, (int, float)) else 100,
        "hidden": raw.get("hidden") is True,
        "thumb": thumb,
        "hiscore": hiscore,
        # the native Windows build, if the game ships one: <slug>/<slug>.exe next to the wasm (see README)
        "exe": f"{slug}.exe" if (folder / f"{slug}.exe").is_file() else None,
    }


# ---------------------------------------------------------------- rendering

# The white Windows logo, 90s style (the waving four-pane flag). One colour only: white (the page adds a hard dark shadow).
WIN_LOGO = (
    '<svg class="winlogo" viewBox="0 0 32 32" aria-hidden="true" focusable="false">'
    '<path fill="#fff" d="M3 6.2c3.6-1.7 6.6-1.4 10.4.4v8.1c-3.8-1.8-6.8-2.1-10.4-.4z"/>'
    '<path fill="#fff" d="M15.4 7.5c3.7 1.7 7.4 1.7 13.6-1.3v8.1c-6.2 3-9.9 3-13.6 1.2z"/>'
    '<path fill="#fff" d="M3 17.4c3.6-1.7 6.6-1.4 10.4.4v8.1c-3.8-1.8-6.8-2.1-10.4-.4z"/>'
    '<path fill="#fff" d="M15.4 18.8c3.7 1.7 7.4 1.7 13.6-1.3v8.1c-6.2 3-9.9 3-13.6 1.2z"/>'
    '</svg>'
)


def render_card(game):
    e = html.escape
    if game["thumb"]:
        art = f'<img class="art-img" src="{game["slug"]}/{e(game["thumb"])}" alt="" loading="lazy">'
    else:
        art = '<div class="art-gen" aria-hidden="true"><i class="sun"></i><i class="floor"></i></div>'
    hs = game["hiscore"]
    hi_attrs = f' data-slug="{e(game["slug"])}"'
    if hs:
        hi_attrs += f' data-hi-key="{e(hs["key"])}" data-hi-digits="{hs["digits"]}"'
        if hs["field"]:
            hi_attrs += f' data-hi-field="{e(hs["field"])}"'
    hi_digits = hs["digits"] if hs else 6
    hi_zero = "0" * hi_digits if hi_digits else "0"      # shown until the game has saved a score
    exe = ""
    if game["exe"]:
        # a sibling of the cabinet link, not inside it (a link may not contain a link); the page's CSS lifts it with the cabinet
        exe = (f'<a class="exe" href="{e(game["slug"])}/{e(game["exe"])}" download style="--accent:{game["accent"]}" '
               f'title="Download the Windows version (.exe)" aria-label="Download {e(game["title"])} for Windows">{WIN_LOGO}</a>')
    return f"""
      <li class="slot">
        <a class="cab" href="{game["slug"]}/" style="--accent:{game["accent"]}"{hi_attrs}>
          <div class="frame"><div class="cab-in">
            <span class="sr">{e(game["title"])}</span>
            <div class="bezel"><div class="screen">{art}<span class="glass" aria-hidden="true"></span></div></div>
            <div class="deck">HI <b class="hi-val">{hi_zero}</b></div>
          </div></div>
        </a>{exe}
      </li>"""


EMPTY = ('<li class="empty"><p>No games on the floor yet.</p>'
         '<p>Add a game folder with an <code>index.html</code> and push to the main branch.</p></li>')


def publish_sync(out: Path):
    """Cloud saves: copy the shared script and its Firebase config next to the fonts. Without a real config the
    scripts still publish, but the site shows no SYNC button and games skip syncing (see instruction.md)."""
    for name in SYNC_FILES:
        src = SITE_SRC / name
        if not src.is_file():
            warn(f"tools/site/{name} is missing: cloud saves will be unavailable")
            return
    for name in SYNC_FILES:
        shutil.copy2(SITE_SRC / name, out / ASSETS / name)
    try:
        cfg = json.loads((SITE_SRC / "sync-config.json").read_text(encoding="utf-8"))
        real = all(isinstance(cfg.get(k), str) and cfg[k].strip() and not cfg[k].strip().upper().startswith("YOUR_") for k in ("projectId", "apiKey"))
    except (json.JSONDecodeError, AttributeError):
        die("tools/site/sync-config.json is not valid JSON")
    print("  sync  cloud saves ON  (arcade-assets/lorpcade-sync.js)" if real else
          "  sync  cloud saves OFF: fill in tools/site/sync-config.json (see instruction.md)")


def build(out: Path):
    found = discover()
    games = [load_game(slug, folder) for slug, folder in found.items()]
    listed = sorted((g for g in games if not g["hidden"]), key=lambda g: (g["order"], g["title"].lower()))

    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    for slug, folder in found.items():
        shutil.copytree(folder, out / slug, ignore=shutil.ignore_patterns(".git", ".git*", ".DS_Store"))
        print(f"  game  {slug:<24} <- {folder.relative_to(ROOT)}/")

    shutil.copytree(SITE_SRC / "fonts", out / ASSETS / "fonts")

    music = ""
    if (SITE_SRC / "music" / MENU_MUSIC).is_file():
        shutil.copytree(SITE_SRC / "music", out / ASSETS / "music")
        music = f"{ASSETS}/music/{MENU_MUSIC}"
        print(f"  music {music}")
    else:
        print(f"  music none (add tools/site/music/{MENU_MUSIC} for home screen music; see README)")

    publish_sync(out)

    page = (SITE_SRC / "index.template.html").read_text(encoding="utf-8")
    for token, value in {
        "{{CARDS}}": "".join(render_card(g) for g in listed) or EMPTY,
        "{{GAME_COUNT}}": f"{len(listed):02d}",
        "{{MUSIC}}": html.escape(music),
    }.items():
        page = page.replace(token, value)
    (out / "index.html").write_text(page, encoding="utf-8")
    print(f"  home  {len(listed)} game(s) listed, {len(games) - len(listed)} hidden -> {out}/index.html")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=ROOT / "_site")
    build(ap.parse_args().out)


if __name__ == "__main__":
    main()
