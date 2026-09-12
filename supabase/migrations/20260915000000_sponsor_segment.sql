-- Affiliate sponsor segment (2-5s split-screen ad, inserted after song
-- #4) — see worker/src/config/sponsors.ts for the sponsor roster and
-- worker/src/remotion/RankingCountdown.tsx's SponsorSegment. The sponsor
-- choice has to be made at caption-generation time (not render time) so
-- the disclosure text and affiliate link can go in the same caption —
-- storing just the name here, render-ranking-videos.ts looks up the
-- rest (asset/VO paths, script) from the sponsors.ts config by name.
-- Null means no sponsor segment on this video, either because none are
-- active yet (no real asset sourced) or the rotation didn't pick one.
alter table ranking_videos add column sponsor_name text;
