-- Spotify's own "Get Artist's Top Tracks" endpoint turned out to be
-- deprecated and gated behind an Extended Quota Mode approval a regular
-- Development Mode app doesn't get (confirmed via a live 403 against a
-- freshly created app) — switching that automated ranking source to
-- Last.fm instead (free key, no approval process, real playcount data).
--
-- rankings/artists/songs are all still empty (no fetch job has
-- successfully run against the 'spotify' source yet), so this is a
-- plain rename, not a data migration.

alter table rankings drop constraint rankings_source_check;
alter table rankings add constraint rankings_source_check
  check (source in ('lastfm', 'youtube', 'personal'));

-- Last.fm looks artists up by name, not a persistent id, and doesn't
-- carry Spotify's per-track id either.
alter table artists drop column if exists spotify_artist_id;
alter table songs drop column if exists spotify_track_id;
