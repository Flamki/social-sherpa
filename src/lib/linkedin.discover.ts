/**
 * linkedin.discover.ts — prospect-discovery server function (client-safe entry).
 *
 * This module is safe to import from a client route: it only contains a createServerFn stub
 * and erased type re-exports. The actual engine (node-only) lives in linkedin.discover.core.ts
 * and is reached only via a lazy import inside the handler, so it never enters the browser bundle.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type { Prospect, DiscoverResult } from "./linkedin.discover.core";

const DiscoverSchema = z.object({
  cookies: z.object({ li_at: z.string().min(10), JSESSIONID: z.string().min(3) }),
  query: z.string().min(2).max(200),
  limit: z.number().int().positive().max(50).default(10),
});

export const discoverProspects = createServerFn({ method: "POST" })
  .inputValidator(DiscoverSchema)
  .handler(async ({ data }) => {
    const { runDiscovery } = await import("./linkedin.discover.core");
    return runDiscovery(data);
  });
