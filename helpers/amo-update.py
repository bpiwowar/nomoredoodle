#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "pyjwt>=2.8",
#     "requests>=2.31",
# ]
# ///
"""Update the addons.mozilla.org listing from readme.md.

Everything published comes from the readme, so there is only one copy of it:

  * the description is the text between the <!-- amo:start --> and
    <!-- amo:end --> markers, converted from markdown to the plain text AMO
    accepts;
  * the screenshots are the images of the "## Screenshots" section, uploaded in
    the order they appear, captioned with their alt text.

Run it from the repository root, so the screenshot paths resolve:

    export AMO_JWT_ISSUER=user:XXXXXXX:XXX   # "JWT issuer" on the AMO API keys page
    export AMO_JWT_SECRET=...                # "JWT secret" on the same page

    ./helpers/amo-update.py                  # dry run: prints what it would send
    ./helpers/amo-update.py --apply          # send whatever is out of date
    ./helpers/amo-update.py --show           # print the current listing state
    ./helpers/amo-update.py --apply --replace-screenshots  # redo the screenshots

Safe to re-run, and it resumes: metadata that already matches is skipped, and
only the screenshots the listing does not have yet (matched by caption) are
uploaded, so a retry after a failure finishes the job instead of duplicating
it. AMO throttles writes hard - 429s are waited out automatically, so a full
screenshot upload can take minutes.

API keys: https://addons.mozilla.org/en-US/developers/addon/api/key/
"""
import argparse
import html
import os
import pathlib
import random
import re
import sys
import time
import uuid

import jwt
import requests

SLUG = "no-more-doodle-extension"
BASE = f"https://addons.mozilla.org/api/v5/addons/addon/{SLUG}"
LANG = "en-US"
README = pathlib.Path("readme.md")

IMAGE = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")
LINK = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")


def read_readme():
    if not README.is_file():
        sys.exit(f"No {README} here - run this from the repository root.")
    return README.read_text(encoding="utf-8")


def markdown_to_amo(markdown):
    """AMO escapes HTML tags in the description (they show up as literal
    "&lt;ul&gt;") and does not render markdown. Newlines do become line breaks
    and bare domains are auto-linkified, so flatten to plain text and let a
    link keep its domain in parentheses."""
    def link(match):
        text, url = match.group(1), match.group(2)
        bare = re.sub(r"^https?://", "", url).rstrip("/")
        return text if bare in text else f"{text} ({bare})"

    text = IMAGE.sub("", markdown)
    text = LINK.sub(link, text)
    text = re.sub(r"^#+\s*", "", text, flags=re.MULTILINE)   # headings
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)           # bold
    text = re.sub(r"`([^`]+)`", r"\1", text)                 # code spans
    text = re.sub(r"\n{3,}", "\n\n", text)                   # runs of blank lines
    return text.strip()


def get_description(markdown):
    match = re.search(r"<!--\s*amo:start\s*-->(.*?)<!--\s*amo:end\s*-->",
                      markdown, re.DOTALL)
    if not match:
        sys.exit(f"No <!-- amo:start --> / <!-- amo:end --> markers in {README}.")
    description = markdown_to_amo(match.group(1))
    if not description:
        sys.exit(f"The amo:start/amo:end section of {README} is empty.")
    return description


def get_screenshots(markdown):
    """The images of the "## Screenshots" section, in order: (path, caption)."""
    match = re.search(r"^##\s+Screenshots\s*$(.*?)(?=^##\s|\Z)",
                      markdown, re.DOTALL | re.MULTILINE)
    if not match:
        sys.exit(f"No '## Screenshots' section in {README}.")
    shots = [(path, caption) for caption, path in IMAGE.findall(match.group(1))]
    if not shots:
        sys.exit(f"No images in the '## Screenshots' section of {README}.")

    missing = [path for path, _ in shots if not pathlib.Path(path).is_file()]
    if missing:
        sys.exit(f"Screenshot(s) referenced by {README} are missing: {missing}")
    uncaptioned = [path for path, caption in shots if not caption.strip()]
    if uncaptioned:
        sys.exit(f"Screenshot(s) need alt text to caption the listing: {uncaptioned}")
    return shots


def auth_header():
    """Mint a short-lived AMO JWT. They expire fast, so call this per request."""
    issuer = os.environ.get("AMO_JWT_ISSUER")
    secret = os.environ.get("AMO_JWT_SECRET")
    if not issuer or not secret:
        sys.exit("Set AMO_JWT_ISSUER and AMO_JWT_SECRET first (see the docstring).")
    now = int(time.time())
    token = jwt.encode(
        {"iss": issuer, "jti": str(uuid.uuid4()), "iat": now, "exp": now + 300},
        secret,
        algorithm="HS256",
    )
    return {"Authorization": f"JWT {token}"}


def send(method, url, *, attempts=4, **kwargs):
    """One authenticated request, waiting out AMO's throttle on 429."""
    for attempt in range(1, attempts + 1):
        # Minted per try: a long throttle wait outlives a single token.
        kwargs["headers"] = auth_header()
        resp = requests.request(method, url, timeout=120, **kwargs)
        if resp.status_code != 429:
            return resp
        match = re.search(r"(\d+)\s*second", resp.text)
        wait = int(match.group(1)) + 3 if match else 60
        if attempt == attempts:
            return resp
        print(f"  throttled, waiting {wait}s ({attempt}/{attempts - 1})...", flush=True)
        time.sleep(wait)
        # Rewind any file handle consumed by the failed attempt.
        for value in (kwargs.get("files") or {}).values():
            if hasattr(value[1], "seek"):
                value[1].seek(0)
    return resp


