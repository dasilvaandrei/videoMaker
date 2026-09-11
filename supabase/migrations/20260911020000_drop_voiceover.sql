-- Reverting the voiceover feature (20260911010000_voiceover.sql) — the
-- user decided the real song audio suits these videos better than an AI
-- voiceover layer. Dropping the columns rather than leaving them unused.

alter table ranking_items
  drop column if exists vo_script,
  drop column if exists vo_storage_path,
  drop column if exists vo_duration_seconds,
  drop column if exists vo_status;
