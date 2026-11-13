// OAuth refresh-token auth (NOT domain-wide delegation).
//
// Verbatim copy of the email_drafter / educ-bounced-threads-router shared
// google-auth.ts. Reuses the Gmail OAuth2 credential that james@ already
// authorized (the same refresh token the draft-james-reply fn + the n8n "Gmail
// account" credential use). We exchange its long-lived refresh token for a
// 1-hour access token, cached in memory per warm instance, and act AS james@
// directly (every Gmail call uses `users/me`).
//
// Secrets (Supabase edge-function secrets — already set on MAGTestProject):
//   GMAIL_OAUTH_CLIENT_ID      — OAuth 2.0 client id of the Gmail credential
//   GMAIL_OAUTH_CLIENT_SECRET  — its client secret
//   GMAIL_OAUTH_REFRESH_TOKEN  — james@'s refresh token (scope incl. gmail.modify)
//
// The granted scope includes https://mail.google.com/ + gmail.modify, which
// covers threads/messages read and drafts.create.

const TOKEN_URL = "https://oauth2.googleapis.com/token";

let cached: { token: string; exp: number } | null = null;

export async function getGmailAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - 60 > now) return cached.token;

  const clientId = Deno.env.get("GMAIL_OAUTH_CLIENT_ID");
  const clientSecret = Deno.env.get("GMAIL_OAUTH_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GMAIL_OAUTH_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET / GMAIL_OAUTH_REFRESH_TOKEN",
    );
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
  if (!res.ok) throw new Error(`Google token refresh failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  cached = { token: json.access_token, exp: now + (json.expires_in ?? 3600) };
  return cached.token;
}
