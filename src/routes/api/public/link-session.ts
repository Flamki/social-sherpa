import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

// In-memory bridge: the extension POSTs the cookies here; the frontend polls
// /api/public/link-session?check=1 to pick them up. v0 is single-tenant demo only;
// production must scope by signed workspace token and store server-side.
let last: { capturedAt: string; userAgent: string; hasLiAt: boolean } | null = null;

const BodySchema = z.object({
  cookies: z.record(z.string().min(1).max(64), z.string().max(8192)),
  capturedAt: z.string().max(64),
  userAgent: z.string().max(512),
});

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  } as Record<string, string>;
}

export const Route = createFileRoute("/api/public/link-session")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: cors() }),
      GET: async ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("check") === "1") {
          return new Response(JSON.stringify({ linked: !!last, last }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...cors() },
          });
        }
        return new Response("ok", { status: 200, headers: cors() });
      },
      POST: async ({ request }) => {
        let parsed;
        try {
          parsed = BodySchema.parse(await request.json());
        } catch {
          return new Response("Bad body", { status: 400, headers: cors() });
        }
        last = {
          capturedAt: parsed.capturedAt,
          userAgent: parsed.userAgent,
          hasLiAt: typeof parsed.cookies.li_at === "string" && parsed.cookies.li_at.length > 10,
        };
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...cors() },
        });
      },
    },
  },
});