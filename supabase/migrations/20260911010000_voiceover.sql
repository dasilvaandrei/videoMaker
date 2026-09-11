-- Adds AI voiceover support: a short spoken line per ranking_item,
-- written by an LLM and synthesized via ElevenLabs. ranking_items
-- already has real rows (Quevedo's test rankings), so these are
-- additive nullable columns, not a destructive change.

alter table ranking_items
  add column vo_script text,
  add column vo_storage_path text,
  add column vo_duration_seconds numeric(6,2),
  add column vo_status text not null default 'pending'
    check (vo_status in ('pending', 'ready', 'failed'));
