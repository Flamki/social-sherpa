/**
 * linkedin.proxy.fn.ts — proxy verification (SERVER ONLY).
 * Launches patchright through the saved proxy and hits an IP-echo endpoint so the
 * UI can PROVE traffic exits via the residential IP (not the user's home IP).
 * This is what makes the proxy layer trustworthy instead of a hopeful config field.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const Input = z.object({
  li_at: z.string().min(10),
  // Optionally test an ad-hoc proxy before saving it.
  proxy: z
    .object({
      host: z.string().min(1),
      port: z.number().int().positive(),
      username: z.string().optional(),
      password: z.string().optional(),
    })
    .nullable()
    .optional(),
});

export type ProxyTestResult =
  | {
      success: true;
      exitIp: string;
      country?: string;
      city?: string;
      usedProxy: boolean;
      latencyMs: number;
    }
  | { success: false; error: string };

export const testProxy = createServerFn({ method: "POST" })
  .inputValidator(Input)
  .handler(async ({ data }): Promise<ProxyTestResult> => {
    const { chromium } = await import("playwright");
    const { getOrCreateSession, profileDirFor } = await import("./linkedin.session");
    const { attachProxyCleanup, browserProxyFor } = await import("./proxy.bridge");

    const acct = await getOrCreateSession(data.li_at);
    // Use the ad-hoc proxy if provided, else the saved one. Do not fall back to
    // embedded credentials: that makes proxy health look random and leaks secrets.
    const proxy = data.proxy ?? acct.proxy;
    if (!proxy) {
      return {
        success: false,
        error: "No proxy configured. Enter a proxy or save one for this account before testing.",
      };
    }

    /*
    const proxyOpt = {
      server: /^\w+:\/\//.test(proxy.host)
        ? `${proxy.host}:${proxy.port}`
        : `http://${proxy.host}:${proxy.port}`,
      username: proxy.username,
      password: proxy.password,
    };
    */

    const fp = acct.fingerprint;
    const started = Date.now();
    let context: any = null;
    let bridge: Awaited<ReturnType<typeof browserProxyFor>> | null = null;
    try {
      bridge = await browserProxyFor(proxy);
      context = await chromium.launchPersistentContext(
        profileDirFor(acct.accountId) + "-proxytest",
        {
          channel: process.env.LINKEDIN_BROWSER_CHANNEL || "chrome",
          headless: true,
          args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
          proxy: bridge.proxy,
          userAgent: fp.userAgent,
        },
      );
      attachProxyCleanup(context, bridge.cleanup);
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto("https://ipv4.icanhazip.com", {
        waitUntil: "domcontentloaded",
        timeout: 25_000,
      });
      const exitIp = (await page.locator("body").innerText({ timeout: 5_000 })).trim();
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(exitIp)) {
        await context.close().catch(() => {});
        return {
          success: false,
          error: "IP check failed. Proxy may be down or rejecting browser traffic.",
        };
      }

      try {
        await page.goto("https://www.linkedin.com/feed/", {
          waitUntil: "domcontentloaded",
          timeout: 20_000,
        });
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes("CONNECT tunnel failed") || msg.includes("ERR_TUNNEL_CONNECTION_FAILED")) {
          await context.close().catch(() => {});
          return {
            success: false,
            error:
              `Proxy is alive (exit IP ${exitIp}) but cannot open a tunnel to LinkedIn. ` +
              "This is usually IPRoyal restricted-content/identity-verification blocking, not an app bug.",
          };
        }
      }

      // Best-effort geo lookup (also through the proxy).
      let country: string | undefined;
      let city: string | undefined;
      try {
        const geo = await context.request.get(`https://ipapi.co/${exitIp}/json/`, {
          timeout: 15_000,
        });
        if (geo.ok()) {
          const g: any = await geo.json();
          country = g?.country_name;
          city = g?.city;
        }
      } catch {
        /* geo is optional */
      }

      await context.close().catch(() => {});
      return {
        success: true,
        exitIp,
        country,
        city,
        usedProxy: !!bridge.proxy,
        latencyMs: Date.now() - started,
      };
    } catch (e) {
      if (context) await context.close().catch(() => {});
      else await bridge?.cleanup().catch(() => {});
      return {
        success: false,
        error:
          "Proxy test failed: " +
          (e as Error).message.slice(0, 140) +
          " (check host/port/credentials)",
      };
    }
  });
