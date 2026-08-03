#!/usr/bin/env python3
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DATA_URL = "https://v2fy.com/asset/0i/ChineseBQB/chinesebqb_v2fy.json"
DEFAULT_CACHE = Path.home() / ".cache" / "bqb-downloader" / "bqb_dataset.json"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def open_url(req, timeout):
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.URLError as exc:
        retry_req = urllib.request.Request(
            req.full_url,
            headers=dict(req.header_items()),
            method=req.get_method(),
        )
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        return opener.open(retry_req, timeout=timeout)


def fetch_text(url, timeout=30):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 bqb-downloader/1.0",
            "Accept": "application/json,image/*,*/*;q=0.8",
        },
    )
    with open_url(req, timeout=timeout) as response:
        return response.read().decode("utf-8")


def quote_url(url):
    parts = urllib.parse.urlsplit(url)
    path = urllib.parse.quote(urllib.parse.unquote(parts.path), safe="/%")
    query = urllib.parse.quote(urllib.parse.unquote(parts.query), safe="=&?/:,%")
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, path, query, parts.fragment))


def load_dataset(cache_path, refresh_cache):
    cache_path = Path(cache_path).expanduser()
    if cache_path.exists() and not refresh_cache:
        return json.loads(cache_path.read_text(encoding="utf-8"))

    text = fetch_text(DATA_URL)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(text, encoding="utf-8")
    return json.loads(text)


def default_output_dir():
    home = Path.home()
    candidates = [
        home / "Desktop",
    ]

    for env_name in ("OneDrive", "OneDriveConsumer", "OneDriveCommercial"):
        env_value = os.environ.get(env_name)
        if env_value:
            candidates.append(Path(env_value) / "Desktop")

    for desktop in candidates:
        if desktop.exists():
            return desktop / "bqb-downloads"

    return home / "bqb-downloads"


def normalize(value):
    return (value or "").casefold()


def file_extension(name, url):
    parsed = urllib.parse.urlparse(url)
    candidates = [name, urllib.parse.unquote(Path(parsed.path).name)]
    for candidate in candidates:
        suffix = Path(candidate).suffix
        if suffix and 1 < len(suffix) <= 8:
            return suffix
    return ".img"


def safe_filename(name, url, index):
    decoded = urllib.parse.unquote(name or "")
    decoded = decoded.strip() or f"bqb-{index:04d}{file_extension(name, url)}"
    decoded = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", decoded)
    decoded = re.sub(r"\\s+", " ", decoded).strip(" .")
    if not Path(decoded).suffix:
        decoded += file_extension(name, url)
    return decoded[:180]


def unique_path(directory, filename):
    path = directory / filename
    if not path.exists():
        return path

    stem = path.stem
    suffix = path.suffix
    for i in range(2, 10000):
        candidate = directory / f"{stem}-{i}{suffix}"
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"Could not create a unique filename for {filename}")


def match_items(items, keywords, filename_only):
    terms = [normalize(x) for x in keywords if x.strip()]
    if not terms:
        return []

    matched = []
    for item in items:
        name = normalize(item.get("name"))
        category = normalize(item.get("category"))
        haystack = name if filename_only else f"{name} {category}"
        if all(term in haystack for term in terms):
            matched.append(item)
    return matched


def download_file(url, output_path, timeout=45, retries=2):
    req = urllib.request.Request(
        quote_url(url),
        headers={
            "User-Agent": "Mozilla/5.0 bqb-downloader/1.0",
            "Accept": "image/*,*/*;q=0.8",
        },
    )
    last_error = None
    for attempt in range(retries + 1):
        try:
            with open_url(req, timeout=timeout) as response:
                data = response.read()
            output_path.write_bytes(data)
            return len(data)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_error = exc
            if attempt < retries:
                time.sleep(0.8 * (attempt + 1))
    raise last_error


def main():
    parser = argparse.ArgumentParser(
        description="Search and optionally download Chinese meme images by keyword."
    )
    parser.add_argument("keyword", nargs="+", help="Keyword(s) to search. Multiple words use AND matching.")
    parser.add_argument("--limit", type=int, default=20, help="Maximum matches to return/download.")
    parser.add_argument("--out", default=None, help="Output directory for downloaded files. Defaults to ~/Desktop/bqb-downloads.")
    parser.add_argument("--no-download", action="store_true", help="Only print matched records.")
    parser.add_argument("--filename-only", action="store_true", help="Only match the image filename.")
    parser.add_argument("--json-cache", default=str(DEFAULT_CACHE), help="Dataset cache path.")
    parser.add_argument("--refresh-cache", action="store_true", help="Force refresh of cached JSON.")
    args = parser.parse_args()

    try:
        dataset = load_dataset(args.json_cache, args.refresh_cache)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"failed to load dataset: {exc}"}, ensure_ascii=False), file=sys.stderr)
        return 2

    items = dataset.get("data") or []
    matches = match_items(items, args.keyword, args.filename_only)
    selected = matches[: max(args.limit, 0)]

    output_dir = Path(args.out).expanduser().resolve() if args.out else default_output_dir().resolve()
    if not args.no_download:
        output_dir.mkdir(parents=True, exist_ok=True)

    results = []
    for index, item in enumerate(selected, start=1):
        result = {
            "name": item.get("name"),
            "category": item.get("category"),
            "url": item.get("url"),
        }

        if args.no_download:
            result["status"] = "matched"
        else:
            filename = safe_filename(item.get("name"), item.get("url"), index)
            path = unique_path(output_dir, filename)
            try:
                size = download_file(item.get("url"), path)
                result.update({"status": "downloaded", "path": str(path), "size": size})
            except Exception as exc:
                result.update({"status": "failed", "error": str(exc)})

        results.append(result)

    output = {
        "ok": True,
        "keywords": args.keyword,
        "dataset_total": len(items),
        "matched_total": len(matches),
        "returned": len(results),
        "downloaded": sum(1 for x in results if x.get("status") == "downloaded"),
        "output_dir": None if args.no_download else str(output_dir),
        "results": results,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
