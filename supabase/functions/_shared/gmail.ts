// Thin Gmail REST helpers (all act as the impersonated user "me").
//
// Scoped to what the chase-1 drafter needs: read the authenticated profile (for
// the From address), fetch a thread (to thread correctly + derive the reply
// subject/headers), and create a draft inside an existing thread.

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailHeader {
  name: string;
  value: string;
}

async function gfetch(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Gmail ${path} -> ${res.status} ${text}`);
    // deno-lint-ignore no-explicit-any
    (err as any).status = res.status;
    throw err;
  }
  return res.json();
}

// The authenticated mailbox's own email address (james@...), used as the draft's
// From and to detect which thread messages are James's own outbound.
export async function getProfileEmail(token: string): Promise<string> {
  const data = await gfetch(token, `/profile`);
  return data.emailAddress as string;
}

// Fetch a full thread (all messages + headers). Used to derive the reply subject
// and In-Reply-To / References from the most recent message.
export const getThread = (token: string, id: string) =>
  gfetch(token, `/threads/${id}?format=full`);

// Create a draft inside an existing thread. Returns the Gmail draft resource
// ({ id, message: {...} }). threadId makes Gmail attach it to the right thread.
export const createDraft = (token: string, raw: string, threadId: string) =>
  gfetch(token, `/drafts`, {
    method: "POST",
    body: JSON.stringify({ message: { raw, threadId } }),
  });

// deno-lint-ignore no-explicit-any
export function header(msg: any, name: string): string {
  const h = (msg.payload?.headers ?? []).find(
    (x: GmailHeader) => x.name.toLowerCase() === name.toLowerCase(),
  );
  return h?.value ?? "";
}

// The last message in a thread (by internalDate), used as the message we reply to.
// deno-lint-ignore no-explicit-any
export function lastMessage(thread: any): any | null {
  const msgs = thread?.messages ?? [];
  if (!msgs.length) return null;
  return msgs.reduce((a: any, b: any) =>
    Number(b.internalDate ?? 0) >= Number(a.internalDate ?? 0) ? b : a
  );
}
