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

// Lowercase, accents removed ("Sebastián" → "sebastian"), punctuation and
// spaces dropped — but letters in other scripts kept, so a channel like
// "韓国 JIN" doesn't collapse to "jin" and pass as the artist Jin.
function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

// Whether a channel's title or @handle is the artist's name, give or take
// a few conventional extras ("SnoopDoggTV", "CalvinHarrisVEVO", "The
// Burning Spear"). Looser "contains" matching picked wrong channels for
// common or short names — "Duke Ellington School of the Arts", "Maurizio
// Merluzzo", "Clan Giant Swan", "NotVendex".
const NAME_PREFIXES = ["", "the", "official"];
const NAME_SUFFIXES = ["", "vevo", "tv", "official", "music", "band"];
function matchesArtist(channel: { title: string; handle: string }, artistName: string): boolean {
  const artist = normalizeName(artistName).replace(/^the/, "");
  if (!artist) return false;
  const forms = new Set(NAME_PREFIXES.flatMap((p) => NAME_SUFFIXES.map((s) => `${p}${artist}${s}`)));
  return forms.has(normalizeName(channel.title)) || forms.has(normalizeName(channel.handle));
}

// Near-empty impostor channels often copy an artist's exact name (several
// titled "Snoop Dogg" with under 100 subscribers); a real artist channel
// clears this easily.
const MIN_CHANNEL_SUBSCRIBERS = 10_000;

// For roster artists without a pre-verified youtubeChannelId (the roster
// is too big to hand-verify every channel). fetch-youtube-rankings.ts
// caches the result in artists.youtube_channel_id, so this runs once per
// artist.
//
// Taking the first search result picked wrong channels: for "Pink Floyd"
// it returned "PINK FLOYD - Topic" (YouTube's auto-generated art-track
// channel, a fraction of the views), and a fan channel ranked second —
// the real @pinkfloyd was 7th. So: skip "- Topic" channels (their uploads
// can't be listed through the API anyway), keep channels whose name or
// handle is the artist's (see matchesArtist) with real subscriber counts,
// and take the biggest. Returns null when nothing qualifies — common for
// older or underground artists with no official channel — rather than
// guessing; the pipeline uses the Last.fm ranking for them instead.
export async function searchOfficialChannel(artistName: string): Promise<string | null> {
  const url = new URL(`${DATA_API_BASE}/search`);
  url.search = new URLSearchParams({
    key: apiKey(),
    q: artistName,
    part: "snippet",
    type: "channel",
    maxResults: "10",
  }).toString();

  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(`YouTube channel search failed for ${JSON.stringify(artistName)}: ${res.status} ${JSON.stringify(body)}`);
  const channelIds: string[] = (body.items ?? []).map((i: { snippet?: { channelId?: string } }) => i.snippet?.channelId).filter(Boolean);
  if (channelIds.length === 0) return null;

  const statsUrl = new URL(`${DATA_API_BASE}/channels`);
  statsUrl.search = new URLSearchParams({ key: apiKey(), id: channelIds.join(","), part: "snippet,statistics" }).toString();
  const statsRes = await fetch(statsUrl);
  const statsBody = await statsRes.json();
  if (!statsRes.ok) throw new Error(`YouTube channels.list failed for ${JSON.stringify(artistName)}: ${statsRes.status} ${JSON.stringify(statsBody)}`);

  type Candidate = { id: string; title: string; handle: string; subscribers: number };
  const candidates: Candidate[] = (statsBody.items ?? [])
    .map((c: { id: string; snippet?: { title?: string; customUrl?: string }; statistics?: { subscriberCount?: string } }) => ({
      id: c.id,
      title: c.snippet?.title ?? "",
      handle: c.snippet?.customUrl ?? "",
      subscribers: Number(c.statistics?.subscriberCount ?? 0),
    }))
    .filter((c: Candidate) => !/ - Topic$/i.test(c.title))
    .sort((a: Candidate, b: Candidate) => b.subscribers - a.subscribers);

  const match = candidates.find((c) => c.subscribers >= MIN_CHANNEL_SUBSCRIBERS && matchesArtist(c, artistName));
  return match?.id ?? null;
}

// The artist's channel profile photo — used as the intro's split-screen
// top half (see jobs/generate-intro-vo.ts). Cached once per artist in
// artists.avatar_url, same as searchOfficialChannel's channel id.
export async function getChannelThumbnailUrl(channelId: string): Promise<string | null> {
  const url = new URL(`${DATA_API_BASE}/channels`);
  url.search = new URLSearchParams({
    key: apiKey(),
    id: channelId,
    part: "snippet",
  }).toString();

  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(`YouTube channels.list failed for ${channelId}: ${res.status} ${JSON.stringify(body)}`);
  const thumbnails = body.items?.[0]?.snippet?.thumbnails;
  return thumbnails?.high?.url ?? thumbnails?.medium?.url ?? thumbnails?.default?.url ?? null;
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
