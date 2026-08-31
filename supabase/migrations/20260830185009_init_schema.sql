-- Clip farm core schema.
-- Covers: rights/partner intake, source footage, highlight detection,
-- rendered clips, human review (the labeled-data flywheel), publishing,
-- performance metrics, and trend research.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Rights & partner intake
-- ---------------------------------------------------------------------------

create table partners (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_email text,
  partner_type text not null check (partner_type in ('creator', 'team', 'league', 'other')),
  created_at timestamptz not null default now()
);

create table rights_agreements (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references partners(id) on delete cascade,
  scope text not null,
  territory text,
  revenue_share_pct numeric(5,2),
  document_url text,
  status text not null default 'active' check (status in ('active', 'expired', 'revoked')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_at timestamptz not null default now()
);

create index rights_agreements_partner_id_idx on rights_agreements(partner_id);

-- ---------------------------------------------------------------------------
-- Source footage
-- ---------------------------------------------------------------------------

create table games (
  id uuid primary key default gen_random_uuid(),
  sport text not null,
  league text,
  home_team text,
  away_team text,
  event_date date,
  external_ref text,
  created_at timestamptz not null default now()
);

create table source_videos (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references partners(id) on delete restrict,
  rights_agreement_id uuid references rights_agreements(id) on delete set null,
  game_id uuid references games(id) on delete set null,
  storage_path text not null,
  duration_seconds numeric(8,2),
  status text not null default 'pending' check (status in ('pending', 'processed', 'rejected')),
  raw_metadata jsonb not null default '{}'::jsonb,
  uploaded_at timestamptz not null default now()
);

create index source_videos_partner_id_idx on source_videos(partner_id);
create index source_videos_game_id_idx on source_videos(game_id);
create index source_videos_status_idx on source_videos(status);

-- ---------------------------------------------------------------------------
-- Highlight detection & rendered clips
-- ---------------------------------------------------------------------------

create table clips (
  id uuid primary key default gen_random_uuid(),
  source_video_id uuid not null references source_videos(id) on delete cascade,
  start_seconds numeric(8,2) not null,
  end_seconds numeric(8,2) not null,
  detection_method text not null check (detection_method in ('audio_energy', 'scene_cut', 'scoreboard_ocr', 'manual')),
  moment_type text,
  transcript text,
  virality_score numeric(5,2),
  created_at timestamptz not null default now(),
  check (end_seconds > start_seconds)
);

create index clips_source_video_id_idx on clips(source_video_id);
create index clips_virality_score_idx on clips(virality_score desc);

create table clip_renders (
  id uuid primary key default gen_random_uuid(),
  clip_id uuid not null references clips(id) on delete cascade,
  aspect_ratio text not null check (aspect_ratio in ('9:16', '1:1', '16:9')),
  style_variant text,
  storage_path text,
  hook_text text,
  caption text,
  hashtags text[] not null default '{}',
  render_status text not null default 'queued' check (render_status in ('queued', 'rendering', 'ready', 'failed')),
  created_at timestamptz not null default now()
);

create index clip_renders_clip_id_idx on clip_renders(clip_id);
create index clip_renders_render_status_idx on clip_renders(render_status);

-- ---------------------------------------------------------------------------
-- Human review queue (the labeled-data flywheel)
-- ---------------------------------------------------------------------------

create table review_decisions (
  id uuid primary key default gen_random_uuid(),
  clip_render_id uuid not null references clip_renders(id) on delete cascade,
  reviewer_id uuid references auth.users(id) on delete set null,
  decision text not null check (decision in ('approved', 'rejected', 'edited')),
  notes text,
  edited_caption text,
  edited_hashtags text[],
  decided_at timestamptz not null default now()
);

create index review_decisions_clip_render_id_idx on review_decisions(clip_render_id);
create index review_decisions_decision_idx on review_decisions(decision);

-- ---------------------------------------------------------------------------
-- Publishing
-- ---------------------------------------------------------------------------

create table platforms (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (name in ('youtube', 'tiktok', 'instagram'))
);

insert into platforms (name) values ('youtube'), ('tiktok'), ('instagram');

create table platform_accounts (
  id uuid primary key default gen_random_uuid(),
  platform_id uuid not null references platforms(id) on delete restrict,
  partner_id uuid references partners(id) on delete set null,
  external_account_id text not null,
  display_name text,
  created_at timestamptz not null default now(),
  unique (platform_id, external_account_id)
);

create index platform_accounts_platform_id_idx on platform_accounts(platform_id);

create table posts (
  id uuid primary key default gen_random_uuid(),
  clip_render_id uuid not null references clip_renders(id) on delete cascade,
  platform_account_id uuid not null references platform_accounts(id) on delete restrict,
  external_post_id text,
  caption text,
  hashtags text[] not null default '{}',
  status text not null default 'scheduled' check (status in ('scheduled', 'publishing', 'published', 'failed')),
  error_message text,
  scheduled_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now()
);

create index posts_clip_render_id_idx on posts(clip_render_id);
create index posts_platform_account_id_idx on posts(platform_account_id);
create index posts_status_idx on posts(status);

create table post_metrics (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references posts(id) on delete cascade,
  captured_at timestamptz not null default now(),
  views bigint,
  likes bigint,
  comments bigint,
  shares bigint,
  avg_watch_seconds numeric(8,2),
  completion_rate numeric(5,4),
  raw jsonb not null default '{}'::jsonb
);

create index post_metrics_post_id_idx on post_metrics(post_id);
create index post_metrics_captured_at_idx on post_metrics(captured_at);

-- ---------------------------------------------------------------------------
-- Trend research (Apify / agent-reach scrapes)
-- ---------------------------------------------------------------------------

create table trend_signals (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  signal_type text not null check (signal_type in ('hashtag', 'topic', 'audio', 'team', 'player')),
  value text not null,
  metric_value numeric,
  sport text,
  captured_at timestamptz not null default now(),
  raw jsonb not null default '{}'::jsonb
);

create index trend_signals_signal_type_idx on trend_signals(signal_type);
create index trend_signals_captured_at_idx on trend_signals(captured_at);

create table competitor_posts (
  id uuid primary key default gen_random_uuid(),
  platform_id uuid not null references platforms(id) on delete restrict,
  account_handle text not null,
  post_url text,
  posted_at timestamptz,
  views bigint,
  likes bigint,
  comments bigint,
  shares bigint,
  hashtags text[] not null default '{}',
  captured_at timestamptz not null default now(),
  raw jsonb not null default '{}'::jsonb
);

create index competitor_posts_platform_id_idx on competitor_posts(platform_id);
create index competitor_posts_account_handle_idx on competitor_posts(account_handle);
