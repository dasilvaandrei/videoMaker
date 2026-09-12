// One-off manual script: uploads the most recently rendered ranking
// video to the authorized TikTok account's inbox as a draft. Not part of
// the daily pipeline — exists to exercise the real login+upload flow
// once (see lib/tiktok.ts and tiktok-oauth-bootstrap.ts) so there's a
// real screen recording to submit as TikTok's App Review demo video, and
// later as the basis for a real publish-tiktok.ts job once this account
// is off warm-up (see memory: publishing_accounts_status).
//
// Requires TIKTOK_REFRESH_TOKEN in .env, set from tiktok-oauth-bootstrap.ts's
// output. Since TikTok can rotate the refresh token on every use, this
// script prints whatever value comes back so .env can be updated before
// the next run — it does not write .env itself.

import { refreshAccessToken, uploadVideoToInbox } from "../lib/tiktok.js";
import { supabase } from "../lib/supabase.js";

const MEDIA_BUCKET = "media";
const SIGNED_URL_TTL_SECONDS = 60 * 10;

interface ReadyVideo {
  id: string;
  storage_path: string | null;
  title: string | null;
  created_at: string;
}

async function main() {
  const refreshToken = process.env.TIKTOK_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error("TIKTOK_REFRESH_TOKEN must be set — run tiktok-oauth-bootstrap.ts first");
  }

  const { data: video, error: videoError } = await supabase
    .from("ranking_videos")
    .select("id, storage_path, title, created_at")
    .eq("render_status", "ready")
    .not("storage_path", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .single<ReadyVideo>();
  if (videoError) throw videoError;

  console.log(`uploading ${video.id} ("${video.title ?? "untitled"}") to TikTok inbox...`);

  const { data: signed, error: signError } = await supabase.storage
    .from(MEDIA_BUCKET)
    .createSignedUrl(video.storage_path!, SIGNED_URL_TTL_SECONDS);
  if (signError) throw signError;

  const videoRes = await fetch(signed.signedUrl);
  if (!videoRes.ok) throw new Error(`failed to fetch rendered video: ${videoRes.status}`);
  const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

  const tokens = await refreshAccessToken(refreshToken);
  if (tokens.refreshToken !== refreshToken) {
    console.warn(
      "\nTikTok issued a NEW refresh token — update .env's TIKTOK_REFRESH_TOKEN to:\n" + tokens.refreshToken + "\n"
    );
  }

  await uploadVideoToInbox(tokens.accessToken, videoBuffer);
  console.log(`uploaded ${video.id} — check the TikTok app's inbox on @dasilvaandrei for the draft`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
