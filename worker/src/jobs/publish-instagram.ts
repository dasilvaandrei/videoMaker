// Publishes approved/edited ranking_videos to Instagram as Reels —
// posts straight to the account, no manual step, same shape as
// publish-tiktok.ts / publish-post.ts. See lib/meta.ts for why this
// went through the real OAuth flow instead of the Meta dashboard's
// token shortcut.
//
// NOT yet wired into run-daily-pipeline.ts — deliberately kept manual
// until this account/token has a real successful run to prove out
// (same caution as publish-tiktok.ts before it went into the cron).
//
// Same invocation shape as the other publish jobs:
//   npm run publish-instagram                      -> every eligible video
//   npm run publish-instagram -- <ranking_video_id> -> just one, by id
//   npm run publish-instagram -- --limit N          -> oldest N eligible

import { createMediaContainer, getContainerStatus, publishMediaContainer } from "../lib/meta.js";
import { supabase } from "../lib/supabase.js";

const MEDIA_BUCKET = "media";
const SIGNED_URL_TTL_SECONDS = 60 * 30;
const MAX_CAPTION_LENGTH = 2200;
// Instagram processes the video server-side after fetching it from the
// URL we give it — polling rather than trusting the container's created
// as immediately publishable. 20 attempts x 5s = up to ~100s, generous
// for a ~65s clip.
const STATUS_POLL_ATTEMPTS = 20;
const STATUS_POLL_INTERVAL_MS = 5000;

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

function buildInstagramCaption(video: EligibleVideo): string {
  const hashtagLine = (video.hashtags ?? []).map((h) => `#${h.replace(/^#/, "")}`).join(" ");
  const combined = [video.title, video.caption, hashtagLine].filter(Boolean).join("\n\n");
  return combined.length > MAX_CAPTION_LENGTH ? combined.slice(0, MAX_CAPTION_LENGTH) : combined;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilFinished(containerId: string, accessToken: string): Promise<void> {
  for (let attempt = 0; attempt < STATUS_POLL_ATTEMPTS; attempt++) {
    const { status, statusDetail } = await getContainerStatus(containerId, accessToken);
    if (status === "FINISHED") return;
    if (status === "ERROR" || status === "EXPIRED") {
      throw new Error(`Instagram container ${containerId} failed: ${status}${statusDetail ? ` (${statusDetail})` : ""}`);
    }
    await sleep(STATUS_POLL_INTERVAL_MS);
  }
  throw new Error(`Instagram container ${containerId} did not finish processing within ${STATUS_POLL_ATTEMPTS} checks`);
}

export async function publishToInstagram(options: PublishOptions = {}): Promise<number> {
  const accessToken = process.env.META_ACCESS_TOKEN;
  const igUserId = process.env.META_INSTAGRAM_USER_ID;
  if (!accessToken) throw new Error("META_ACCESS_TOKEN must be set — run instagram-oauth-bootstrap.ts first");
  if (!igUserId) throw new Error("META_INSTAGRAM_USER_ID must be set — the verified id from instagram-oauth-bootstrap.ts's output");

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
    .eq("name", "instagram")
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
        `ranking_video ${onlyRankingVideoId} isn't eligible — not approved/edited yet, already posted to Instagram, or not render_status='ready'`
      );
    }
  } else if (limit != null) {
    eligible = eligible.slice(0, limit);
  }

  console.log(`${eligible.length} ranking video(s) eligible for Instagram publish`);

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
      const { data: signed, error: signError } = await supabase.storage
        .from(MEDIA_BUCKET)
        .createSignedUrl(video.storage_path!, SIGNED_URL_TTL_SECONDS);
      if (signError) throw signError;

      const containerId = await createMediaContainer(igUserId, accessToken, signed.signedUrl, buildInstagramCaption(video));
      await waitUntilFinished(containerId, accessToken);
      const mediaId = await publishMediaContainer(igUserId, accessToken, containerId);

      const { error: updateError } = await supabase
        .from("posts")
        .update({ status: "published", external_post_id: mediaId, published_at: new Date().toISOString() })
        .eq("id", post.id);
      if (updateError) throw updateError;

      publishedCount++;
      console.log(`published ${video.id} -> https://www.instagram.com/reel/${mediaId}/`);
    } catch (err) {
      // One bad publish shouldn't take down the rest of the batch —
      // mirrors publish-tiktok.ts / publish-post.ts.
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
  publishToInstagram(parseArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
