-- Follow-up for the review dashboard (Phase 4): a queue view for what
-- still needs a human decision, storage read access so the dashboard can
-- preview rendered clips, and a fix to the post-gate trigger so an edited
-- (not just cleanly approved) render can still be posted.

-- ---------------------------------------------------------------------------
-- Pending review queue
-- ---------------------------------------------------------------------------
-- Ready renders that don't yet have a review_decisions row. security_invoker
-- makes the view check RLS as the querying (dashboard) role rather than the
-- view owner — without it, an owner-defined view can silently bypass the
-- authenticated_read policies the rest of the schema relies on.

create view pending_reviews with (security_invoker = true) as
select
  cr.id as clip_render_id,
  cr.clip_id,
  cr.aspect_ratio,
  cr.style_variant,
  cr.storage_path,
  cr.hook_text,
  cr.caption,
  cr.hashtags,
  cr.predicted_virality_score,
  cr.created_at,
  c.moment_type,
  c.transcript,
  c.virality_score as clip_virality_score,
  c.start_seconds,
  c.end_seconds,
  sv.partner_id,
  sv.campaign_id
from clip_renders cr
join clips c on c.id = cr.clip_id
join source_videos sv on sv.id = c.source_video_id
where cr.render_status = 'ready'
  and not exists (
    select 1 from review_decisions rd where rd.clip_render_id = cr.id
  );

-- ---------------------------------------------------------------------------
-- Storage read access for the dashboard
-- ---------------------------------------------------------------------------
-- Table-level authenticated_read policies (prior migration) don't cover
-- storage.objects — the dashboard needs its own policy to generate signed
-- URLs / preview rendered clips in the private "media" bucket.

create policy authenticated_read_media_objects
on storage.objects for select
to authenticated
using (bucket_id = 'media');

-- ---------------------------------------------------------------------------
-- Post-gate trigger: allow 'edited' renders to be posted, not just 'approved'
-- ---------------------------------------------------------------------------
-- decision is one of approved/rejected/edited (never combined on one row).
-- 'edited' exists so source_review_stats can measure how often content
-- needed a human touch-up before it went out — but as originally written,
-- the trigger only recognized 'approved', so an edited-and-approved render
-- could never actually pass the posts gate. Both 'approved' and 'edited'
-- represent "a human said post this"; only 'rejected' should block it.

create or replace function enforce_clip_render_approved()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1 from review_decisions
    where clip_render_id = new.clip_render_id
      and decision in ('approved', 'edited')
  ) then
    raise exception 'clip_render % has no approved/edited review_decisions row', new.clip_render_id;
  end if;
  return new;
end;
$$;
