# videoMaker

Autonomous clip farm built on paid clip-reward campaigns (Whop Content
Rewards, Ssemble Clip Rewards, etc.): campaigns explicitly license their
long-form content (podcasts, streams) to clippers in exchange for a share
of view-driven value, so sourcing is copyright-clean by design and pays
directly — not just via platform ad revenue. The pipeline discovers live
campaigns, downloads licensed source content, auto-detects highlights,
renders vertical/square clips with hooks and captions via Remotion, routes
them through human review, publishes to YouTube Shorts/TikTok/Instagram
Reels, and tracks campaign payouts alongside platform metrics.

Full architecture, phased roadmap, and the reasoning behind every major
decision (content sourcing, autonomy model, cost strategy, virality
mechanism) lives in the build plan — see the plan file referenced at the
top of the project's Claude Code session, or ask Claude to summarize it.

## Status

- **Database**: Supabase schema is live (`supabase/migrations/`) —
  campaigns/campaign_platforms/campaign_payouts, rights/partner intake,
  source videos, clip detection, renders, human review queue, publishing,
  metrics, trend research, RLS, a DB-level review gate, and cost tracking.
- **Worker** (`worker/`): campaign sourcing and rendering are built:
  - `npm run discover-campaigns` — scrapes Whop's live campaign directory
    (via a third-party Apify actor, since neither Whop nor Ssemble expose
    a public API) into the `campaigns` table.
  - `npm run join-campaign -- <campaign_id> <source_content_url>` — manual
    step, run after **you** actually join a campaign on Whop/Ssemble's own
    site (no write API exists for that either) and get access to its
    source content. Records the license (`rights_agreements`) and the
    join.
  - `npm run ingest-campaign-source` / `npm run ingest-backyard-breaks` —
    ingest a joined campaign's source content into `source_videos` (+
    `clips`, for pre-curated campaigns like Backyard Breaks where the
    campaign itself already identifies the clip-worthy moments).
  - `npm run generate-render-metadata` — queues a `clip_renders` row per
    campaign clip, reusing the campaign's own hook/caption material where
    available (see plan §6) rather than an LLM call.
  - `npm run render-clips` — renders queued clips through the Remotion
    `HighlightClip` composition (`src/remotion/`) and uploads the result
    to Supabase Storage.

  Publishing (Phase 6) isn't built yet.
- **Dashboard** (`apps/dashboard/`): Next.js review dashboard is built —
  `/review` (approve/edit/reject queued renders against `review_decisions`)
  and `/sources` (per-source autonomy stats, plan §3), behind Supabase Auth.

  ```bash
  cd apps/dashboard
  cp .env.local.example .env.local   # NEXT_PUBLIC_SUPABASE_URL / ANON_KEY
  npm run dev
  ```

  Sign-in is plain email/password against Supabase Auth (no self-serve
  signup wired up — create reviewer accounts via the Supabase dashboard or
  the Admin API). Publishing (Phase 6) will add scheduling controls here
  once at least one platform's API access is approved.

## Setup

```bash
npm install
cp .env.example .env   # fill in real values, see comments in the file
```

Needs Node 18+.

### Worker

```bash
cd worker
npm run discover-campaigns        # requires APIFY_TOKEN
# ...pick a campaign, join it manually on whop.com/ssemble.com, then:
npm run join-campaign -- <campaign_id> <source_content_url>
npm run ingest-campaign-source
```

### Database migrations

```bash
npx supabase db push   # or supabase db push if the CLI is installed globally
```
