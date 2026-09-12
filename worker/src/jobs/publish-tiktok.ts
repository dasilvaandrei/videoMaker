// Publishes approved/edited ranking_videos to TikTok via Direct Post
// (video.publish) — posts straight to the account, no manual step,
// unlike tiktok-upload-test.ts's inbox/draft upload. See lib/tiktok.ts's
// header: privacy_level comes from queryCreatorInfo rather than being
// hardcoded — PUBLIC_TO_EVERYONE is confirmed available for this
// account already (checked against the live API), so this posts
// genuinely public, not the private-only fallback TikTok's docs
// describe for a typical unaudited app.
//
// NOT yet wired into run-daily-pipeline.ts — TikTok's refresh_token can
// rotate on every use (see lib/tiktok.ts), and there's no persistence
// mechanism yet for an unattended job to save a rotated token back to
// .env/GitHub secrets on its own. Run this by hand for now; wiring it
// into the daily cron needs that solved first (e.g. storing the token
// in Supabase instead of a static secret).
//
// Same invocation shape as publish-post.ts:
//   npm run publish-tiktok                      -> every eligible video
//   npm run publish-tiktok -- <ranking_video_id> -> just one, by id
//   npm run publish-tiktok -- --limit N          -> oldest N eligible

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshAccessToken, publishVideoDirect, getPostStatus } from "../lib/tiktok.js";
import { probeDurationSeconds } from "../lib/ffmpeg.js";
import { supabase } from "../lib/supabase.js";

const MEDIA_BUCKET = "media";
const SIGNED_URL_TTL_SECONDS = 60 * 10;
// TikTok's post_info.title is the only text field — no separate
// description field like YouTube — so title + caption + hashtags all
// get combined into it. 2200 UTF-16 code units is TikTok's documented
// max; the generated copy never gets close, but truncate defensively
// rather than let a future longer caption fail the API call outright.
const MAX_TITLE_LENGTH = 2200;
// TikTok processes a Direct Post asynchronously — poll status/fetch
// rather than trust the initial call. 10 attempts x 3s stays well under
// TikTok's 30-requests/minute limit on this endpoint.
const STATUS_POLL_ATTEMPTS = 10;
const STATUS_POLL_INTERVAL_MS = 3000;

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

function buildTikTokCaption(video: EligibleVideo): string {
  const hashtagLine = (video.hashtags ?? []).map((h) => `#${h.replace(/^#/, "")}`).join(" ");
  const combined = [video.title, video.caption, hashtagLine].filter(Boolean).join("\n\n");
  return combined.length > MAX_TITLE_LENGTH ? combined.slice(0, MAX_TITLE_LENGTH) : combined;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Returns the public post id(s) once status is PUBLISH_COMPLETE. Throws
// for FAILED or if it's still processing after STATUS_POLL_ATTEMPTS — a
// genuinely completed post that just took longer than ~30s to register
// would still show as a 'failed' posts row in that timeout case, a minor
// bookkeeping inaccuracy accepted over leaving the row in permanent
// ambiguous limbo.
async function pollUntilComplete(accessToken: string, publishId: string): Promise<string[]> {
  for (let attempt = 0; attempt < STATUS_POLL_ATTEMPTS; attempt++) {
    const status = await getPostStatus(accessToken, publishId);
    if (status.status === "PUBLISH_COMPLETE") return status.publiclyAvailablePostIds;
    if (status.status === "FAILED") throw new Error(`TikTok post failed: ${status.failReason ?? "unknown reason"}`);
    await sleep(STATUS_POLL_INTERVAL_MS);
  }
  throw new Error(`TikTok post ${publishId} did not complete within ${STATUS_POLL_ATTEMPTS} status checks`);
}

export async function publishToTiktok(options: PublishOptions = {}): Promise<number> {
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
        `ranking_video ${onlyRankingVideoId} isn't eligible — not approved/edited yet, already posted to TikTok, or not render_status='ready'`
      );
    }
  } else if (limit != null) {
    eligible = eligible.slice(0, limit);
  }

  console.log(`${eligible.length} ranking video(s) eligible for TikTok publish`);

  // TikTok may rotate the refresh token on this very call — refreshed
  // once up front and reused for every video in this batch rather than
  // per-video, since a mid-batch rotation would otherwise invalidate the
  // token this function started with.
  const tokens = await refreshAccessToken(refreshToken);
  if (tokens.refreshToken !== refreshToken) {
    console.warn(
      "\nTikTok issued a NEW refresh token — update .env's TIKTOK_REFRESH_TOKEN to:\n" + tokens.refreshToken + "\n"
    );
  }

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

    const dir = await mkdtemp(join(tmpdir(), "tiktok-publish-"));
    try {
      const { data: signed, error: signError } = await supabase.storage
        .from(MEDIA_BUCKET)
        .createSignedUrl(video.storage_path!, SIGNED_URL_TTL_SECONDS);
      if (signError) throw signError;

      const videoRes = await fetch(signed.signedUrl);
      if (!videoRes.ok) throw new Error(`failed to fetch rendered video: ${videoRes.status}`);
      const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

      // Cover frame near the very end (the #1 song's freeze-frame
      // moment) — same "make the auto-picked thumbnail a strong frame"
      // intent as Root.tsx's FREEZE_FRAMES for YouTube's thumbnail.
      const tempVideoPath = join(dir, "video.mp4");
      await writeFile(tempVideoPath, videoBuffer);
      const durationSeconds = await probeDurationSeconds(tempVideoPath);
      const videoCoverTimestampMs =
        durationSeconds != null ? Math.max(0, Math.round(durationSeconds * 1000) - 500) : undefined;

      const publishId = await publishVideoDirect(tokens.accessToken, videoBuffer, {
        title: buildTikTokCaption(video),
        videoCoverTimestampMs,
      });
      const publicPostIds = await pollUntilComplete(tokens.accessToken, publishId);

      const { error: updateError } = await supabase
        .from("posts")
        .update({
          status: "published",
          external_post_id: publicPostIds[0] ?? publishId,
          published_at: new Date().toISOString(),
        })
        .eq("id", post.id);
      if (updateError) throw updateError;

      publishedCount++;
      if (publicPostIds[0]) {
        console.log(`published ${video.id} -> https://www.tiktok.com/@dasilvaandrei/video/${publicPostIds[0]}`);
      } else {
        console.log(
          `published ${video.id} (publish_id=${publishId}) — no public post id yet, likely still private/self-only pending app review`
        );
      }
    } catch (err) {
      // One bad publish (quota, transient network error, processing
      // timeout) shouldn't take down the rest of the batch — mirrors
      // publish-post.ts / render-ranking-videos.ts.
      console.error(`publish ${video.id} failed:`, err instanceof Error ? err.message : err);
      await supabase
        .from("posts")
        .update({ status: "failed", error_message: err instanceof Error ? err.message : String(err) })
        .eq("id", post.id);
    } finally {
      await rm(dir, { recursive: true, force: true });
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
  publishToTiktok(parseArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
