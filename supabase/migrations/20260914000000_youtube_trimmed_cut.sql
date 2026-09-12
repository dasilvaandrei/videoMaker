-- TikTok's algorithm reportedly favors 61-65s clips, but YouTube Shorts
-- requires under 60s — rather than rendering two separate videos,
-- render-ranking-videos.ts now renders one longer master (used as-is
-- for TikTok/storage_path) and, when it runs over the Shorts limit,
-- ffmpeg-trims a second copy for YouTube specifically. Nullable because
-- a video that already lands under the limit doesn't need a second file
-- — publish-post.ts falls back to storage_path in that case.
alter table ranking_videos add column youtube_storage_path text;
