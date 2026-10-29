import type { Context } from "@deepseek-ai/cordis";
import type { JobHandle, JobHooks, JobOutcome } from "@deepseek-ai/dsh-jobs";
import type { Client } from "ssh2";
import { basename } from "node:path";
import { downloadWithResume, uploadWithResume, type TransferOptions, type TransferResult } from "./transfer.js";

type JobsService = {
  start(spec: {
    kind: string;
    label: string;
    owner?: string;
    outputLimitBytes?: number;
    run(job: JobHandle): JobHooks;
  }): string;
};

type AgentLike = { sessionId?: string; session?: { id?: string }; ctx?: unknown };

function readJobs(candidate: Context | undefined): JobsService | undefined {
  if (!candidate) return undefined;
  try {
    return candidate.get("jobs") as JobsService | undefined;
  } catch {
    return undefined;
  }
}

function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/**
 * Run one transfer as a DSH background job: progress goes to the job's output
 * (read with job_output), cancellation is job_kill, and the session receives a
 * completion notice when it settles.
 */
export function startTransferJob(
  ctx: Context,
  agent: AgentLike | undefined,
  client: Client,
  direction: "upload" | "download",
  paths: { localPath: string; remotePath: string },
  options: TransferOptions,
): { jobId?: string; error?: string } {
  const agentLike = agent;
  const services = [readJobs(agentLike?.ctx as Context | undefined), readJobs(ctx)].filter(
    (service): service is JobsService => Boolean(service?.start),
  );
  if (services.length === 0) return { error: "background job service is not mounted" };
  const owner = agentLike?.sessionId ?? agentLike?.session?.id;
  const label = `${direction === "upload" ? "上传" : "下载"} ${basename(paths.localPath || paths.remotePath)}`;
  const errors: string[] = [];

  for (const service of services) {
    try {
      const jobId = service.start({
        kind: "mss-transfer",
        label,
        ...(owner ? { owner } : {}),
        outputLimitBytes: 4096,
        run(job: JobHandle): JobHooks {
          const controller = new AbortController();
          const done = (async (): Promise<JobOutcome> => {
            try {
              const task = direction === "upload" ? uploadWithResume : downloadWithResume;
              const result: TransferResult = await task(client, paths.localPath, paths.remotePath, {
                ...options,
                signal: controller.signal,
                onProgress: (transferred, total) => {
                  const percent = total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0;
                  job.updateProgress(`${humanBytes(transferred)} / ${humanBytes(total)} · ${percent}%`);
                },
              });
              job.append(`${JSON.stringify(result)}\n`);
              return {
                status: "completed",
                detail: `${result.files} 个文件 · ${humanBytes(result.bytes)} · verified=${result.verified}`,
                result: `${paths.localPath} -> ${paths.remotePath}`,
              };
            } catch (error) {
              return { status: "failed", detail: (error as Error).message };
            }
          })();
          done.catch(() => undefined);
          return {
            cancel() {
              controller.abort();
            },
            done,
          };
        },
      });
      return { jobId };
    } catch (error) {
      errors.push((error as Error).message);
    }
  }
  return { error: errors.join(" | ") };
}
