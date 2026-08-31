-- Follow-up to the clip-farm core schema.
-- Adds: row-level security, a hard DB invariant enforcing human review
-- before publish, a per-render virality score, cost tracking, and a
-- rolling per-source review-quality view used for autonomy graduation.

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- Workers use the service_role key exclusively and bypass RLS by design.
-- These policies only govern the dashboard's authenticated browser client.

alter table partners enable row level security;
alter table rights_agreements enable row level security;
alter table games enable row level security;
alter table source_videos enable row level security;
alter table clips enable row level security;
alter table clip_renders enable row level security;
alter table review_decisions enable row level security;
alter table platforms enable row level security;
alter table platform_accounts enable row level security;
alter table posts enable row level security;
alter table post_metrics enable row level security;
alter table trend_signals enable row level security;
alter table competitor_posts enable row level security;

create policy authenticated_read on partners for select to authenticated using (true);
create policy authenticated_read on rights_agreements for select to authenticated using (true);
create policy authenticated_read on games for select to authenticated using (true);
create policy authenticated_read on source_videos for select to authenticated using (true);
create policy authenticated_read on clips for select to authenticated using (true);
create policy authenticated_read on clip_renders for select to authenticated using (true);
create policy authenticated_read on review_decisions for select to authenticated using (true);
create policy authenticated_read on platforms for select to authenticated using (true);
create policy authenticated_read on platform_accounts for select to authenticated using (true);
create policy authenticated_read on posts for select to authenticated using (true);
create policy authenticated_read on post_metrics for select to authenticated using (true);
create policy authenticated_read on trend_signals for select to authenticated using (true);
create policy authenticated_read on competitor_posts for select to authenticated using (true);

-- The review dashboard is the only place authenticated users write directly:
-- approve/reject/edit decisions, and hashtag/caption edits carried on them.
create policy authenticated_insert_review_decisions on review_decisions
  for insert to authenticated with check (true);

-- ---------------------------------------------------------------------------
-- Hard DB invariant: a post can't exist for a clip_render that hasn't been
-- approved. Enforces "human approves every post" as a guarantee, not just
-- an app-level convention a future bug could bypass.
-- ---------------------------------------------------------------------------

create function enforce_clip_render_approved()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1 from review_decisions
    where clip_render_id = new.clip_render_id
      and decision = 'approved'
  ) then
    raise exception 'clip_render % has no approved review_decisions row', new.clip_render_id;
  end if;
  return new;
end;
$$;

create trigger posts_require_approved_review
  before insert on posts
  for each row execute function enforce_clip_render_approved();

-- ---------------------------------------------------------------------------
-- External-id columns for idempotent, zero-outreach ingestion
-- ---------------------------------------------------------------------------
-- games already has external_ref for this purpose; partners and source_videos
-- need the same so the Twitch ingestion job can upsert synthetic creator
-- partners and dedupe clips without a manual outreach/matching step.

alter table partners
  add column external_ref text;

create unique index partners_external_ref_idx
  on partners(external_ref) where external_ref is not null;

alter table source_videos
  add column external_ref text;

create unique index source_videos_external_ref_idx
  on source_videos(external_ref) where external_ref is not null;

-- ---------------------------------------------------------------------------
-- Per-render virality score
-- ---------------------------------------------------------------------------
-- clips.virality_score is a coarse, clip-level heuristic (is this moment
-- worth rendering at all). Hook/caption wording varies per render even for
-- the same clip, so predicted_virality_score is the finer, per-render,
-- LLM-scored signal used to compare render variants against each other.

alter table clip_renders
  add column predicted_virality_score numeric(5,2);

-- ---------------------------------------------------------------------------
-- Cost tracking
-- ---------------------------------------------------------------------------

create table cost_log (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  category text not null check (category in ('llm', 'render', 'apify', 'storage', 'platform_api', 'other')),
  related_table text,
  related_id uuid,
  amount_usd numeric(10,4) not null,
  notes text,
  raw jsonb not null default '{}'::jsonb
);

create index cost_log_occurred_at_idx on cost_log(occurred_at);
create index cost_log_category_idx on cost_log(category);

alter table cost_log enable row level security;
create policy authenticated_read on cost_log for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Rolling per-source review stats (autonomy graduation input)
-- ---------------------------------------------------------------------------
-- Trailing-30-reviews rejection/edit rate per source (source_videos.partner_id),
-- feeding both the dashboard /sources page and the graduate-autonomy job.
-- Plain view for now; promote to materialized only if it becomes a query-cost
-- problem at scale.

create view source_review_stats as
with ranked_decisions as (
  select
    sv.partner_id,
    rd.decision,
    row_number() over (partition by sv.partner_id order by rd.decided_at desc) as rn
  from review_decisions rd
  join clip_renders cr on cr.id = rd.clip_render_id
  join clips c on c.id = cr.clip_id
  join source_videos sv on sv.id = c.source_video_id
)
select
  partner_id,
  count(*) as reviewed_count,
  count(*) filter (where decision = 'rejected')::numeric / count(*) as rejection_rate,
  count(*) filter (where decision = 'edited')::numeric / count(*) as edit_rate,
  count(*) filter (where decision = 'approved')::numeric / count(*) as approval_rate
from ranked_decisions
where rn <= 30
group by partner_id;
