/**
 * linkedin.config.ts — server functions for the anti-ban config (SERVER ONLY).
 * Lets the UI read the stable fingerprint and set the per-account sticky proxy.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const ProxyInput = z.object({
  li_at: z.string().min(10),
  proxy: z
    .object({
      host: z.string().min(1),
      port: z.number().int().positive(),
      username: z.string().optional(),
      password: z.string().optional(),
    })
    .nullable(),
});

export const saveProxyConfig = createServerFn({ method: "POST" })
  .inputValidator(ProxyInput)
  .handler(async ({ data }) => {
    const { saveProxy } = await import("./linkedin.session");
    const s = await saveProxy(data.li_at, data.proxy ?? undefined);
    return { success: true, accountId: s.accountId, proxy: s.proxy ?? null };
  });

export const getSessionInfo = createServerFn({ method: "POST" })
  .inputValidator(z.object({ li_at: z.string().min(10) }))
  .handler(async ({ data }) => {
    const { getOrCreateSession, warmupDay, dailyImportCap, withinActiveHours } =
      await import("./linkedin.session");
    const s = await getOrCreateSession(data.li_at);
    return {
      accountId: s.accountId,
      fingerprint: s.fingerprint,
      proxy: s.proxy ?? null,
      proxySource: s.proxySource ?? null,
      warmupStartedAt: s.warmupStartedAt,
      warmupDay: warmupDay(s),
      dailyImportCap: dailyImportCap(s),
      withinActiveHours: withinActiveHours(s),
    };
  });
