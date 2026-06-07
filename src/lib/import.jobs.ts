import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { isVercelRuntime } from "./config.server";
import { runLinkedInSync, type Lead, type SyncInput, type SyncResult } from "./linkedin.sync";

type ImportJobStatus = "running" | "done" | "failed";

export type ImportJob = {
  id: string;
  status: ImportJobStatus;
  startedAt: string;
  finishedAt?: string;
  requestedCount: number;
  result?: SyncResult;
  items?: Lead[];
  error?: string;
};

const JobInputSchema = z.object({
  cookies: z.object({
    li_at: z.string().min(10),
    JSESSIONID: z.string().min(3),
  }),
  searchUrl: z.string().optional(),
  limit: z.number().int().positive().max(1000).default(50),
  headless: z.boolean().default(true),
  force: z.boolean().default(false),
});

const JobStatusInputSchema = z.object({
  jobId: z.string().min(5),
});

const globalJobs = globalThis as typeof globalThis & {
  __network_manager_import_jobs__?: Map<string, ImportJob>;
};

function jobs() {
  if (!globalJobs.__network_manager_import_jobs__) {
    globalJobs.__network_manager_import_jobs__ = new Map();
  }
  return globalJobs.__network_manager_import_jobs__;
}

function makeJobId() {
  return `import_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function pruneJobs() {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of jobs()) {
    if (job.finishedAt && new Date(job.finishedAt).getTime() < cutoff) jobs().delete(id);
  }
}

function startBackgroundImport(jobId: string, input: SyncInput) {
  setTimeout(async () => {
    try {
      const result = await runLinkedInSync(input);
      const job = jobs().get(jobId);
      if (!job) return;
      job.result = result;
      job.finishedAt = new Date().toISOString();
      if (result.success) {
        job.status = "done";
        job.items = result.items;
      } else {
        job.status = "failed";
        job.error = result.error;
      }
    } catch (e) {
      const job = jobs().get(jobId);
      if (!job) return;
      job.status = "failed";
      job.error = (e as Error).message;
      job.finishedAt = new Date().toISOString();
    }
  }, 0);
}

export const startConnectionImportJob = createServerFn({ method: "POST" })
  .inputValidator(JobInputSchema)
  .handler(async ({ data }) => {
    if (isVercelRuntime()) {
      return {
        success: false as const,
        error:
          "Cookie-based LinkedIn import is local-only on the hosted app because Vercel serverless cannot launch a persistent Chrome profile. Use Onboarding > Connect LinkedIn for approved sends.",
      };
    }

    pruneJobs();
    const existing = Array.from(jobs().values()).find((job) => job.status === "running");
    if (existing) {
      return { success: true as const, job: existing, reused: true as const };
    }

    const id = makeJobId();
    const job: ImportJob = {
      id,
      status: "running",
      startedAt: new Date().toISOString(),
      requestedCount: data.limit,
    };
    jobs().set(id, job);
    startBackgroundImport(id, data);
    return { success: true as const, job, reused: false as const };
  });

export const getConnectionImportJob = createServerFn({ method: "GET" })
  .inputValidator(JobStatusInputSchema)
  .handler(async ({ data }) => {
    const job = jobs().get(data.jobId);
    if (!job)
      return {
        success: false as const,
        error: "Import job not found. It may have expired after server restart.",
      };
    return { success: true as const, job };
  });
