// Publishes approved/edited ranking_videos to TikTok's inbox as drafts
// — the reliable fallback while Direct Post (video.publish) remains
// blocked by TikTok's pending app review. Confirmed in production: the
// Direct Post endpoint hard-rejects every call from this unaudited app
// with "unaudited_client_can_only_post_to_private_accounts", even when
// explicitly requesting SELF_ONLY (private) — not a privacy_level
// problem, an app-review gate with no current workaround. See
// lib/tiktok.ts's publishVideoDirect, kept intact for once review
// actually approves the app.
//
// Lands in the account's TikTok inbox; the operator still has to open
// the app and tap Post themselves — no live/public step happens
// automatically. IMPORTANT: unlike Direct Post, the inbox-upload
// endpoint has no caption/title field at all (see uploadVideoToInbox)
// — the video arrives with nothing pre-filled, so the caption/hashtags/
// affiliate disclosure has to be copied in by hand from
// ranking_videos.caption when finishing the post.
//
// Marks posts.status='published' once the video is successfully sent
// to the inbox (not once it's actually posted publicly, which needs the
// manual step) — same "close enough for dedup" treatment already used
// for Dua Lipa's manually-posted backfill record, so a given video
// never gets sent to the inbox twice.
//
// Same invocation shape as the other publish jobs:
//   npm run publish-tiktok-inbox                      -> every eligible video
//   npm run publish-tiktok-inbox -- <ranking_video_id> -> just one, by id
//   npm run publish-tiktok-inbox -- --limit N          -> oldest N eligible

import { refreshAccessToken, uploadVideoToInbox } from "../lib/tiktok.js";
import { supabase } from "../lib/supabase.js";

const MEDIA_BUCKET = "media";
const SIGNED_URL_TTL_SECONDS = 60 * 10;

interface EligibleVideo {
  id: string;
  storage_path: string | null;
  title: string | null;
  caption: string | null;
  hashtags: string[] | null;
  created_at: string;
}

export interface PublishOptions {
  onlyRankingVideoId?: string;
  limit?: number;
}

export async function publishToTiktokInbox(options: PublishOptions = {}): Promise<number> {
  const refreshToken = process.env.TIKTOK_REFRESH_TOKEN;
  if (!refreshToken) throw new Error("TIKTOK_REFRESH_TOKEN must be set — run tiktok-oauth-bootstrap.ts first");

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
    .eq("name", "tiktok")
    .single();
  if (platformError) throw platformError;

  const { data: account, error: accountError } = await supabase
    .from("platform_accounts")
    .select("id")
    .eq("platform_id", platformRow.id)
    .single();
  if (accountError) throw accountError;

  const { data: existingPosts, error: postsError } = await supabase
    .from("posts")
    .select("ranking_video_id")
    .eq("platform_account_id", account.id)
    .eq("status", "published");
  if (postsError) throw postsError;
  const postedIds = new Set((existingPosts ?? []).map((p) => p.ranking_video_id as string));

  const { data: videos, error: videosError } = await supabase
    .from("ranking_videos")
    .select("id, storage_path, title, caption, hashtags, created_at")
    .eq("render_status", "ready")
    .order("created_at", { ascending: true })
    .returns<EligibleVideo[]>();
  if (videosError) throw videosError;

  let eligible = (videos ?? []).filter((v) => approvedIds.has(v.id) && !postedIds.has(v.id) && v.storage_path);

  if (onlyRankingVideoId) {
    eligible = eligible.filter((v) => v.id === onlyRankingVideoId);
    if (eligible.length === 0) {
      throw new Error(
        `ranking_video ${onlyRankingVideoId} isn't eligible — not approved/edited yet, already sent to TikTok inbox, or not render_status='ready'`
      );
    }
  } else if (limit != null) {
    eligible = eligible.slice(0, limit);
  }

  console.log(`${eligible.length} ranking video(s) eligible for TikTok inbox upload`);

  // Refreshed once up front and reused for the whole batch — see
  // publish-tiktok.ts's identical reasoning (a mid-batch rotation would
  // otherwise invalidate the token this function started with).
  const tokens = await refreshAccessToken(refreshToken);
  if (tokens.refreshToken !== refreshToken) {
    console.warn(
      "\nTikTok issued a NEW refresh token — update TIKTOK_REFRESH_TOKEN (.env and the GitHub secret) to:\n" +
        tokens.refreshToken +
        "\n"
    );
  }

  let sentCount = 0;
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
      const { data: signed, error: signError } = await supabase.storage
        .from(MEDIA_BUCKET)
        .createSignedUrl(video.storage_path!, SIGNED_URL_TTL_SECONDS);
      if (signError) throw signError;

      const videoRes = await fetch(signed.signedUrl);
      if (!videoRes.ok) throw new Error(`failed to fetch rendered video: ${videoRes.status}`);
      const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

      await uploadVideoToInbox(tokens.accessToken, videoBuffer);

      const { error: updateError } = await supabase
        .from("posts")
        .update({
          status: "published",
          error_message:
            "Sent to TikTok inbox as a draft — needs manual tap-to-post in the app (no caption pre-filled; copy from ranking_videos.caption).",
          published_at: new Date().toISOString(),
        })
        .eq("id", post.id);
      if (updateError) throw updateError;

      sentCount++;
      console.log(`sent ${video.id} to TikTok inbox — open the app to finish posting`);
    } catch (err) {
      // One bad send shouldn't take down the rest of the batch — mirrors
      // publish-tiktok.ts / publish-post.ts.
      console.error(`send-to-inbox ${video.id} failed:`, err instanceof Error ? err.message : err);
      await supabase
        .from("posts")
        .update({ status: "failed", error_message: err instanceof Error ? err.message : String(err) })
        .eq("id", post.id);
    }
  }
  return sentCount;
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
  publishToTiktokInbox(parseArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
