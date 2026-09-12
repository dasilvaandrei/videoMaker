// TikTok Content Posting API — two upload paths:
//   - uploadVideoToInbox (video.upload): lands as a draft in the
//     account's own TikTok inbox, always, regardless of app review
//     status — the account owner still taps "Post" themselves. This is
//     what tiktok-upload-test.ts exercises manually.
//   - publishVideoDirect (video.publish): posts straight to the
//     account, no manual step, via Direct Post. TikTok's own docs say
//     unaudited apps get forced to a restricted (private-only)
//     privacy_level — in practice, this app/account combination already
//     has PUBLIC_TO_EVERYONE available via queryCreatorInfo even before
//     review completes (confirmed against the live API, not assumed).
//     publishVideoDirect still reads the actually-available privacy
//     levels rather than hardcoding one, both because that's what
//     TikTok's docs require calling before every Direct Post, and as a
//     safety net if that ever tightens back up.
//
// See jobs/tiktok-oauth-bootstrap.ts for the one-time manual login flow,
// jobs/tiktok-upload-test.ts for exercising the inbox upload, and
// jobs/publish-tiktok.ts for the Direct Post pipeline job.
//
// IMPORTANT — refresh token rotation: unlike Google's YOUTUBE_REFRESH_TOKEN
// (stable indefinitely), TikTok's docs state the refresh_token returned
// by a refresh call "may be different than the one passed in" and that
// the new value must replace the old one. Every function here that talks
// to the token endpoint returns the (possibly rotated) refreshToken —
// callers are responsible for persisting it; nothing in this file writes
// it anywhere itself.

const AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const INBOX_UPLOAD_INIT_URL = "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/";
const DIRECT_POST_INIT_URL = "https://open.tiktokapis.com/v2/post/publish/video/init/";
const CREATOR_INFO_URL = "https://open.tiktokapis.com/v2/post/publish/creator_info/query/";
const POST_STATUS_URL = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";

function clientKey(): string {
  const key = process.env.TIKTOK_CLIENT_KEY;
  if (!key) throw new Error("TIKTOK_CLIENT_KEY must be set");
  return key;
}

function clientSecret(): string {
  const secret = process.env.TIKTOK_CLIENT_SECRET;
  if (!secret) throw new Error("TIKTOK_CLIENT_SECRET must be set");
  return secret;
}

// PKCE (code_verifier/code_challenge) is required by TikTok for mobile
// and desktop apps only — the web flow used here doesn't need it.
export function buildAuthorizationUrl(redirectUri: string, state: string): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_key", clientKey());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "user.info.basic,video.upload,video.publish");
  url.searchParams.set("state", state);
  return url.toString();
}

export interface TiktokTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  openId: string;
}

function parseTokenResponse(body: Record<string, unknown>): TiktokTokens {
  return {
    accessToken: body.access_token as string,
    refreshToken: body.refresh_token as string,
    expiresIn: body.expires_in as number,
    openId: body.open_id as string,
  };
}

export async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<TiktokTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: clientKey(),
      client_secret: clientSecret(),
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error(`TikTok token exchange failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return parseTokenResponse(body);
}

export async function refreshAccessToken(refreshToken: string): Promise<TiktokTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: clientKey(),
      client_secret: clientSecret(),
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error(`TikTok token refresh failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return parseTokenResponse(body);
}

// Single-chunk upload only — every rendered ranking video is well under
// TikTok's single-chunk ceiling (a 30s 1080x1920 clip runs a few MB), so
// the multi-chunk path isn't implemented; add it if a render ever
// approaches that limit.
export async function uploadVideoToInbox(accessToken: string, videoBuffer: Buffer): Promise<void> {
  const initRes = await fetch(INBOX_UPLOAD_INIT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({
      source_info: {
        source: "FILE_UPLOAD",
        video_size: videoBuffer.length,
        chunk_size: videoBuffer.length,
        total_chunk_count: 1,
      },
    }),
  });
  const initBody = await initRes.json();
  const uploadUrl = initBody?.data?.upload_url;
  if (!initRes.ok || !uploadUrl) {
    throw new Error(`TikTok inbox upload init failed: ${initRes.status} ${JSON.stringify(initBody)}`);
  }

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(videoBuffer.length),
      "Content-Range": `bytes 0-${videoBuffer.length - 1}/${videoBuffer.length}`,
    },
    // Bare `Buffer` parameter types default to the generic
    // Buffer<ArrayBufferLike>, which structurally fails fetch's BodyInit
    // (expects a concrete ArrayBuffer) — the cast is just satisfying that
    // generic mismatch; Node's fetch accepts a real Buffer at runtime.
    body: videoBuffer as unknown as BodyInit,
  });
  if (!putRes.ok) {
    const text = await putRes.text();
    throw new Error(`TikTok video chunk upload failed: ${putRes.status} ${text}`);
  }
}

export interface CreatorInfo {
  privacyLevelOptions: string[];
  maxVideoPostDurationSec: number;
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
}

