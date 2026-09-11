// YouTube Data API v3 — upload (OAuth) plus read-only lookups (API key)
// used to resolve official music videos and pull channel view counts for
// the ranking pipeline. Upload is a simple multipart upload (not the
// chunked resumable protocol) since our rendered clips are tens of MB,
// not GBs; resumable is worth adding later only if flaky-connection
// retries actually become a problem.

import { randomUUID } from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status";
const DATA_API_BASE = "https://www.googleapis.com/youtube/v3";

function apiKey(): string {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error("YOUTUBE_API_KEY must be set");
  return key;
}

// "PT3M45S" -> 225. YouTube's contentDetails.duration is always ISO 8601
// with only hour/minute/second components for a regular video.
function parseIso8601Duration(iso: string): number {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!match) return 0;
  const [, h, m, s] = match;
  return (Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0));
}

export interface YoutubeVideoInfo {
  videoId: string;
  title: string;
  durationSeconds: number;
  viewCount: number;
}

export async function searchOfficialVideo(query: string): Promise<string | null> {
  const url = new URL(`${DATA_API_BASE}/search`);
  url.search = new URLSearchParams({
    key: apiKey(),
    q: query,
    part: "id",
    type: "video",
    maxResults: "1",
    videoEmbeddable: "true",
  }).toString();

  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(`YouTube search failed for ${JSON.stringify(query)}: ${res.status} ${JSON.stringify(body)}`);
  return body.items?.[0]?.id?.videoId ?? null;
}

export async function getVideosInfo(videoIds: string[]): Promise<YoutubeVideoInfo[]> {
  if (videoIds.length === 0) return [];
  const results: YoutubeVideoInfo[] = [];

  // videos.list caps at 50 ids per call.
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const url = new URL(`${DATA_API_BASE}/videos`);
    url.search = new URLSearchParams({
      key: apiKey(),
      id: batch.join(","),
      part: "snippet,statistics,contentDetails",
    }).toString();

    const res = await fetch(url);
    const body = await res.json();
    if (!res.ok) throw new Error(`YouTube videos.list failed: ${res.status} ${JSON.stringify(body)}`);

    for (const item of body.items ?? []) {
      results.push({
        videoId: item.id,
        title: item.snippet?.title ?? "",
        durationSeconds: parseIso8601Duration(item.contentDetails?.duration ?? "PT0S"),
        viewCount: Number(item.statistics?.viewCount ?? 0),
      });
    }
  }
  return results;
}

// Every channel has one auto-generated "uploads" playlist containing all
// its public videos, in upload order — cheaper to page through than
// search.list (which costs 100 quota units/call vs 1 for playlistItems).
export async function getChannelVideoIds(channelId: string, maxVideos = 50): Promise<string[]> {
  const channelUrl = new URL(`${DATA_API_BASE}/channels`);
  channelUrl.search = new URLSearchParams({
    key: apiKey(),
    id: channelId,
    part: "contentDetails",
  }).toString();
  const channelRes = await fetch(channelUrl);
  const channelBody = await channelRes.json();
  if (!channelRes.ok) {
    throw new Error(`YouTube channels.list failed for ${channelId}: ${channelRes.status} ${JSON.stringify(channelBody)}`);
  }
  const uploadsPlaylistId = channelBody.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) return [];

  const videoIds: string[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${DATA_API_BASE}/playlistItems`);
    url.search = new URLSearchParams({
      key: apiKey(),
      playlistId: uploadsPlaylistId,
      part: "contentDetails",
      maxResults: "50",
      ...(pageToken ? { pageToken } : {}),
    }).toString();
    const res = await fetch(url);
    const body = await res.json();
    if (!res.ok) throw new Error(`YouTube playlistItems.list failed: ${res.status} ${JSON.stringify(body)}`);

    for (const item of body.items ?? []) {
      const id = item.contentDetails?.videoId;
      if (id) videoIds.push(id);
    }
    pageToken = body.nextPageToken;
  } while (pageToken && videoIds.length < maxVideos);

  return videoIds.slice(0, maxVideos);
}

async function getAccessToken(): Promise<string> {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, and YOUTUBE_REFRESH_TOKEN must be set");
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`YouTube token refresh failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body.access_token as string;
}

export interface YoutubeUploadMetadata {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacyStatus: "private" | "unlisted" | "public";
}

export interface YoutubeUploadResult {
  videoId: string;
  // What YouTube actually saved, not necessarily what was requested —
  // unaudited API projects have historically had public/unlisted uploads
  // silently downgraded to private. Always check this rather than
  // assuming the request was honored.
  actualPrivacyStatus: string;
}

export async function uploadYoutubeVideo(
  videoBuffer: Buffer,
  metadata: YoutubeUploadMetadata
): Promise<YoutubeUploadResult> {
  const accessToken = await getAccessToken();
  const boundary = `videomaker-${randomUUID()}`;

  const metadataJson = JSON.stringify({
    snippet: {
      title: metadata.title,
      description: metadata.description,
      tags: metadata.tags,
      categoryId: metadata.categoryId,
    },
    status: {
      privacyStatus: metadata.privacyStatus,
      // Required by the API — this is licensed sports-card-break content
      // for adult collectors, not child-directed, so always false.
      selfDeclaredMadeForKids: false,
    },
  });

  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataJson}\r\n--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`
    ),
    videoBuffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const res = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
      "Content-Length": String(body.length),
    },
    body,
  });

  const responseBody = await res.json();
  if (!res.ok) {
    throw new Error(`YouTube upload failed: ${res.status} ${JSON.stringify(responseBody)}`);
  }
  return {
    videoId: responseBody.id as string,
    actualPrivacyStatus: responseBody.status?.privacyStatus as string,
  };
}
