// educ-draft-chase-1 — main_task: draft Chase 1 to aged education-sector leads.
//
// A scheduled run (07:00 Mon-Fri PH time) over public.manually_found_educ_leads.
// For every lead that is:
//   * status = '1B', and
//   * created_at <= now() - interval '3 days'   (aged at least 3 days)
// it creates a Chase 1 draft (chase_messages/followup_1.txt, with [firstname]
// substituted) as a REPLY inside that lead's existing email thread (thread_id),
// then marks the lead:
//   * status   = '2A'
//   * draft_id = the id of the draft just created
//
// It drafts only (never sends) — the drafts land in james@'s mailbox for review,
// consistent with the draft-james-reply pipeline on the same mailbox.
//
// Idempotent: only '1B' rows are picked and each is flipped to '2A' right after
// its draft is created (guarded by a status='1B' check on the UPDATE), so a
// re-run never double-drafts. A lead whose draft fails stays '1B' and is retried
// next run. Leads with no email or no thread_id are skipped (left '1B').
//
// Query params:
//   ?token=<PUSH_SHARED_SECRET>   required (verify_jwt=false; same secret as the
//                                 other educ routers)
//   ?dry=1                        report what WOULD happen; create no drafts, make
//                                 no status changes
//   ?limit=<n>                    cap leads processed this run (default 200)
//   ?aged_days=<n>                override the 3-day aging window (default 3).
//                                 Mainly for dry-run testing (?dry=1&aged_days=0).
//
// Scheduled-only: no Gmail users.watch / Pub/Sub, so it cannot disturb the live
// draft-james-reply push pipeline on the same mailbox.

import { getGmailAccessToken } from "../_shared/google-auth.ts";
import { createDraft, getProfileEmail, getThread, header, lastMessage } from "../_shared/gmail.ts";
import { fillChase1 } from "../_shared/chase1.ts";
import { buildReply } from "../_shared/mime.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const AGED_DAYS = 3;
const FROM_STATUS = "1B";
const TO_STATUS = "2A";
const DEFAULT_LIMIT = 200;

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

interface Lead {
  id: number;
  email: string | null;
  firstname: string | null;
  thread_id: string | null;
  status: string | null;
  created_at: string;
}

Deno.serve(async (req) => {
  // --- authenticate ---------------------------------------------------------
  const url = new URL(req.url);
  if (url.searchParams.get("token") !== Deno.env.get("PUSH_SHARED_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }
  const dry = url.searchParams.get("dry") === "1";
  const limit = Math.max(1, Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT);
  const agedDaysParam = url.searchParams.get("aged_days");
  const agedDays = agedDaysParam !== null && agedDaysParam !== "" && !Number.isNaN(Number(agedDaysParam))
    ? Number(agedDaysParam)
    : AGED_DAYS;

  const summary = {
    dry,
    scanned: 0, // leads matching the to_process query
    drafted: 0, // drafts created (status set to 2A)
    skipped: 0, // missing email/thread_id
    errors: 0,
  };
  // deno-lint-ignore no-explicit-any
  const details: any[] = [];

  try {
    const agedBefore = new Date(Date.now() - agedDays * 86_400_000).toISOString();

    // --- to_process: status='1B' AND created_at <= now() - interval '3 days' ---
    const { data, error } = await sb
      .from("manually_found_educ_leads")
      .select("id,email,firstname,thread_id,status,created_at")
      .eq("status", FROM_STATUS)
      .lte("created_at", agedBefore)
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) throw error;

    const leads = (data ?? []) as Lead[];
    summary.scanned = leads.length;

    if (!leads.length) {
      await logRun(summary, details);
      return json(summary);
    }

    const token = await getGmailAccessToken();
    const fromAddr = await getProfileEmail(token);

    for (const lead of leads) {
      const email = (lead.email ?? "").trim();
      const threadId = (lead.thread_id ?? "").trim();

      // Can't draft a threaded reply without a recipient and a thread.
      if (!email || !threadId) {
        summary.skipped++;
        details.push({ id: lead.id, email: lead.email, skipped: !email ? "no email" : "no thread_id" });
        continue;
      }

      try {
        // Thread context -> reply subject + threading headers.
        const thread = await getThread(token, threadId);
        const last = lastMessage(thread);
        if (!last) {
          summary.skipped++;
          details.push({ id: lead.id, email, skipped: "empty/invalid thread" });
          continue;
        }

        const subject = header(last, "Subject") || "Following up";
        const inReplyTo = header(last, "Message-ID");
        const references = `${header(last, "References")} ${inReplyTo}`.trim();

        const raw = buildReply({
          from: fromAddr,
          to: email,
          subject,
          inReplyTo,
          references,
          body: fillChase1(lead.firstname),
        });

        if (dry) {
          summary.drafted++;
          details.push({
            id: lead.id,
            email,
            firstname: lead.firstname,
            threadId,
            subject: /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`,
            would: "create draft + set status=2A",
          });
          continue;
        }

        // Create the draft in the existing thread.
        const draft = await createDraft(token, raw, threadId);
        const draftId: string = draft?.id;
        if (!draftId) throw new Error("drafts.create returned no id");

        // Mark the lead: status=2A + draft_id. Guarded by status='1B' so a
        // concurrent/duplicate run can't flip it twice.
        const { data: upd, error: updErr } = await sb
          .from("manually_found_educ_leads")
          .update({ status: TO_STATUS, draft_id: draftId })
          .eq("id", lead.id)
          .eq("status", FROM_STATUS)
          .select("id");
        if (updErr) throw updErr;
        if (!upd?.length) {
          // Row was no longer '1B' (already handled) — draft exists but we didn't
          // own the transition. Count it as skipped, not drafted, and note it.
          summary.skipped++;
          details.push({ id: lead.id, email, draftId, note: "status was not 1B at update; not re-counted" });
          continue;
        }

        summary.drafted++;
        details.push({ id: lead.id, email, firstname: lead.firstname, threadId, draftId, status: TO_STATUS });
      } catch (perLead) {
        summary.errors++;
        console.error(`chase-1 draft failed for lead ${lead.id} (${email}):`, perLead);
        details.push({ id: lead.id, email, error: String(perLead) });
        // Left at '1B' -> retried next run.
      }
    }

    await logRun(summary, details);
    console.log("educ-draft-chase-1 run:", JSON.stringify(summary));
    return json(summary);
  } catch (e) {
    summary.errors++;
    console.error("handler error:", e);
    await logRun(summary, details, String(e)).catch(() => {});
    return json({ ...summary, error: String(e) }, 500);
  }
});

// Record the run in educ_router_runs (shared with the other educ routers).
// Column mapping: moved <- drafts created; leads_updated <- status set to 2A
// (same value); bounced is unused here (0).
// deno-lint-ignore no-explicit-any
function logRun(summary: any, details: any[], error?: string) {
  return sb.from("educ_router_runs").insert({
    router: summary.dry ? "draft-chase-1 (dry)" : "draft-chase-1",
    scanned: summary.scanned,
    bounced: 0,
    moved: summary.drafted,
    leads_updated: summary.dry ? 0 : summary.drafted,
    errors: summary.errors,
    detail: { skipped: summary.skipped, ...(error ? { error } : {}), items: details },
  });
}

// deno-lint-ignore no-explicit-any
function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
