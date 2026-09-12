// One-time manual OAuth bootstrap for TikTok inbox-upload access. Not
// part of the automated pipeline: run it by hand whenever a refresh
// token is needed.
//
// Unlike YouTube's bootstrap (youtube-oauth-bootstrap.ts), which runs a
// local http://127.0.0.1 listener, TikTok's redirect_uri must be an
// HTTPS URL on a verified domain — it can't be a loopback address. So
// this script instead prints the authorization URL for you to open, and
// TikTok redirects the browser to the static oauth-callback.html page
// (see ../../../docs/oauth-callback.html, served at
// topsongs.andreidasilva.com), which displays the returned `code` for
// you to paste back into this script's prompt.
//
// IMPORTANT: TikTok can rotate the refresh_token on every use (see
// lib/tiktok.ts) — the value printed here is only good until the next
// refresh, at which point whatever new value that refresh call returns
// must replace it in .env.

import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { buildAuthorizationUrl, exchangeCodeForTokens } from "../lib/tiktok.js";

const REDIRECT_URI = "https://topsongs.andreidasilva.com/oauth-callback.html";

async function main() {
  const state = randomUUID();
  const authUrl = buildAuthorizationUrl(REDIRECT_URI, state);

  console.log("Open this URL, log in as the dasilvaandrei TikTok account, and approve:\n");
  console.log(authUrl);
  console.log("\nAfter approving, the browser lands on the callback page showing a code.");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const code = (await rl.question("\nPaste the code here: ")).trim();
  rl.close();

  const tokens = await exchangeCodeForTokens(code, REDIRECT_URI);

  console.log("\nACCESS_TOKEN:", tokens.accessToken, "(valid 24h — not saved anywhere, use tiktok-upload-test.ts instead)");
  console.log("REFRESH_TOKEN:", tokens.refreshToken, "(valid 365 days, may rotate on next refresh)");
  console.log("OPEN_ID:", tokens.openId);
  console.log("\nAdd the refresh token to .env as TIKTOK_REFRESH_TOKEN.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
