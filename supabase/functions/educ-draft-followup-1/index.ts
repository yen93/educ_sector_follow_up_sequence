// educ-draft-followup-1 — main_task: draft AND send Follow-up 1 to aged
// education-sector leads, in a single scheduled pass.
//
// A scheduled run (07:00 Mon-Fri PH time) over public.manually_found_educ_leads.
//
// Phase A (draft) — unchanged original behaviour. For every lead that is:
//   * status = '1B', and
//   * created_at <= now() - interval '3 days'   (aged at least 3 days)
// it creates a Follow-up 1 draft (chase_messages/followup_1.txt, with [firstname]
// substituted) as a REPLY inside that lead's existing email thread (thread_id),
// then marks the lead:
//   * status   = '2A'
//   * draft_id = the id of the draft just created
//
// Phase B (send) — appended per 161126 spec. For every lead Phase A just drafted
// and set to '2A' in THIS run, it:
//   1. sends that draft (drafts.send on the stored draft_id — stays in-thread),
//   2. sets status = '2B',
//   3. stamps followup_1_date_sent = now().
// Phase B operates ONLY on the rows Phase A set to '2A' in this run (not an
// independent scan of all '2A' rows), so a lead moves 1B -> 2A -> 2B in one pass.
//
// Idempotent: Phase A picks only '1B' rows and flips each to '2A' guarded by a
// status='1B' check, so a re-run never double-drafts. Phase B's status update is
// guarded by status='2A', and Gmail deletes a draft once sent, so a draft cannot
// be sent twice. A lead whose draft fails stays '1B'; a lead whose send fails
// stays '2A' (draft intact) and can be sent manually or retried. Leads with no
// email or no thread_id are skipped (left '1B').
//
// NOTE: unlike the drafts-only educ pipeline, this function SENDS email as james@.
//
// Query params:
//   ?token=<PUSH_SHARED_SECRET>   required (verify_jwt=false; same secret as the
//                                 other educ routers)
//   ?dry=1                        report what WOULD happen; create no drafts, send
//                                 nothing, make no status changes
//   ?limit=<n>                    cap leads processed this run (default 200)
//   ?aged_days=<n>                override the 3-day aging window (default 3).
//                                 Mainly for dry-run testing (?dry=1&aged_days=0).
//
// Scheduled-only: no Gmail users.watch / Pub/Sub, so it cannot disturb the live
// draft-james-reply push pipeline on the same mailbox.

import { getGmailAccessToken } from "../_shared/google-auth.ts";
import { createDraft, getProfileEmail, getThread, header, lastMessage, sendDraft } from "../_shared/gmail.ts";
import { fillChase1 } from "../_shared/chase1.ts";
import { buildReply } from "../_shared/mime.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const AGED_DAYS = 3;
const DRAFT_FROM_STATUS = "1B";
const DRAFTED_STATUS = "2A";
const SENT_STATUS = "2B";
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

// A lead Phase A drafted this run, to be sent by Phase B.
interface SendCandidate {
  id: number;
  email: string;
  firstname: string | null;
  threadId: string;
  draftId: string | null; // null only in dry runs (no draft is actually created)
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
    scanned: 0, // leads matching the Phase A to_process query
    drafted: 0, // drafts created (status set to 2A)
    sent: 0, // drafts sent (status set to 2B)
    skipped: 0, // missing email/thread_id, or lost the 1B transition
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
      .eq("status", DRAFT_FROM_STATUS)
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

    // Leads Phase A successfully drafted this run, handed to Phase B to send.
    const toSend: SendCandidate[] = [];

