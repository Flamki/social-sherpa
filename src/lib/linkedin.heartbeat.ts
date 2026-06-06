/**
 * linkedin.heartbeat.ts — server-side background heartbeat worker.
 * Periodically visits LinkedIn in a stealth browser context to signal activity,
 * keep cookie sessions warm, and capture fresh rotated cookies.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { openLinkedIn } from "./linkedin.browser";
import { runtimeDataDir } from "@/lib/config.server";

const DATA_DIR = path.join(runtimeDataDir(), "sessions");

export async function getAllSessions() {
  try {
    const folders = await fs.readdir(DATA_DIR);
    const sessions = [];
    for (const folder of folders) {
      try {
        const file = path.join(DATA_DIR, folder, "session.json");
        const raw = await fs.readFile(file, "utf8");
        sessions.push(JSON.parse(raw));
      } catch {
        // skip files/folders that don't have a valid session
      }
    }
    return sessions;
  } catch {
    return [];
  }
}

export async function runHeartbeatOnce() {
  const sessions = await getAllSessions();
  const intervalHours = Math.max(
    2,
    Number(process.env.LINKEDIN_HEARTBEAT_INTERVAL_MINUTES || 180) / 60,
  );
  console.log(`[heartbeat] Checking ${sessions.length} sessions...`);
  for (const session of sessions) {
    if (!session.cookies || !session.cookies.li_at) {
      console.log(`[heartbeat] Session ${session.accountId} has no cookies. Skipping.`);
      continue;
    }

    // Check when it was last checked/used
    const lastUsed = session.lastUsedAt ? new Date(session.lastUsedAt).getTime() : 0;
    const hoursSinceLastUse = (Date.now() - lastUsed) / (1000 * 60 * 60);

    // Run heartbeat only if it has been quiet for a few hours.
    if (hoursSinceLastUse >= intervalHours) {
      console.log(
        `[heartbeat] Running heartbeat for session ${session.accountId} (last used ${hoursSinceLastUse.toFixed(
          1,
        )} hours ago)...`,
      );
      try {
        const result = await openLinkedIn({
          cookies: session.cookies,
          headless: true,
        });
        if (result.ok) {
          await result.persistCookies();
          await result.context.close();
          console.log(`[heartbeat] Session ${session.accountId} refreshed successfully.`);
        } else {
          console.error(
            `[heartbeat] Session ${session.accountId} failed validation: ${result.error}`,
          );
        }
      } catch (err) {
        console.error(`[heartbeat] Error running heartbeat for ${session.accountId}:`, err);
      }
    } else {
      console.log(
        `[heartbeat] Session ${session.accountId} was active ${hoursSinceLastUse.toFixed(
          1,
        )} hours ago. Skipping heartbeat.`,
      );
    }
  }
}

export function startHeartbeatCron() {
  if (typeof window !== "undefined") return; // Server only
  if (process.env.LINKEDIN_HEARTBEAT_ENABLED === "false") {
    console.log("[heartbeat] Disabled by LINKEDIN_HEARTBEAT_ENABLED=false.");
    return;
  }

  const globalRef = globalThis as any;
  if (globalRef.__heartbeat_interval__) {
    console.log("[heartbeat] Heartbeat interval already running. Skipping duplicate init.");
    return;
  }

  const intervalMinutes = Math.max(
    120,
    Number(process.env.LINKEDIN_HEARTBEAT_INTERVAL_MINUTES || 180),
  );
  console.log(
    `[heartbeat] Initializing periodic heartbeat job (every ${intervalMinutes} minutes)...`,
  );

  // Do not touch LinkedIn right after app boot; wait for the quiet interval.
  setTimeout(
    () => {
      runHeartbeatOnce().catch((err) => console.error("[heartbeat] Initial run error:", err));
    },
    intervalMinutes * 60 * 1000,
  );

  globalRef.__heartbeat_interval__ = setInterval(
    () => {
      runHeartbeatOnce().catch((err) => console.error("[heartbeat] Interval run error:", err));
    },
    intervalMinutes * 60 * 1000,
  );
}
