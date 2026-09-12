-- Re-adds voiceover, scoped to a single intro hook line per video this
-- time (not per-song like the earlier, reverted attempt) — see
-- jobs/generate-intro-vo.ts.
alter table rankings
  add column intro_script text,
  add column intro_on_screen_text text,
  add column intro_vo_storage_path text,
  add column intro_vo_duration_seconds numeric(6,2);
