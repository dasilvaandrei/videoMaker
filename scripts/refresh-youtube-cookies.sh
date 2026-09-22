#!/bin/bash
# Runs locally (via launchd, see scripts/com.videomaker.refresh-youtube-cookies.plist)
# every couple hours on the operator's own Mac — NOT in GitHub Actions,
# which has no access to a real logged-in browser. Harvests whatever
# YouTube/Google session cookies already exist in the local Chrome
# profile (no automated login, no credentials touched — just reading
# cookies that already exist from the operator's own normal browsing)
# and pushes them to the videoMaker repo's YOUTUBE_COOKIES_TXT secret.
#
# This exists because yt-dlp's cookie-based auth against YouTube on CI
# kept expiring every 1-2 days (see git history around 2026-09-18/20),
# and a fully-automated *login* would itself look like bot behavior to
# Google — reading an already-authenticated session's cookies sidesteps
# that entirely, at the cost of requiring the operator to keep browsing
# YouTube somewhat normally in Chrome on this machine so the session
# itself doesn't go stale.
#
# Requires: yt-dlp, gh (authenticated), Chrome installed and logged into
# a YouTube-capable Google account. Safe to re-run anytime by hand:
#   ./scripts/refresh-youtube-cookies.sh
set -euo pipefail

REPO="dasilvaandrei/videoMaker"
LOG_TAG="[refresh-youtube-cookies]"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
# --cookies-from-browser writes to this path itself (reading it first as
# an existing jar if present) — it must NOT already exist, or yt-dlp
# rejects it as "does not look like a Netscape format cookies file"
# before ever getting the chance to create it fresh. Only naming it
# inside an already-created tmpdir, never pre-touching the file itself.
FULL_COOKIES="$WORKDIR/full-cookies.txt"
FILTERED_COOKIES="$WORKDIR/filtered-cookies.txt"

echo "$LOG_TAG $(date -u +%FT%TZ) starting"

# --skip-download --simulate against a throwaway, always-available video
# is just how yt-dlp's --cookies-from-browser flag gets triggered to do
# the extraction — no actual video is fetched.
if ! yt-dlp --cookies-from-browser chrome --cookies "$FULL_COOKIES" \
    --skip-download --simulate --quiet \
    "https://www.youtube.com/watch?v=jNQXAC9IVRw" >/tmp/refresh-youtube-cookies.last.log 2>&1; then
  echo "$LOG_TAG failed to extract cookies from Chrome (is Chrome installed / has it ever logged into YouTube?) — see /tmp/refresh-youtube-cookies.last.log" >&2
  exit 1
fi

# Full Chrome export is every cookie for every site (~500KB+, all
# domains) — GitHub secrets cap at 64KB, and yt-dlp only needs the
# YouTube/Google auth-relevant ones anyway. Keep the Netscape header
# lines (comments) plus any cookie row for a relevant domain.
{
  grep -E '^#' "$FULL_COOKIES" || true
  grep -E $'(^|\t)\.?(youtube|google|ytimg|googlevideo)\.com\t' "$FULL_COOKIES" || true
} > "$FILTERED_COOKIES"

COOKIE_COUNT="$(grep -cE $'\t' "$FILTERED_COOKIES" || true)"
if [ "$COOKIE_COUNT" -lt 5 ]; then
  echo "$LOG_TAG only found $COOKIE_COUNT relevant cookies (expected dozens) — not pushing, looks broken" >&2
  exit 1
fi

# Live validation before touching the secret: prove this exact filtered
# file actually authenticates (matches the resolve step yt-dlp does on
# every real clip download), not just that extraction ran without error.
if ! yt-dlp --cookies "$FILTERED_COOKIES" --skip-download --simulate --quiet \
    "https://www.youtube.com/watch?v=jNQXAC9IVRw" >/tmp/refresh-youtube-cookies.last.log 2>&1; then
  echo "$LOG_TAG filtered cookie file failed to authenticate — not pushing, see /tmp/refresh-youtube-cookies.last.log" >&2
  exit 1
fi

if gh secret set YOUTUBE_COOKIES_TXT --repo "$REPO" < "$FILTERED_COOKIES"; then
  echo "$LOG_TAG $(date -u +%FT%TZ) pushed $COOKIE_COUNT cookies ($(wc -c < "$FILTERED_COOKIES") bytes) to $REPO"
else
  echo "$LOG_TAG gh secret set failed" >&2
  exit 1
fi
