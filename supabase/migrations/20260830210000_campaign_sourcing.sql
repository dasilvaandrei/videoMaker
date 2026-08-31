-- Pivot: content sourcing moves from Twitch broadcaster clips to paid
-- clip-reward campaigns (Whop Content Rewards, Ssemble Clip Rewards, etc.)
-- Campaigns explicitly license their source content to clippers in exchange
-- for a share of view-driven value (CPM payout), which both removes the
-- copyright-strike risk the Twitch approach only partially mitigated and
-- gives the pipeline a direct, first-party revenue stream (not just ad
-- revenue on the distribution platforms).
--
-- Neither Whop nor Ssemble expose a public API to join a campaign, pull
-- source content, or submit a posted clip for view tracking — that stays a
-- manual, human step (see worker/src/jobs/join-campaign.ts). Campaign
-- *discovery* (browsing what's live) is automatable via a third-party Apify
-- actor that scrapes Whop's public campaign directory.

-- ---------------------------------------------------------------------------
-- Campaign platforms (where clippers get paid — distinct from `platforms`,
-- which is where clips get posted)
-- ---------------------------------------------------------------------------

create table campaign_platforms (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (name in ('whop', 'ssemble', 'other'))
);

insert into campaign_platforms (name) values ('whop'), ('ssemble'), ('other');

-- ---------------------------------------------------------------------------
-- Campaigns
-- ---------------------------------------------------------------------------

create table campaigns (
  id uuid primary key default gen_random_uuid(),
  campaign_platform_id uuid not null references campaign_platforms(id) on delete restrict,
  -- Set once a human joins the campaign (worker/src/jobs/join-campaign.ts),
  -- alongside the rights_agreements row recording the license terms.
  partner_id uuid references partners(id) on delete set null,
  external_ref text,
  title text not null,
  brand text,
  campaign_type text check (campaign_type in ('clipping', 'ugc')),
  category text,
  description text,
  rate_per_1k_views_usd numeric(10,4),
  budget_usd numeric(12,2),
  budget_spent_usd numeric(12,2),
  budget_remaining_usd numeric(12,2),
  allowed_platforms text[] not null default '{}',
  rules text,
  opportunity_score numeric(5,2),
  status text not null default 'discovered' check (status in ('discovered', 'joined', 'declined', 'ended')),
  discovered_at timestamptz not null default now(),
  joined_at timestamptz,
  -- Populated once a human joins the campaign and the platform grants
  -- access to the underlying long-form content (podcast/stream VOD/etc).
  source_content_url text,
  raw jsonb not null default '{}'::jsonb
);

create unique index campaigns_external_ref_idx
  on campaigns(campaign_platform_id, external_ref) where external_ref is not null;
create index campaigns_status_idx on campaigns(status);

-- ---------------------------------------------------------------------------
-- Link source footage and posts back to the campaign that licensed them
-- ---------------------------------------------------------------------------

alter table source_videos
  add column campaign_id uuid references campaigns(id) on delete set null;

create index source_videos_campaign_id_idx on source_videos(campaign_id);

alter table posts
  add column campaign_id uuid references campaigns(id) on delete set null,
  add column campaign_submitted_at timestamptz;

create index posts_campaign_id_idx on posts(campaign_id);

-- ---------------------------------------------------------------------------
-- Campaign payouts — the revenue-side mirror of post_metrics. Whop/Ssemble
-- track qualifying views per their own rules and pay per 1,000; this table
-- records what we observe (manually or via a future tracking job) so
-- cost_log (spend) has a revenue counterpart.
-- ---------------------------------------------------------------------------

create table campaign_payouts (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references posts(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  checked_at timestamptz not null default now(),
  tracked_views bigint,
  payout_usd numeric(10,2),
  payout_status text not null default 'pending' check (payout_status in ('pending', 'qualified', 'paid', 'rejected')),
  raw jsonb not null default '{}'::jsonb
);

create index campaign_payouts_post_id_idx on campaign_payouts(post_id);
create index campaign_payouts_campaign_id_idx on campaign_payouts(campaign_id);

-- ---------------------------------------------------------------------------
-- RLS (same pattern as the rest of the schema — dashboard reads, workers
-- use service_role and bypass RLS)
-- ---------------------------------------------------------------------------

alter table campaign_platforms enable row level security;
alter table campaigns enable row level security;
alter table campaign_payouts enable row level security;

create policy authenticated_read on campaign_platforms for select to authenticated using (true);
create policy authenticated_read on campaigns for select to authenticated using (true);
create policy authenticated_read on campaign_payouts for select to authenticated using (true);

-- Joining a campaign (status/source_content_url) is a human action taken
-- from the dashboard, same as review_decisions.
create policy authenticated_update_campaigns on campaigns
  for update to authenticated using (true) with check (true);
