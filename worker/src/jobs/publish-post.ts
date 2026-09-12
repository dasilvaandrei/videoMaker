// Publishes approved/edited ranking_videos to YouTube — the only platform
// with working publish credentials right now (TikTok/Instagram accounts
// are still being warmed up, see memory: publishing_accounts_status).
//
// Three invocation modes:
//   npm run publish-post                      -> publishes every eligible video
//   npm run publish-post -- <ranking_video_id> -> publishes just one, by id
//   npm run publish-post -- --limit N          -> publishes the oldest N eligible
//                                                  videos (no per-render virality
//                                                  score for countdown videos —
//                                                  see below)
// --limit is what the scheduled GitHub Actions workflow uses (one run per
// scheduled post), kept at 1 post/day while the channel identity is
// mid-pivot.
//
// privacyStatus defaults to "private" — YouTube has historically
// restricted uploads from unaudited API projects to private regardless of
// what's requested, independent of the OAuth Testing/verification status
// handled in youtube-oauth-bootstrap.ts. The scheduled workflow overrides
// this to "public" via YOUTUBE_UPLOAD_PRIVACY_STATUS — confirmed working
// against this account's real upload response (see actualPrivacyStatus
// logged below) before wiring that up, not assumed.

import { uploadYoutubeVideo } from "../lib/youtube.js";
import { supabase } from "../lib/supabase.js";

const MEDIA_BUCKET = "media";
const SIGNED_URL_TTL_SECONDS = 60 * 10;
const CATEGORY_ID = "10"; // Music
const PRIVACY_STATUS =
  (process.env.YOUTUBE_UPLOAD_PRIVACY_STATUS as "private" | "unlisted" | "public" | undefined) ?? "private";

interface EligibleVideo {
  id: string;
  storage_path: string | null;
  // Set by render-ranking-videos.ts only when the TikTok-length master
  // (61-65s, past YouTube Shorts' <60s limit) needed trimming — null
  // means the master already fit, so storage_path itself is used below.
  youtube_storage_path: string | null;
  title: string | null;
  caption: string | null;
  hashtags: string[] | null;
  created_at: string;
}

export interface PublishOptions {
  onlyRankingVideoId?: string;
  limit?: number;
}

