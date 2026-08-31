// Publishes approved/edited clip_renders to YouTube — the only platform
// with working publish credentials right now (TikTok/Instagram accounts
// are still being warmed up, see memory: publishing_accounts_status).
//
// Three invocation modes:
//   npm run publish-post                      -> publishes every eligible clip
//   npm run publish-post -- <clip_render_id>   -> publishes just one, by id
//   npm run publish-post -- --limit N          -> publishes the top N eligible
//                                                  clips by predicted virality
// --limit is what the scheduled GitHub Actions workflow uses (one run per
// scheduled post) — always taking the strongest remaining content first
// rather than oldest-first, per the plan's virality-first framing (§6).
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
const CATEGORY_ID = "17"; // Sports
const PRIVACY_STATUS =
  (process.env.YOUTUBE_UPLOAD_PRIVACY_STATUS as "private" | "unlisted" | "public" | undefined) ?? "private";

interface EligibleRender {
  id: string;
  storage_path: string | null;
  hook_text: string | null;
  caption: string | null;
  hashtags: string[] | null;
  predicted_virality_score: number | null;
  clips: {
    source_videos: { partner_id: string } | { partner_id: string }[] | null;
  } | null;
}

function partnerIdOf(row: EligibleRender): string | null {
  const clip = row.clips;
  if (!clip) return null;
  const sourceVideo = Array.isArray(clip.source_videos) ? clip.source_videos[0] : clip.source_videos;
  return sourceVideo?.partner_id ?? null;
}

function buildTitle(hookText: string | null): string {
  const base = hookText?.trim() || "Backyard Breaks Clip";
  return base.length > 90 ? `${base.slice(0, 87)}...` : base;
}

function buildDescription(caption: string | null, hashtags: string[] | null): string {
  const tags = (hashtags ?? []).map((h) => `#${h.replace(/^#/, "")}`).join(" ");
  return [caption?.trim(), tags, "#Shorts"].filter(Boolean).join("\n\n");
}

export interface PublishOptions {
  onlyClipRenderId?: string;
  limit?: number;
}

export async function publishApprovedClips(options: PublishOptions = {}) {
  const { onlyClipRenderId, limit } = options;
  const { data: decisions, error: decisionsError } = await supabase
    .from("review_decisions")
    .select("clip_render_id")
    .in("decision", ["approved", "edited"]);
  if (decisionsError) throw decisionsError;
  const approvedIds = new Set((decisions ?? []).map((d) => d.clip_render_id as string));

  const { data: platformRow, error: platformError } = await supabase
    .from("platforms")
    .select("id")
    .eq("name", "youtube")
    .single();
  if (platformError) throw platformError;

  const { data: accounts, error: accountsError } = await supabase
    .from("platform_accounts")
    .select("id, partner_id")
    .eq("platform_id", platformRow.id);
  if (accountsError) throw accountsError;
  const accountByPartner = new Map((accounts ?? []).map((a) => [a.partner_id as string, a.id as string]));
  const accountIds = (accounts ?? []).map((a) => a.id as string);

  // Only 'published' counts as done — a 'failed' row (from a previous
  // attempt) should be retried, not permanently skipped.
  const { data: existingPosts, error: postsError } = await supabase
    .from("posts")
    .select("clip_render_id")
    .in("platform_account_id", accountIds)
    .eq("status", "published");
  if (postsError) throw postsError;
  const postedIds = new Set((existingPosts ?? []).map((p) => p.clip_render_id as string));

  const { data: renders, error: rendersError } = await supabase
    .from("clip_renders")
    .select(
      "id, storage_path, hook_text, caption, hashtags, predicted_virality_score, clips(source_videos(partner_id))"
    )
    .eq("render_status", "ready")
    .order("predicted_virality_score", { ascending: false, nullsFirst: false })
    .returns<EligibleRender[]>();
  if (rendersError) throw rendersError;

  let eligible = (renders ?? []).filter(
    (r) => approvedIds.has(r.id) && !postedIds.has(r.id) && r.storage_path
  );

  if (onlyClipRenderId) {
    eligible = eligible.filter((r) => r.id === onlyClipRenderId);
    if (eligible.length === 0) {
      throw new Error(
        `clip_render ${onlyClipRenderId} isn't eligible — not approved/edited yet, already published, or not render_status='ready'`
      );
    }
  } else if (limit != null) {
    eligible = eligible.slice(0, limit);
  }

  console.log(`${eligible.length} clip(s) eligible for YouTube publish (privacyStatus=${PRIVACY_STATUS})`);

  for (const render of eligible) {
    const partnerId = partnerIdOf(render);
    const platformAccountId = partnerId ? accountByPartner.get(partnerId) : undefined;
    if (!platformAccountId) {
      console.warn(`skip ${render.id}: no youtube platform_account for partner ${partnerId}`);
      continue;
    }

    const { data: post, error: insertError } = await supabase
      .from("posts")
      .insert({
        clip_render_id: render.id,
        platform_account_id: platformAccountId,
        caption: render.caption,
        hashtags: render.hashtags ?? [],
        status: "publishing",
      })
      .select("id")
      .single();
    if (insertError) throw insertError;

    try {
      const { data: signed, error: signError } = await supabase.storage
        .from(MEDIA_BUCKET)
        .createSignedUrl(render.storage_path!, SIGNED_URL_TTL_SECONDS);
      if (signError) throw signError;

      const videoRes = await fetch(signed.signedUrl);
      if (!videoRes.ok) throw new Error(`failed to fetch rendered clip: ${videoRes.status}`);
      const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

      const { videoId, actualPrivacyStatus } = await uploadYoutubeVideo(videoBuffer, {
        title: buildTitle(render.hook_text),
        description: buildDescription(render.caption, render.hashtags),
        tags: [...(render.hashtags ?? []), "Shorts"],
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

      console.log(
        `published ${render.id} -> https://youtube.com/watch?v=${videoId} (actual privacyStatus=${actualPrivacyStatus})`
      );
      if (actualPrivacyStatus !== PRIVACY_STATUS) {
        console.warn(
          `requested privacyStatus=${PRIVACY_STATUS} but YouTube saved it as ${actualPrivacyStatus} — likely the unaudited-API-project restriction, not a bug here`
        );
      }
    } catch (err) {
      // One bad upload (quota, transient network error) shouldn't take
      // down the rest of the batch — mirrors render-clips.ts.
      console.error(`publish ${render.id} failed:`, err instanceof Error ? err.message : err);
      await supabase
        .from("posts")
        .update({ status: "failed", error_message: err instanceof Error ? err.message : String(err) })
        .eq("id", post.id);
    }
  }
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
    return { onlyClipRenderId: argv[0] };
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