def get_addon():
    """Read the listing, dodging the CDN cache that fronts the public endpoint."""
    resp = requests.get(
        f"{BASE}/",
        params={"nocache": random.randint(1, 10**9)},
        headers={"Cache-Control": "no-cache"},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def comparable(text):
    """Normalise for comparison: AMO stores the description with <br> and
    auto-linked domains added, so what it returns never matches what was sent
    byte for byte. Unescape before dropping tags, or escaped markup survives.
    Whitespace goes entirely: dropping a tag either glues two sentences together
    or pads a linkified domain to "( doodle.com )", and AMO reflows it anyway."""
    return re.sub(r"\s+", "", re.sub(r"<[^>]+>", " ", html.unescape(text or "")))


def show():
    addon = get_addon()
    print("slug           :", addon.get("slug"))
    print("is_experimental:", addon.get("is_experimental"))
    print("screenshots    :", len(addon.get("previews") or []))
    print("description    :", (addon.get("description") or {}).get(LANG))


def set_caption(preview_id, caption):
    """A caption cannot be set when a preview is created: it is a localized
    object, which multipart form-data cannot express. So it takes a PATCH."""
    resp = send("PATCH", f"{BASE}/previews/{preview_id}/",
                json={"caption": {LANG: caption}})
    print(f"  caption {preview_id}:", resp.status_code)
    if not resp.ok:
        print("  ", resp.text)


def upload_screenshots(screenshots, replace, previews):
    """Bring the listing's previews in line with the readme's screenshots.

    Throttling makes a half-finished upload the normal failure, so this resumes
    rather than starting over: previews are matched to screenshots by position
    (AMO returns them in the order they were uploaded, which is readme order),
    missing ones are uploaded and wrong or absent captions are repaired. If the
    listing's previews are not the readme's, --replace-screenshots redoes them."""
    if replace:
        for preview in previews:
            resp = send("DELETE", f"{BASE}/previews/{preview['id']}/")
            print(f"DELETE preview {preview['id']}:", resp.status_code)
        previews = []

    for preview, (_, caption) in zip(previews, screenshots):
        if (preview.get("caption") or {}).get(LANG) != caption:
            print(f"Preview {preview['id']}: caption missing or stale, fixing.")
            set_caption(preview["id"], caption)

    if len(previews) > len(screenshots):
        extra = [p["id"] for p in previews[len(screenshots):]]
        print(f"Note: the listing has {len(extra)} preview(s) the readme does not "
              f"describe: {extra}. Left alone; --replace-screenshots removes them.")

    todo = screenshots[len(previews):]
    if not todo:
        print(f"Screenshots: all {len(screenshots)} already uploaded.")
        return
    if previews:
        print(f"Screenshots: {len(previews)} already uploaded, "
              f"adding the {len(todo)} missing.")

    for position, (path, caption) in enumerate(todo, start=len(previews)):
        with open(path, "rb") as handle:
            resp = send(
                "POST",
                f"{BASE}/previews/",
                files={"image": (pathlib.Path(path).name, handle, "image/png")},
                data={"position": position},
            )
        print(f"POST {path}:", resp.status_code)
        if not resp.ok:
            print("  ", resp.text)
            continue

        set_caption(resp.json()["id"], caption)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--apply", action="store_true",
                        help="send the changes (default is a dry run)")
    parser.add_argument("--show", action="store_true",
                        help="print the current listing state and exit")
    parser.add_argument("--replace-screenshots", action="store_true",
                        help="delete the listing's existing screenshots first")
    parser.add_argument("--force", action="store_true",
                        help="send the metadata even if it already matches")
    parser.add_argument("--print", dest="print_only", action="store_true",
                        help="print the description built from the readme and exit")
    args = parser.parse_args()

    if args.show:
        show()
        return

    markdown = read_readme()
    description = get_description(markdown)
    screenshots = get_screenshots(markdown)

    if args.print_only:
        print(description)
        return

    addon = get_addon()
    previews = addon.get("previews") or []
    live = (addon.get("description") or {}).get(LANG)
    metadata_current = (
        not args.force
        and addon.get("is_experimental") is False
        and comparable(live) == comparable(description)
    )

    if not args.apply:
        note = " (already set)" if metadata_current else ""
        print("DRY RUN - nothing sent. Would apply to", SLUG)
        print(f"  is_experimental -> False{note}")
        print(f"  description     -> {len(description)} chars from {README}{note}")
        if args.replace_screenshots:
            todo = screenshots
            if previews:
                print(f"  screenshots     -> delete {len(previews)}, re-upload "
                      f"{len(screenshots)}")
        else:
            todo = screenshots[len(previews):]
            stale = [preview["id"] for preview, (_, caption)
                     in zip(previews, screenshots)
                     if (preview.get("caption") or {}).get(LANG) != caption]
            if stale:
                print(f"  captions        -> fix {stale}")
            if not todo:
                print(f"  screenshots     -> all {len(screenshots)} already uploaded")
        for path, caption in todo:
            print(f"  upload {path} ({caption[:48]}...)")
        print("\nRe-run with --apply to send.")
        return

    if metadata_current:
        print("Metadata already up to date, skipping the PATCH.")
    else:
        resp = send(
            "PATCH",
            f"{BASE}/",
            json={"is_experimental": False, "description": {LANG: description}},
        )
        print("PATCH metadata:", resp.status_code)
        if not resp.ok:
            sys.exit(resp.text)

    upload_screenshots(screenshots, args.replace_screenshots, previews)

    print(f"\nDone: https://addons.mozilla.org/en-US/firefox/addon/{SLUG}/")


if __name__ == "__main__":
    main()
