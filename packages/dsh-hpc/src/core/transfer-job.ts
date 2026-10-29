import type { Context } from "@deepseek-ai/cordis";
import type { JobHandle, JobHooks, JobOutcome } from "@deepseek-ai/dsh-jobs";
import type { Client } from "ssh2";
import { basename } from "node:path";
import { downloadWithResume, uploadWithResume, type TransferOptions, type TransferResult } from "./transfer.js";

export type QueueItem = { localPath: string; remotePath: string };
export type QueueItemResult = { localPath: string; remotePath: string; ok: boolean; files: number; bytes: number; error?: string };
export type QueueSummary = { files: number; bytes: number; failed: number; cancelled: boolean; items: QueueItemResult[] };

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
        kind: "hpc-transfer",
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


/**
 * Process a transfer queue sequentially, one item at a time. Cancellation is
 * cooperative: the current item aborts at a chunk boundary and remaining items
 * are skipped.
 */
export async function runTransferQueue(
  client: Client,
  direction: "upload" | "download",
  items: QueueItem[],
  options: TransferOptions,
  hooks: {
    onItem?: (index: number, total: number, item: QueueItem) => void;
    onProgress?: (transferred: number, total: number) => void;
    continueOnError?: boolean;
  } = {},
): Promise<QueueSummary> {
  const summary: QueueSummary = { files: 0, bytes: 0, failed: 0, cancelled: false, items: [] };
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (options.signal?.aborted) {
      summary.cancelled = true;
      break;
    }
    hooks.onItem?.(index, items.length, item);
    try {
      const result: TransferResult =
        direction === "upload"
          ? await uploadWithResume(client, item.localPath, item.remotePath, { ...options, onProgress: hooks.onProgress })
          : await downloadWithResume(client, item.remotePath, item.localPath, { ...options, onProgress: hooks.onProgress });
      summary.files += result.files;
      summary.bytes += result.bytes;
      summary.items.push({ localPath: item.localPath, remotePath: item.remotePath, ok: true, files: result.files, bytes: result.bytes });
    } catch (error) {
      const message = (error as Error).message;
      summary.failed += 1;
      summary.items.push({ localPath: item.localPath, remotePath: item.remotePath, ok: false, files: 0, bytes: 0, error: message });
      if (hooks.continueOnError === false) break;
    }
  }
  return summary;
}

/** Run a transfer queue as a DSH background job (progress via job_output, cancel via job_kill). */
export function startTransferQueueJob(
  ctx: Context,
  agent: AgentLike | undefined,
  client: Client,
  direction: "upload" | "download",
  items: QueueItem[],
  options: TransferOptions,
  continueOnError: boolean,
): { jobId?: string; error?: string } {
  const services = [readJobs(agent?.ctx as Context | undefined), readJobs(ctx)].filter(
    (service): service is JobsService => Boolean(service?.start),
  );
  if (services.length === 0) return { error: "background job service is not mounted" };
  const owner = agent?.sessionId ?? agent?.session?.id;
  const label = `${direction === "upload" ? "上传队列" : "下载队列"} · ${items.length} 项`;
  const errors: string[] = [];

  for (const service of services) {
    try {
      const jobId = service.start({
        kind: "hpc-transfer",
        label,
        ...(owner ? { owner } : {}),
        outputLimitBytes: 4096,
        run(job: JobHandle): JobHooks {
          const controller = new AbortController();
          const done = (async (): Promise<JobOutcome> => {
            try {
              const summary = await runTransferQueue(
                client,
                direction,
                items,
                { ...options, signal: controller.signal },
                {
                  continueOnError,
                  onItem: (index, total, item) => {
                    job.updateProgress(`[${index + 1}/${total}] ${basename(item.localPath || item.remotePath)}`);
                  },
                  onProgress: (transferred, total) => {
                    const percent = total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0;
                    job.updateProgress(`[queue] ${humanBytes(transferred)} / ${humanBytes(total)} · ${percent}%`);
                  },
                },
              );
              job.append(`${JSON.stringify(summary)}
`);
              if (summary.cancelled) return { status: "killed", detail: `已取消：${summary.items.length}/${items.length} 项完成` };
              if (summary.failed > 0) {
                return {
                  status: "failed",
                  detail: `${items.length - summary.failed}/${items.length} 项成功 · ${humanBytes(summary.bytes)}`,
                };
              }
              return {
                status: "completed",
                detail: `${items.length} 项 · ${summary.files} 个文件 · ${humanBytes(summary.bytes)}`,
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
