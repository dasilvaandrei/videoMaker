-- Pivot: Backyard Breaks (licensed sports-card-break clips) is retired
-- entirely in favor of a new channel — "top 5 songs by an artist"
-- countdown videos, built from clips taken directly from official YouTube
-- music videos (see the plan for the copyright-risk tradeoff this
-- represents: a deliberate departure from the old "licensed campaigns
-- only" rule, not an oversight).
--
-- This drops every campaign/sports/rights-specific table and rebuilds the
-- sourcing side of the schema around artists/songs/rankings instead.
-- Generic downstream infra (platforms, posts, post_metrics,
-- review_decisions, cost_log, the review-gate trigger pattern) survives,
-- just repointed at the new tables.

-- ---------------------------------------------------------------------------
-- Drop views/trigger/function that reference tables being dropped below —
-- must go first, before the tables themselves.
-- ---------------------------------------------------------------------------

drop view if exists pending_reviews;
drop view if exists source_review_stats;
drop function if exists enforce_clip_render_approved() cascade;

-- ---------------------------------------------------------------------------
-- Detach posts/review_decisions from clip_renders before it's dropped —
-- rename column + swap the FK to point at ranking_videos (created below).
-- ---------------------------------------------------------------------------

alter table review_decisions drop constraint review_decisions_clip_render_id_fkey;
alter table review_decisions rename column clip_render_id to ranking_video_id;

alter table posts drop constraint posts_clip_render_id_fkey;
alter table posts rename column clip_render_id to ranking_video_id;

-- Backyard Breaks' real review/publish history (26 review_decisions, 15
-- published posts, backed up to supabase/backup-backyard-breaks-20260910/
-- before this migration ran) has no home under the new content model —
-- there's no ranking_video a retired sports clip could map onto. Cleared
-- here rather than left dangling, since the FK below can't reference rows
-- in a ranking_videos table that doesn't have them (it's brand new).
delete from post_metrics;
delete from posts;
delete from review_decisions;

-- Campaign-specific columns on posts — no more clip-reward campaigns.
alter table posts drop column if exists campaign_id;
alter table posts drop column if exists campaign_submitted_at;

-- No more revenue-share partners — we own the channel outright.
alter table platform_accounts drop column if exists partner_id;

-- ---------------------------------------------------------------------------
-- Drop campaign/sports/rights tables. Cascade to sweep any leftover FKs
-- (e.g. source_videos.campaign_id, clips.source_video_id) along with them.
-- ---------------------------------------------------------------------------

drop table if exists campaign_payouts cascade;
drop table if exists campaigns cascade;
drop table if exists campaign_platforms cascade;
drop table if exists clip_renders cascade;
drop table if exists clips cascade;
drop table if exists source_videos cascade;
drop table if exists games cascade;
drop table if exists rights_agreements cascade;
drop table if exists partners cascade;
drop table if exists trend_signals cascade;
drop table if exists competitor_posts cascade;

-- ---------------------------------------------------------------------------
-- Artists, songs, and resolved clip windows
-- ---------------------------------------------------------------------------

create table artists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  spotify_artist_id text,
  youtube_channel_id text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (name)
);

create table songs (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references artists(id) on delete cascade,
  title text not null,
  spotify_track_id text,
  -- Official YouTube video a clip gets cut from. Known immediately for
  -- YouTube-sourced rankings; resolved after the fact (see
  -- jobs/resolve-song-clips.ts) for Spotify- or personal-sourced songs.
  youtube_video_id text,
  duration_seconds numeric(8,2),
  created_at timestamptz not null default now(),
  unique (artist_id, title)
);

create table song_clips (
  id uuid primary key default gen_random_uuid(),
  song_id uuid not null references songs(id) on delete cascade,
  youtube_video_id text not null,
  start_seconds numeric(8,2) not null,
  end_seconds numeric(8,2) not null,
  selection_method text not null check (selection_method in ('percentage_heuristic', 'manual')),
  storage_path text,
  status text not null default 'pending' check (status in ('pending', 'downloaded', 'failed')),
  created_at timestamptz not null default now(),
  -- MVP: one active clip per song, reused across every ranking (Spotify,
  -- YouTube, personal) it shows up in — no re-downloading the same song.
  unique (song_id),
  check (end_seconds > start_seconds)
);

create index song_clips_status_idx on song_clips(status);

-- ---------------------------------------------------------------------------
-- Rankings: one per artist per source per run (a day, for automated
-- sources; a sheet batch, for personal ones)
-- ---------------------------------------------------------------------------

create table rankings (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references artists(id) on delete cascade,
  source text not null check (source in ('spotify', 'youtube', 'personal')),
  period_label text not null,
  status text not null default 'draft' check (status in ('draft', 'ready', 'superseded')),
  -- Overall commentary for a personal ranking (the Google Form's single
  -- "why this ranking" field) — distinct from ranking_items.note, which
  -- is per-song and mostly unused now that the form collects one note
  -- per submission rather than one per song.
  note text,
  created_at timestamptz not null default now(),
  unique (artist_id, source, period_label)
);

create index rankings_status_idx on rankings(status);

