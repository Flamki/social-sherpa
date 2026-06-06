/**
 * linkedin.inbox.ts — read the LinkedIn messaging inbox via stealth browser (SERVER ONLY).
 *   listConversations(): the conversation list (name, preview, time, unread, threadUrn)
 *   readThread(threadUrl): the full message thread for one conversation
 * Both reuse the saved session through openLinkedIn().
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type Conversation = {
  id: string; // thread id / urn fragment
  threadUrl: string; // direct URL to open the thread
  name: string;
  preview: string;
  time: string;
  unread: boolean;
};

export type ThreadMessage = {
  from: "me" | "them";
  sender: string;
  text: string;
  time: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (min: number, max: number) => min + Math.random() * (max - min);

const CookieOnly = z.object({
  cookies: z.object({ li_at: z.string().min(10), JSESSIONID: z.string().min(3) }),
  headless: z.boolean().default(true),
});

/** List the conversations in the messaging inbox via the Voyager API (no /messaging/ goto). */
export const listConversations = createServerFn({ method: "POST" })
  .inputValidator(CookieOnly)
  .handler(async ({ data }) => {
    const { openLinkedIn } = await import("./linkedin.browser");
    const opened = await openLinkedIn({ cookies: data.cookies, headless: data.headless });
    if (!opened.ok)
      return { success: false as const, error: opened.error, challenge: opened.challenge };

    const { context, page } = opened;
    try {
      const { voyagerRequest, currentJsession } = await import("./linkedin.voyager");
      const r = await voyagerRequest(context, {
        url: "https://www.linkedin.com/voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX&q=syncToken&count=40",
        jsessionid: await currentJsession(context, data.cookies.JSESSIONID),
      });
      if (r.reason !== "ok") {
        await opened.persistCookies().catch(() => {});
        await context.close().catch(() => {});
        return { success: false as const, error: r.message, challenge: r.reason === "challenge" };
      }
      const raw: any = r.data;

      // Parse the Voyager messaging payload (elements -> conversations).
      const conversations: Conversation[] = [];
      const elements: any[] = raw?.elements || raw?.data?.elements || [];
      const included: any[] = raw?.included || [];
      // Build a lookup of profile entities for names.
      const people = new Map<string, any>();
      for (const inc of included) {
        if (inc?.firstName || inc?.lastName) people.set(inc.entityUrn, inc);
      }
      for (const el of elements) {
        const urn = el?.entityUrn || el?.dashEntityUrn || "";
        const id = urn.split(":").pop()?.replace(/[()]/g, "") || urn;
        const participants = el?.participants || [];
        let name = "";
        for (const p of participants) {
          const m =
            p?.["com.linkedin.voyager.messaging.MessagingMember"]?.miniProfile || p?.miniProfile;
          if (m) {
            const n = `${m.firstName || ""} ${m.lastName || ""}`.trim();
            if (n) {
              name = n;
              break;
            }
          }
        }
        const events = el?.events || [];
        const lastBody =
          events[0]?.eventContent?.["com.linkedin.voyager.messaging.event.MessageEvent"]
            ?.attributedBody?.text ||
          events[0]?.subject ||
          "";
        if (!id) continue;
        conversations.push({
          id,
          threadUrl: `https://www.linkedin.com/messaging/thread/${id}/`,
          name: name || "LinkedIn member",
          preview: (lastBody || "").slice(0, 120),
          time: "",
          unread: !el?.read,
        });
      }

      await opened.persistCookies().catch(() => {});
      await context.close().catch(() => {});
      return { success: true as const, count: conversations.length, conversations };
    } catch (e) {
      await opened.persistCookies().catch(() => {});
      await context.close().catch(() => {});
      return { success: false as const, error: (e as Error).message };
    }
  });

const ThreadInput = z.object({
  cookies: z.object({ li_at: z.string().min(10), JSESSIONID: z.string().min(3) }),
  threadUrl: z.string().url(),
  headless: z.boolean().default(true),
});

/** Read the full message thread for one conversation via the Voyager API. */
export const readThread = createServerFn({ method: "POST" })
  .inputValidator(ThreadInput)
  .handler(async ({ data }) => {
    const { openLinkedIn } = await import("./linkedin.browser");
    const opened = await openLinkedIn({ cookies: data.cookies, headless: data.headless });
    if (!opened.ok)
      return { success: false as const, error: opened.error, challenge: opened.challenge };

    const { context, page } = opened;
    try {
      const threadId = data.threadUrl.split("/messaging/thread/")[1]?.split("/")[0] || "";
      if (!threadId) {
        await context.close().catch(() => {});
        return { success: false as const, error: "Could not parse thread id from URL." };
      }
      const { voyagerRequest, currentJsession } = await import("./linkedin.voyager");
      const r = await voyagerRequest(context, {
        url: `https://www.linkedin.com/voyager/api/messaging/conversations/${encodeURIComponent(threadId)}/events?count=50`,
        jsessionid: await currentJsession(context, data.cookies.JSESSIONID),
      });
      if (r.reason !== "ok") {
        await opened.persistCookies().catch(() => {});
        await context.close().catch(() => {});
        return { success: false as const, error: r.message, challenge: r.reason === "challenge" };
      }
      const json: any = r.data;
      const me =
        (await page
          .evaluate(
            () =>
              document.querySelector<HTMLImageElement>("img.global-nav__me-photo")?.alt?.trim() ||
              "",
          )
          .catch(() => "")) || "";

      const events: any[] = json?.elements || [];
      const msgs: ThreadMessage[] = [];
      // Map member urns to names from `included`.
      const names = new Map<string, string>();
      for (const inc of json?.included || []) {
        if (inc?.firstName || inc?.lastName) {
          names.set(inc.entityUrn, `${inc.firstName || ""} ${inc.lastName || ""}`.trim());
        }
      }
      // events come newest-first; reverse for chat order.
      for (const ev of [...events].reverse()) {
        const mc = ev?.eventContent?.["com.linkedin.voyager.messaging.event.MessageEvent"];
        const text = mc?.attributedBody?.text || mc?.body || "";
        if (!text) continue;
        const fromUrn =
          ev?.from?.["com.linkedin.voyager.messaging.MessagingMember"]?.miniProfile?.entityUrn ||
          "";
        const sender =
          names.get(fromUrn) ||
          ev?.from?.["com.linkedin.voyager.messaging.MessagingMember"]?.miniProfile?.firstName ||
          "";
        const isMe = !!me && sender === me;
        msgs.push({
          from: isMe ? "me" : "them",
          sender: sender || (isMe ? "You" : "Them"),
          text,
          time: ev?.createdAt ? new Date(ev.createdAt).toLocaleString() : "",
        });
      }

      await opened.persistCookies().catch(() => {});
      await context.close().catch(() => {});
      return { success: true as const, meName: me || "", count: msgs.length, messages: msgs };
    } catch (e) {
      await opened.persistCookies().catch(() => {});
      await context.close().catch(() => {});
      return { success: false as const, error: (e as Error).message };
    }
  });
