import fs from "node:fs/promises";
import path from "node:path";

import { createFileRoute } from "@tanstack/react-router";

import { runtimeDataDir } from "@/lib/config.server";

type WebhookPayload = Record<string, unknown>;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function persistWebhook(payload: WebhookPayload) {
  const dir = path.join(runtimeDataDir(), "unipile");
  await fs.mkdir(dir, { recursive: true });
  const line = `${JSON.stringify({ receivedAt: new Date().toISOString(), payload })}\n`;
  await fs.appendFile(path.join(dir, "webhooks.ndjson"), line, "utf8");
}

function authorized(request: Request) {
  const secret = process.env.UNIPILE_WEBHOOK_SECRET?.trim();
  if (!secret) return true;

  const url = new URL(request.url);
  const token = url.searchParams.get("token") || request.headers.get("x-webhook-secret");
  return token === secret;
}

export const Route = createFileRoute("/api/webhooks/unipile")({
  server: {
    handlers: {
      GET: async () => json({ ok: true, provider: "unipile" }),
      POST: async ({ request }) => {
        if (!authorized(request)) return json({ ok: false, error: "Unauthorized" }, 401);

        let payload: WebhookPayload;
        try {
          payload = (await request.json()) as WebhookPayload;
        } catch {
          return json({ ok: false, error: "Invalid JSON body" }, 400);
        }

        try {
          await persistWebhook(payload);
        } catch (error) {
          console.error("[unipile-webhook] persist failed", error);
        }

        return json({ ok: true });
      },
    },
  },
});
