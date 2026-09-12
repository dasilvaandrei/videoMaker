// One-time manual OAuth bootstrap for Instagram publishing access.
// Mirrors tiktok-oauth-bootstrap.ts's shape: prints the authorization
// URL, you log in as igncultura and approve, the browser lands on the
// same static oauth-callback.html page (reused across providers — it
// just displays whatever `code` param comes back) for you to paste back
// here. Does the real OAuth flow rather than using the Meta dashboard's
// "Generate access tokens" shortcut, which produced a token that
// couldn't be exchanged for a long-lived one — see lib/meta.ts.

import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { buildAuthorizationUrl, exchangeCodeForToken, exchangeForLongLivedToken } from "../lib/meta.js";

const REDIRECT_URI = "https://topsongs.andreidasilva.com/oauth-callback.html";

async function main() {
  const state = randomUUID();
  const authUrl = buildAuthorizationUrl(REDIRECT_URI, state);

  console.log("Open this URL, log in as the igncultura Instagram account, and approve:\n");
  console.log(authUrl);
  console.log("\nAfter approving, the browser lands on the callback page showing a code.");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const code = (await rl.question("\nPaste the code here: ")).trim();
  rl.close();

  const shortLived = await exchangeCodeForToken(code, REDIRECT_URI);
  console.log("\nShort-lived token obtained, exchanging for a long-lived one...");

  const longLived = await exchangeForLongLivedToken(shortLived.accessToken);

  console.log("\nINSTAGRAM_USER_ID:", shortLived.userId);
  console.log("LONG_LIVED_TOKEN:", longLived.accessToken, `(valid ${Math.round(longLived.expiresIn / 86400)} days)`);
  console.log("\nAdd the token to .env as META_ACCESS_TOKEN.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
