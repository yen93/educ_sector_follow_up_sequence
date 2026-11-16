# educ_sector_follow_up_sequence

Education-sector lead follow-up automation for James Castrission's mailbox. Supabase project `MAGTestProject` (ref `aivitcomiywiysrfwqxt`).

## Layout
- `prompts/` — dated task specs (`DDMMYY_name.txt`) that drive each piece of work.
- `chase_messages/followup_N.txt` — email HTML per chase step (includes signature).
- `supabase/functions/<fn>/index.ts` + `supabase/functions/_shared/` — edge functions (Deno).

## Conventions / gotchas
- **Never truncate; upsert/in-place update only** (global rule). Status changes are guarded `UPDATE ... WHERE status = '<from>'`.
- Lead status flow: `1B` (initial sent) -> `2A` (follow-up 1 drafted) -> `2B` (follow-up 1 sent) ; `10A` = bounced.
- Functions act as james@ via OAuth refresh token (`users/me`), deploy with `verify_jwt=false` and guard with `?token=` == `PUSH_SHARED_SECRET`.
- Most functions are **drafts-only (never send)** — EXCEPT `educ-draft-followup-1` (renamed from `educ-draft-chase-1`), which both drafts AND **sends**. Per run it does Phase A (draft `1B`->`2A`, set `draft_id`) then Phase B (send only the drafts it set to `2A` this run via `drafts.send`, -> `2B`, stamp `followup_1_date_sent`); a lead moves `1B`->`2A`->`2B` in one pass. Send needs the `https://mail.google.com/` scope on james@'s token (already granted).
- `_shared/chase1.ts` is **generated** from `chase_messages/followup_1.txt` — regenerate (read with `[IO.File]::ReadAllText`, JSON-encode), don't hand-edit. Don't use `Get-Content -Raw | ConvertTo-Json` (embeds PowerShell note properties).
- Each function bundles its own `_shared` copy at deploy (Supabase MCP `deploy_edge_function` with all files; entrypoint `functions/<fn>/index.ts`).
- Scheduling is pg_cron + `net.http_post`; 7am PHT = `0 23 * * 0-4` UTC. Cron commands in the DB contain the token in plaintext.
- Test with `?dry=1&aged_days=0&limit=N` (no drafts, no sends, no status changes). Runs are logged to `educ_router_runs`.
- Leads missing `email` or `thread_id` are skipped and stay `1B`.
