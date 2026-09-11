# videoMaker

Automated "top 5 songs by an artist" countdown-video channel. Two ways a
video gets made:

1. **Automated** — once a day, an artist's top 5 songs right now,
   ranked by real Last.fm playcounts or YouTube view counts.
2. **Personal picks** — the user's own top-5 ranking for an artist,
   entered into a Google Sheet, meant to draw comment-section debate.

Both modes assemble the video the same way: a short clip is cut directly
from each song's official YouTube upload, then stitched together in
descending rank order (5 → 1) via Remotion, with rank/song/metric
overlays burned in.

## A note on copyright

Clips are ripped from official YouTube music videos, not sourced from any
licensing arrangement. This is a deliberate, accepted risk — the standard
approach for "top songs" countdown channels — not an oversight: expect
YouTube Content ID claims on individual uploads (the rights holder
collects ad revenue on the claimed portion) rather than takedowns, but
this is real, ongoing legal exposure, not a copyright-clean pipeline.

## Automation

`.github/workflows/daily-pipeline.yml` runs the whole thing once a day,
fully unattended: `npm run run-daily-pipeline` deterministically picks
one (artist, source) pair from the roster (cycling through every
combination before repeating), fetches → resolves clips → downloads →
renders → **auto-approves** → publishes. There is no human review step
in this path by explicit choice — the review-gate DB trigger normally
requires a `review_decisions` row before a `post` can exist, and the
daily pipeline satisfies that itself rather than waiting on `/review`.
If that's ever unwanted, delete the `autoApproveReadyVideos()` call in
`run-daily-pipeline.ts` and let the dashboard gate it like the personal-
picks path still does.

Needs a `LASTFM_API_KEY` repo secret in addition to the existing
Supabase/YouTube ones. The render step needs Chrome Headless Shell's
Linux dependencies on the runner (installed in the workflow per
[Remotion's docs](https://www.remotion.dev/docs/miscellaneous/linux-dependencies));
this hasn't been verified against a real GitHub Actions run yet, so
watch the first scheduled/manual run.

## Status

- **Database**: Supabase schema (`supabase/migrations/`) covers
  artists/songs/song_clips, per-source rankings and ranking_items,
  rendered ranking_videos, the human review queue, publishing, and
  metrics — plus the DB-level review gate (a `posts` row can't exist for
  a `ranking_video` that hasn't been approved/edited by a human).
- **Worker** (`worker/`): the ranking pipeline, run roughly in this
  order:
  - `npm run fetch-lastfm-rankings` / `npm run fetch-youtube-rankings` —
    pull each roster artist's top 5 songs for that source (roster is
    `worker/src/config/artists.json`) into `rankings`/`ranking_items`.
  - `npm run sync-personal-rankings` — reads the personal-picks Google
    Sheet (`PERSONAL_RANKINGS_SHEET_ID`) into a `source='personal'`
    ranking.
  - `npm run resolve-song-clips` — finds each song's official YouTube
    video (already known for YouTube-sourced songs) and computes a
    start/end clip window.
  - `npm run download-song-clips` — pulls just that window via `yt-dlp`
    and uploads it to Supabase Storage. Real song audio only (an
    AI-voiceover version was tried and dropped — the songs carry the
    videos better on their own); clip length (~7.5s) is a deliberate
    tradeoff toward "long enough to actually hear the song" over
    minimizing copyright-claim exposure.
  - `npm run generate-ranking-render-metadata` — once every song in a
    ranking has a downloaded clip, builds title/caption/hashtags and
    queues a render.
  - `npm run render-ranking-videos` — renders the 5-clip countdown
    through the Remotion `RankingCountdown` composition
    (`src/remotion/`) — starts immediately on song #5 under a persistent
    title header, with a gamified "scoreboard" sidebar (numbers 1→5,
    color-coded upcoming/active/completed/#1, climbing bottom-to-top)
    tracking progress toward the reveal and a short synthesized "ding" on
    every rank transition — and uploads the result.
  - `npm run publish-post -- --limit 1` — publishes the oldest
    approved-and-unposted video to YouTube (what the scheduled GitHub
    Actions workflow runs, once a day).
- **Dashboard** (`apps/dashboard/`): Next.js review dashboard —
  `/review` (approve/edit/reject queued videos, shows the 5-song lineup,
  against `review_decisions`) and `/artists` (tracked roster + latest
  ranking per source, and rolling review-quality stats per source),
  behind Supabase Auth.

  ```bash
  cd apps/dashboard
  cp .env.local.example .env.local   # NEXT_PUBLIC_SUPABASE_URL / ANON_KEY
  npm run dev
  ```

  Sign-in is plain email/password against Supabase Auth (no self-serve
  signup wired up — create reviewer accounts via the Supabase dashboard or
  the Admin API).

## Setup

```bash
npm install
cp .env.example .env   # fill in real values, see comments in the file
```

Needs Node 18+, and the [`yt-dlp`](https://github.com/yt-dlp/yt-dlp)
binary on `PATH` (`brew install yt-dlp` / `pip install yt-dlp`) wherever
`download-song-clips` runs.

### Tracked artists

Edit `worker/src/config/artists.json` — an array of
`{ name, youtubeChannelId }`. `name` is looked up directly against
Last.fm (no separate id needed there); `youtubeChannelId` comes from the
artist's `youtube.com/channel/<id>` URL (resolve an `@handle` via the
Data API's `channels.list?forHandle=` if needed). The YouTube ranking
job skips an artist missing `youtubeChannelId`.

### Worker

```bash
cd worker
npm run fetch-lastfm-rankings
npm run fetch-youtube-rankings
npm run resolve-song-clips
npm run download-song-clips
npm run generate-ranking-render-metadata
npm run render-ranking-videos
```

### Database migrations

```bash
npx supabase db push   # or supabase db push if the CLI is installed globally
```
