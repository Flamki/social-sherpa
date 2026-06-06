/**
 * linkedin.requests.ts — LinkedIn connection invitation/request management (SERVER ONLY).
 * Uses the same Botdog/PhantomBuster pattern: validate with openLinkedIn(), then
 * all LinkedIn API calls go through the centralized hardened voyagerRequest().
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type LinkedInInvitation = {
  id: string;
  entityUrn: string;
  fromName: string;
  fromHeadline: string;
  profileUrl?: string;
  message?: string;
  sentAt?: string;
  mutualConnections?: number;
};

const CookieInput = z.object({
  cookies: z.object({ li_at: z.string().min(10), JSESSIONID: z.string().min(3) }),
  headless: z.boolean().default(true),
});

const DecisionInput = CookieInput.extend({
  invitationId: z.string().min(1),
  entityUrn: z.string().optional(),
  action: z.enum(["accept", "ignore"]),
});

function miniProfileName(m: any): string {
  return `${m?.firstName || ""} ${m?.lastName || ""}`.trim();
}

function parseInvitationPayload(raw: any): LinkedInInvitation[] {
  const included: any[] = raw?.included || [];
  const byUrn = new Map<string, any>();
  for (const inc of included) {
    if (inc?.entityUrn) byUrn.set(inc.entityUrn, inc);
  }

  const elements: any[] = raw?.elements || raw?.data?.elements || [];
  const out: LinkedInInvitation[] = [];

  for (const el of elements) {
    const entityUrn = el?.entityUrn || el?.dashEntityUrn || el?.invitationUrn || "";
    const id =
      el?.invitationId || el?.id || entityUrn.split(":").pop()?.replace(/[()]/g, "") || entityUrn;

    const directMini =
      el?.fromMember?.miniProfile ||
      el?.inviter?.miniProfile ||
      el?.member?.miniProfile ||
      el?.profile ||
      el?.actor?.miniProfile;

    const memberUrn =
      el?.fromMember?.entityUrn ||
      el?.inviter?.entityUrn ||
      el?.member?.entityUrn ||
      el?.inviterUrn ||
      el?.fromMemberUrn;
    const includedProfile = memberUrn ? byUrn.get(memberUrn) : undefined;
    const profile = directMini || includedProfile || {};

    const name = miniProfileName(profile) || el?.name?.text || el?.title?.text || "LinkedIn member";

    const headline =
      profile?.occupation ||
      el?.headline?.text ||
      el?.subtitle?.text ||
      el?.primarySubtitle?.text ||
      "";

    const publicId = profile?.publicIdentifier || profile?.publicIdentifierV2;
    const profileUrl = publicId ? `https://www.linkedin.com/in/${publicId}` : undefined;

    if (!id) continue;
    out.push({
      id,
      entityUrn,
      fromName: name,
      fromHeadline: headline,
      profileUrl,
      message: el?.message || el?.customMessage || el?.note || "",
      sentAt: el?.sentTime ? new Date(el.sentTime).toLocaleString() : undefined,
      mutualConnections: el?.mutualConnections?.total || el?.numSharedConnections || 0,
    });
  }

  return out;
}

async function listInvitations(kind: "received" | "sent", data: z.infer<typeof CookieInput>) {
  const { openLinkedIn } = await import("./linkedin.browser");
  const { voyagerRequest } = await import("./linkedin.voyager");
  const opened = await openLinkedIn({ cookies: data.cookies, headless: data.headless });
  if (!opened.ok)
    return { success: false as const, error: opened.error, challenge: opened.challenge };

  const { context } = opened;
  const q = kind === "received" ? "receivedInvitation" : "sentInvitation";

  // Try multiple known Voyager endpoints (LinkedIn changes these periodically)
  const endpoints = [
    `https://www.linkedin.com/voyager/api/relationships/invitations?invitationType=CONNECTION&q=${q}&count=40`,
    `https://www.linkedin.com/voyager/api/relationships/invitations?q=${q}&invitationType=CONNECTION&count=40`,
    `https://www.linkedin.com/voyager/api/growth/normInvitations?q=${q}&invitationType=CONNECTION&count=40`,
  ];

  for (const url of endpoints) {
    try {
      const r = await voyagerRequest(context, { url, jsessionid: data.cookies.JSESSIONID });
      if (r.reason === "ok") {
        await context.close().catch(() => {});
        const invitations = parseInvitationPayload(r.data);
        return { success: true as const, invitations, count: invitations.length };
      }
      // If it's a redirect (999/3xx handled as blocked/server), try next endpoint
      if (r.reason === "blocked" || r.reason === "server") {
        continue;
      }
      // For other errors (challenge, expired, etc.), return immediately
      await context.close().catch(() => {});
      return { success: false as const, error: r.message, challenge: r.reason === "challenge" };
    } catch (e) {
      // Network error - try next endpoint
      continue;
    }
  }

  await context.close().catch(() => {});
  return {
    success: false as const,
    error:
      "All known invitation endpoints failed (redirect/block/404). LinkedIn may have changed the API.",
  };
}

export const listReceivedInvitations = createServerFn({ method: "POST" })
  .inputValidator(CookieInput)
  .handler(async ({ data }) => listInvitations("received", data));

export const listSentInvitations = createServerFn({ method: "POST" })
  .inputValidator(CookieInput)
  .handler(async ({ data }) => listInvitations("sent", data));

export const decideInvitation = createServerFn({ method: "POST" })
  .inputValidator(DecisionInput)
  .handler(async ({ data }) => {
    const { openLinkedIn } = await import("./linkedin.browser");
    const { voyagerRequest } = await import("./linkedin.voyager");
    const opened = await openLinkedIn({ cookies: data.cookies, headless: data.headless });
    if (!opened.ok)
      return { success: false as const, error: opened.error, challenge: opened.challenge };

    const { context } = opened;
    try {
      // Common Voyager action shape: POST invitations/{id}?action=accept|ignore.
      // Use the raw id first; LinkedIn accepts encoded urns on many accounts too.
      const rawId = data.invitationId || data.entityUrn || "";
      const r = await voyagerRequest(context, {
        method: "POST",
        url: `https://www.linkedin.com/voyager/api/relationships/invitations/${encodeURIComponent(rawId)}?action=${data.action}`,
        jsessionid: data.cookies.JSESSIONID,
        body: {},
        headers: { "content-type": "application/json; charset=UTF-8" },
      });
      await context.close().catch(() => {});
      if (r.reason !== "ok")
        return { success: false as const, error: r.message, challenge: r.reason === "challenge" };
      return { success: true as const };
    } catch (e) {
      await context.close().catch(() => {});
      return { success: false as const, error: (e as Error).message };
    }
  });