// Returns the number of videos actually published — run-daily-pipeline.ts
// uses this to fail loudly (instead of silently completing) on a day
// where nothing gets published, so a broken step upstream (a source API
// change, every clip download failing, etc.) surfaces as a failed
// GitHub Actions run rather than going unnoticed indefinitely.
export async function publishApprovedClips(options: PublishOptions = {}): Promise<number> {
  const { onlyRankingVideoId, limit } = options;
  const { data: decisions, error: decisionsError } = await supabase
    .from("review_decisions")
    .select("ranking_video_id")
    .in("decision", ["approved", "edited"]);
  if (decisionsError) throw decisionsError;
  const approvedIds = new Set((decisions ?? []).map((d) => d.ranking_video_id as string));

  const { data: platformRow, error: platformError } = await supabase
    .from("platforms")
    .select("id")
    .eq("name", "youtube")
    .single();
  if (platformError) throw platformError;

  // We own the channel outright now (no clip-reward partners to route
  // between) — there's exactly one youtube platform_account.
  const { data: account, error: accountError } = await supabase
    .from("platform_accounts")
    .select("id")
    .eq("platform_id", platformRow.id)
    .single();
  if (accountError) throw accountError;

  // Only 'published' counts as done — a 'failed' row (from a previous
  // attempt) should be retried, not permanently skipped.
  const { data: existingPosts, error: postsError } = await supabase
    .from("posts")
    .select("ranking_video_id")
    .eq("platform_account_id", account.id)
    .eq("status", "published");
  if (postsError) throw postsError;
  const postedIds = new Set((existingPosts ?? []).map((p) => p.ranking_video_id as string));

  const { data: videos, error: videosError } = await supabase
    .from("ranking_videos")
    .select("id, storage_path, youtube_storage_path, title, caption, hashtags, created_at")
    .eq("render_status", "ready")
    .order("created_at", { ascending: true })
    .returns<EligibleVideo[]>();
  if (videosError) throw videosError;

  let eligible = (videos ?? []).filter(
    (v) => approvedIds.has(v.id) && !postedIds.has(v.id) && v.storage_path
  );

  if (onlyRankingVideoId) {
    eligible = eligible.filter((v) => v.id === onlyRankingVideoId);
    if (eligible.length === 0) {
      throw new Error(
        `ranking_video ${onlyRankingVideoId} isn't eligible — not approved/edited yet, already published, or not render_status='ready'`
      );
    }
  } else if (limit != null) {
    eligible = eligible.slice(0, limit);
  }

  console.log(`${eligible.length} ranking video(s) eligible for YouTube publish (privacyStatus=${PRIVACY_STATUS})`);

  let publishedCount = 0;
  for (const video of eligible) {
    const { data: post, error: insertError } = await supabase
      .from("posts")
      .insert({
        ranking_video_id: video.id,
        platform_account_id: account.id,
        caption: video.caption,
        hashtags: video.hashtags ?? [],
        status: "publishing",
      })
      .select("id")
      .single();
    if (insertError) throw insertError;

    try {
      // Prefer the YouTube-trimmed cut (under Shorts' 60s limit) when
      // one exists — see render-ranking-videos.ts. Falls back to the
      // TikTok-length master for a video that already fit under 60s
      // without trimming.
      const { data: signed, error: signError } = await supabase.storage
        .from(MEDIA_BUCKET)
        .createSignedUrl(video.youtube_storage_path ?? video.storage_path!, SIGNED_URL_TTL_SECONDS);
      if (signError) throw signError;

      const videoRes = await fetch(signed.signedUrl);
      if (!videoRes.ok) throw new Error(`failed to fetch rendered video: ${videoRes.status}`);
      const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

      const description = [video.caption, (video.hashtags ?? []).map((h) => `#${h.replace(/^#/, "")}`).join(" ")]
        .filter(Boolean)
        .join("\n\n");

      const { videoId, actualPrivacyStatus } = await uploadYoutubeVideo(videoBuffer, {
        title: video.title ?? "Top 5 Songs",
        description,
        tags: ["shorts", "musicranking", "topsongs", ...(video.hashtags ?? [])],
        categoryId: CATEGORY_ID,
        privacyStatus: PRIVACY_STATUS,
      });

      const { error: updateError } = await supabase
        .from("posts")
        .update({
          status: "published",
          external_post_id: videoId,
          published_at: new Date().toISOString(),
        })
        .eq("id", post.id);
      if (updateError) throw updateError;

      publishedCount++;
      console.log(
        `published ${video.id} -> https://youtube.com/watch?v=${videoId} (actual privacyStatus=${actualPrivacyStatus})`
      );
      if (actualPrivacyStatus !== PRIVACY_STATUS) {
        console.warn(
          `requested privacyStatus=${PRIVACY_STATUS} but YouTube saved it as ${actualPrivacyStatus} — likely the unaudited-API-project restriction, not a bug here`
        );
      }
    } catch (err) {
      // One bad upload (quota, transient network error) shouldn't take
      // down the rest of the batch — mirrors render-ranking-videos.ts.
      console.error(`publish ${video.id} failed:`, err instanceof Error ? err.message : err);
      await supabase
        .from("posts")
        .update({ status: "failed", error_message: err instanceof Error ? err.message : String(err) })
        .eq("id", post.id);
    }
  }
  return publishedCount;
}

function parseArgs(argv: string[]): PublishOptions {
  if (argv[0] === "--limit") {
    const limit = Number(argv[1]);
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error(`--limit requires a positive number, got ${JSON.stringify(argv[1])}`);
    }
    return { limit };
  }
  if (argv[0]) {
    return { onlyRankingVideoId: argv[0] };
  }
  return {};
}

if (import.meta.url === `file://${process.argv[1]}`) {
  publishApprovedClips(parseArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
