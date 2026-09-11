// Google Sheets API v4, read-only, via an API key against a sheet shared
// "anyone with the link can view" — same no-OAuth pattern the old
// lib/drive.ts used for campaign source files, since this only ever
// reads a sheet the user owns and shares themselves.

const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

export async function getSheetRows(spreadsheetId: string, range: string): Promise<string[][]> {
  const apiKey = process.env.GOOGLE_SHEETS_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_SHEETS_API_KEY must be set");

  const url = `${SHEETS_API_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?key=${apiKey}`;
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Google Sheets values.get failed for ${range}: ${res.status} ${JSON.stringify(body)}`);
  }
  return (body.values ?? []) as string[][];
}