// TikTok's docs require calling this before every Direct Post — the
// available privacy_level options genuinely vary per account/app-review
// state (see the file header), not just a formality.
export async function queryCreatorInfo(accessToken: string): Promise<CreatorInfo> {
  const res = await fetch(CREATOR_INFO_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
  });
  const body = await res.json();
  if (!res.ok || !body?.data) {
    throw new Error(`TikTok creator_info query failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return {
    privacyLevelOptions: body.data.privacy_level_options ?? [],
    maxVideoPostDurationSec: body.data.max_video_post_duration_sec ?? 0,
    commentDisabled: !!body.data.comment_disabled,
    duetDisabled: !!body.data.duet_disabled,
    stitchDisabled: !!body.data.stitch_disabled,
  };
}

export interface DirectPostOptions {
  title: string;
  // Frame to use as the cover/thumbnail, in milliseconds into the video.
  videoCoverTimestampMs?: number;
}

// Posts straight to the account (no manual "tap Post" step) via Direct
// Post. Returns a publish_id — TikTok processes the post asynchronously,
// so a genuinely public URL isn't available immediately; see
// getPostStatus to poll for PUBLISH_COMPLETE and the real post id.
async function initDirectPost(
  accessToken: string,
  videoBuffer: Buffer,
  options: DirectPostOptions,
  privacyLevel: string
): Promise<{ ok: boolean; errorCode?: string; uploadUrl?: string; publishId?: string; raw: unknown }> {
  const res = await fetch(DIRECT_POST_INIT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({
      post_info: {
        title: options.title,
        privacy_level: privacyLevel,
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
        // Deliberately not disclosed as AI-generated content — only the
        // ~9s intro voiceover is synthetic (ElevenLabs TTS); the actual
        // song footage is real official video and the ranking data is
        // real playcounts/view counts, not AI-generated. A conscious
        // choice, not an oversight — revisit if TikTok's AIGC policy
        // scope changes.
        is_aigc: false,
        ...(options.videoCoverTimestampMs != null
          ? { video_cover_timestamp_ms: options.videoCoverTimestampMs }
          : {}),
      },
      source_info: {
        source: "FILE_UPLOAD",
        video_size: videoBuffer.length,
        chunk_size: videoBuffer.length,
        total_chunk_count: 1,
      },
    }),
  });
  const body = await res.json();
  return {
    ok: res.ok && !!body?.data?.upload_url && !!body?.data?.publish_id,
    errorCode: body?.error?.code,
    uploadUrl: body?.data?.upload_url,
    publishId: body?.data?.publish_id,
    raw: body,
  };
}

export async function publishVideoDirect(
  accessToken: string,
  videoBuffer: Buffer,
  options: DirectPostOptions
): Promise<string> {
  const creatorInfo = await queryCreatorInfo(accessToken);
  const preferredPrivacyLevel = creatorInfo.privacyLevelOptions.includes("PUBLIC_TO_EVERYONE")
    ? "PUBLIC_TO_EVERYONE"
    : creatorInfo.privacyLevelOptions[0];
  if (!preferredPrivacyLevel) throw new Error("TikTok creator_info returned no privacy_level_options");

  let result = await initDirectPost(accessToken, videoBuffer, options, preferredPrivacyLevel);

  // creator_info's privacy_level_options is apparently not authoritative
  // for what the actual init call enforces — confirmed for real in
  // production: it listed PUBLIC_TO_EVERYONE as available, but the
  // account is still genuinely being treated as unaudited by this
  // endpoint specifically, which rejects it with this exact error code.
  // Falling back to SELF_ONLY here — a private-but-successful post the
  // operator can manually reshare — rather than failing the whole
  // pipeline day over it. Once (if) TikTok's review actually approves
  // the app, this error stops occurring and the preferred (public)
  // attempt above just succeeds on the first try, no code change needed.
  if (!result.ok && result.errorCode === "unaudited_client_can_only_post_to_private_accounts" && preferredPrivacyLevel !== "SELF_ONLY") {
    console.warn(
      "TikTok rejected PUBLIC_TO_EVERYONE despite creator_info listing it as available — falling back to SELF_ONLY (private) for this post."
    );
    result = await initDirectPost(accessToken, videoBuffer, options, "SELF_ONLY");
  }

  if (!result.ok || !result.uploadUrl || !result.publishId) {
    throw new Error(`TikTok direct post init failed: ${JSON.stringify(result.raw)}`);
  }
  const uploadUrl = result.uploadUrl;
  const publishId = result.publishId;

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(videoBuffer.length),
      "Content-Range": `bytes 0-${videoBuffer.length - 1}/${videoBuffer.length}`,
    },
    body: videoBuffer as unknown as BodyInit,
  });
  if (!putRes.ok) {
    const text = await putRes.text();
    throw new Error(`TikTok video chunk upload failed: ${putRes.status} ${text}`);
  }

  return publishId;
}

export interface PostStatus {
  // PROCESSING_UPLOAD | PROCESSING_DOWNLOAD | SEND_TO_USER_INBOX |
  // PUBLISH_COMPLETE | FAILED
  status: string;
  // Empty until status is PUBLISH_COMPLETE. Yes, "publicaly" — that's
  // TikTok's actual (misspelled) field name, not a typo introduced here.
  publiclyAvailablePostIds: string[];
  failReason?: string;
}

export async function getPostStatus(accessToken: string, publishId: string): Promise<PostStatus> {
  const res = await fetch(POST_STATUS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({ publish_id: publishId }),
  });
  const body = await res.json();
  if (!res.ok || !body?.data) {
    throw new Error(`TikTok post status fetch failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return {
    status: body.data.status,
    publiclyAvailablePostIds: body.data.publicaly_available_post_id ?? [],
    failReason: body.data.fail_reason,
  };
}