    // ====================== Phase A: draft (1B -> 2A) ======================
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
            would: "create draft + set status=2A, then send + set status=2B + followup_1_date_sent",
          });
          // Queue for the Phase B dry report (no real draft id in dry mode).
          toSend.push({ id: lead.id, email, firstname: lead.firstname, threadId, draftId: null });
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
          .update({ status: DRAFTED_STATUS, draft_id: draftId })
          .eq("id", lead.id)
          .eq("status", DRAFT_FROM_STATUS)
          .select("id");
        if (updErr) throw updErr;
        if (!upd?.length) {
          // Row was no longer '1B' (already handled) — draft exists but we didn't
          // own the transition. Count it as skipped, not drafted, and don't send.
          summary.skipped++;
          details.push({ id: lead.id, email, draftId, note: "status was not 1B at update; not re-counted; not sent" });
          continue;
        }

        summary.drafted++;
        details.push({ id: lead.id, email, firstname: lead.firstname, threadId, draftId, status: DRAFTED_STATUS });
        // Hand to Phase B: send only the drafts this run created and set to 2A.
        toSend.push({ id: lead.id, email, firstname: lead.firstname, threadId, draftId });
      } catch (perLead) {
        summary.errors++;
        console.error(`followup-1 draft failed for lead ${lead.id} (${email}):`, perLead);
        details.push({ id: lead.id, email, error: String(perLead) });
        // Left at '1B' -> retried next run.
      }
    }

    // =============== Phase B: send this run's drafts (2A -> 2B) ===============
    for (const c of toSend) {
      try {
        if (dry) {
          summary.sent++;
          details.push({ id: c.id, email: c.email, would: "send draft + set status=2B + followup_1_date_sent" });
          continue;
        }

        if (!c.draftId) {
          // Only reachable if a non-dry draft somehow had no id (already thrown above).
          summary.errors++;
          details.push({ id: c.id, email: c.email, error: "no draft_id to send" });
          continue;
        }

        // Send the draft (stays in its thread; Gmail removes the draft after send).
        await sendDraft(token, c.draftId);

        // Advance: status=2B + followup_1_date_sent. Guarded by status='2A'.
        const nowIso = new Date().toISOString();
        const { data: upd, error: updErr } = await sb
          .from("manually_found_educ_leads")
          .update({ status: SENT_STATUS, followup_1_date_sent: nowIso })
          .eq("id", c.id)
          .eq("status", DRAFTED_STATUS)
          .select("id");
        if (updErr) throw updErr;
        if (!upd?.length) {
          // Email went out, but the row was no longer '2A' at update time.
          summary.sent++;
          details.push({ id: c.id, email: c.email, draftId: c.draftId, note: "sent; status was not 2A at update (not re-flipped)" });
          continue;
        }

        summary.sent++;
        details.push({ id: c.id, email: c.email, draftId: c.draftId, status: SENT_STATUS, followup_1_date_sent: nowIso });
      } catch (perSend) {
        summary.errors++;
        console.error(`followup-1 send failed for lead ${c.id} (${c.email}):`, perSend);
        details.push({ id: c.id, email: c.email, error: String(perSend) });
        // Left at '2A' with draft_id intact -> can be sent manually or retried.
      }
    }

    await logRun(summary, details);
    console.log("educ-draft-followup-1 run:", JSON.stringify(summary));
    return json(summary);
  } catch (e) {
    summary.errors++;
    console.error("handler error:", e);
    await logRun(summary, details, String(e)).catch(() => {});
    return json({ ...summary, error: String(e) }, 500);
  }
});

// Record the run in educ_router_runs (shared with the other educ routers).
// Column mapping: moved <- drafts created; leads_updated <- drafts sent (rows
// advanced to 2B); bounced is unused here (0).
// deno-lint-ignore no-explicit-any
function logRun(summary: any, details: any[], error?: string) {
  return sb.from("educ_router_runs").insert({
    router: summary.dry ? "draft-followup-1 (dry)" : "draft-followup-1",
    scanned: summary.scanned,
    bounced: 0,
    moved: summary.drafted,
    leads_updated: summary.dry ? 0 : summary.sent,
    errors: summary.errors,
    detail: {
      skipped: summary.skipped,
      drafted: summary.drafted,
      sent: summary.sent,
      ...(error ? { error } : {}),
      items: details,
    },
  });
}

// deno-lint-ignore no-explicit-any
function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