create table ranking_items (
  id uuid primary key default gen_random_uuid(),
  ranking_id uuid not null references rankings(id) on delete cascade,
  song_id uuid not null references songs(id) on delete restrict,
  rank int not null check (rank between 1 and 5),
  metric_label text,
  metric_value numeric,
  note text,
  unique (ranking_id, rank)
);

create index ranking_items_ranking_id_idx on ranking_items(ranking_id);

-- ---------------------------------------------------------------------------
-- Rendered countdown videos (replaces clip_renders — one row aggregates
-- all 5 songs into a single rendered output, not one row per clip)
-- ---------------------------------------------------------------------------

create table ranking_videos (
  id uuid primary key default gen_random_uuid(),
  ranking_id uuid not null references rankings(id) on delete cascade,
  aspect_ratio text not null default '9:16' check (aspect_ratio in ('9:16', '1:1', '16:9')),
  title text,
  caption text,
  hashtags text[] not null default '{}',
  storage_path text,
  render_status text not null default 'queued' check (render_status in ('queued', 'rendering', 'ready', 'failed')),
  created_at timestamptz not null default now()
);

create index ranking_videos_ranking_id_idx on ranking_videos(ranking_id);
create index ranking_videos_render_status_idx on ranking_videos(render_status);

-- Re-add the FK review_decisions/posts now point at (dropped above along
-- with clip_renders).
alter table review_decisions
  add constraint review_decisions_ranking_video_id_fkey
  foreign key (ranking_video_id) references ranking_videos(id) on delete cascade;

alter table posts
  add constraint posts_ranking_video_id_fkey
  foreign key (ranking_video_id) references ranking_videos(id) on delete cascade;

-- ---------------------------------------------------------------------------
-- RLS — same pattern as the rest of the schema: workers use service_role
-- and bypass RLS; these policies only govern the dashboard's browser client.
-- ---------------------------------------------------------------------------

alter table artists enable row level security;
alter table songs enable row level security;
alter table song_clips enable row level security;
alter table rankings enable row level security;
alter table ranking_items enable row level security;
alter table ranking_videos enable row level security;

create policy authenticated_read on artists for select to authenticated using (true);
create policy authenticated_read on songs for select to authenticated using (true);
create policy authenticated_read on song_clips for select to authenticated using (true);
create policy authenticated_read on rankings for select to authenticated using (true);
create policy authenticated_read on ranking_items for select to authenticated using (true);
create policy authenticated_read on ranking_videos for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Hard DB invariant, carried over: a post can't exist for a ranking_video
-- that hasn't been approved/edited by a human reviewer.
-- ---------------------------------------------------------------------------

create function enforce_ranking_video_approved()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1 from review_decisions
    where ranking_video_id = new.ranking_video_id
      and decision in ('approved', 'edited')
  ) then
    raise exception 'ranking_video % has no approved/edited review_decisions row', new.ranking_video_id;
  end if;
  return new;
end;
$$;

create trigger posts_require_approved_review
  before insert on posts
  for each row execute function enforce_ranking_video_approved();

-- ---------------------------------------------------------------------------
-- Pending review queue — ready ranking_videos without a decision yet, with
-- the 5-song lineup inlined so the dashboard doesn't need a second round
-- trip per card. security_invoker so it checks RLS as the querying role.
-- ---------------------------------------------------------------------------

create view pending_reviews with (security_invoker = true) as
select
  rv.id as ranking_video_id,
  rv.ranking_id,
  rv.aspect_ratio,
  rv.storage_path,
  rv.title,
  rv.caption,
  rv.hashtags,
  rv.created_at,
  r.source,
  r.period_label,
  a.name as artist_name,
  (
    select json_agg(
      json_build_object(
        'rank', ri.rank,
        'song_title', s.title,
        'metric_label', ri.metric_label,
        'note', ri.note
      ) order by ri.rank asc
    )
    from ranking_items ri
    join songs s on s.id = ri.song_id
    where ri.ranking_id = rv.ranking_id
  ) as lineup
from ranking_videos rv
join rankings r on r.id = rv.ranking_id
join artists a on a.id = r.artist_id
where rv.render_status = 'ready'
  and not exists (
    select 1 from review_decisions rd where rd.ranking_video_id = rv.id
  );

-- ---------------------------------------------------------------------------
-- Rolling review-quality stats, now keyed by ranking source (spotify /
-- youtube / personal) rather than by campaign partner — the analogous
-- "trust this pipeline enough to loosen review" axis for this pivot.
-- ---------------------------------------------------------------------------

create view ranking_review_stats as
with ranked_decisions as (
  select
    r.source,
    rd.decision,
    row_number() over (partition by r.source order by rd.decided_at desc) as rn
  from review_decisions rd
  join ranking_videos rv on rv.id = rd.ranking_video_id
  join rankings r on r.id = rv.ranking_id
)
select
  source,
  count(*) as reviewed_count,
  count(*) filter (where decision = 'rejected')::numeric / count(*) as rejection_rate,
  count(*) filter (where decision = 'edited')::numeric / count(*) as edit_rate,
  count(*) filter (where decision = 'approved')::numeric / count(*) as approval_rate
from ranked_decisions
where rn <= 30
group by source;
