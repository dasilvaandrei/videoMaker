// Google Drive access for "anyone with the link" shared files — this is
// what campaigns like Backyard Breaks actually use to hand out source
// content. Sheets still export anonymously as CSV with no credentials
// needed. Individual clip files use the real Drive API v3 (GOOGLE_DRIVE_API_KEY)
// rather than the anonymous drive.google.com/uc?export=download URL — that
// anonymous endpoint shows a virus-scan HTML interstitial for some files,
// which looked at first like a size cutoff but the API hits the identical
// wall on the same files with a precise reason: "downloadQuotaExceeded", a
// per-file Google-side quota shared across everyone downloading that file
// (heavily-downloaded campaign files exhaust it fast). Neither auth method
// gets around that — it just needs the quota window to reset (commonly
// ~24h) — but the API gives an unambiguous reason instead of guessing from
// an HTML response, which the code below distinguishes explicitly.

const DRIVE_API_KEY = process.env.GOOGLE_DRIVE_API_KEY;

export function extractDriveFileId(url: string): string | null {
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/) ?? url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

export class DriveQuotaExceededError extends Error {}

export function driveFileMediaUrl(fileId: string): string {
  if (!DRIVE_API_KEY) {
    throw new Error("GOOGLE_DRIVE_API_KEY must be set");
  }
  return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${DRIVE_API_KEY}`;
}

export async function fetchDriveFile(fileId: string): Promise<Response> {
  const res = await fetch(driveFileMediaUrl(fileId));
  if (!res.ok) {
    // Read the body exactly once, as text, regardless of which error path
    // this is — reading it twice (e.g. .json() then .text()) throws "Body
    // has already been read" and masks the real error.
    const bodyText = await res.text();
    if (res.status === 403) {
      const parsed = (() => {
        try {
          return JSON.parse(bodyText);
        } catch {
          return null;
        }
      })();
      if (parsed?.error?.errors?.[0]?.reason === "downloadQuotaExceeded") {
        throw new DriveQuotaExceededError(`download quota exceeded for file ${fileId}`);
      }
    }
    throw new Error(`Drive API download failed for ${fileId}: ${res.status} ${bodyText}`);
  }
  return res;
}

export function sheetCsvExportUrl(sheetIdOrUrl: string): string {
  const id = sheetIdOrUrl.match(/\/d\/([a-zA-Z0-9_-]+)/)?.[1] ?? sheetIdOrUrl;
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
}

// storage_path convention for source content we never copy into Supabase
// Storage: campaign source videos can be large enough to hit the project's
// per-file storage cap (confirmed: even a bucket-level override gets
// rejected on this plan), and we don't need a durable copy of raw source
// footage anyway — only the rendered output needs to persist. So
// source_videos.storage_path for Drive-delivered content is a lightweight
// "drive:<fileId>" reference; whatever reads it (e.g. the render step)
// re-fetches the actual bytes on demand via fetchDriveFile and discards
// them after use, rather than treating this as a real Supabase Storage path.
const DRIVE_STORAGE_PREFIX = "drive:";

export function driveStoragePath(fileId: string): string {
  return `${DRIVE_STORAGE_PREFIX}${fileId}`;
}

export function parseDriveStoragePath(storagePath: string): string | null {
  return storagePath.startsWith(DRIVE_STORAGE_PREFIX) ? storagePath.slice(DRIVE_STORAGE_PREFIX.length) : null;
}
