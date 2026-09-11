-- Caches a generated (or hand-written override) bio per artist so it's
-- written once and reused on every future video for that artist, rather
-- than regenerated per video.
alter table artists add column bio text;
