-- Caches the artist's YouTube channel photo for the intro's split-screen
-- top half (see jobs/generate-intro-vo.ts) — same lazy-resolve-once
-- pattern as artists.bio.
alter table artists
  add column avatar_url text;
