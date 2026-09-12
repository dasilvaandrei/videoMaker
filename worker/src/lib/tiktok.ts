// TikTok Content Posting API — video.upload scope only. This uploads a
// video as a draft into the authorized account's own TikTok inbox; it
// never publishes live. That's a deliberate choice, not a limitation to
// work around: the inbox-upload endpoint (used here) always lands as a
// draft regardless of app review status, unlike Direct Post
// (video.publish), which additionally forces private-only visibility
// until the app passes TikTok's review. Since the account owner is
// already going to tap "Post" themselves (see the project's publishing
// policy for TikTok), there's no reason to chase the audited/direct-post
// path at all right now.
//
// See jobs/tiktok-oauth-bootstrap.ts for the one-time manual login flow
// and jobs/tiktok-upload-test.ts for exercising the upload end-to-end.
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
  url.searchParams.set("scope", "user.info.basic,video.upload");
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
