import type { Context } from "@deepseek-ai/cordis";
import type { JobHandle, JobHooks, JobOutcome } from "@deepseek-ai/dsh-jobs";
import type { ConnectionPool } from "./pool.js";
import { listJobs, loadJob, refreshJob } from "./jobs.js";
import type { JobRecord } from "./jobs.js";
import type { ServerSpec } from "./types.js";

/** Minimal surface of the DSH background-job registry this plugin relies on. */
type JobsService = {
  start(spec: {
    kind: string;
    label: string;
    owner?: string;
    outputLimitBytes?: number;
    run(job: JobHandle): JobHooks;
  }): string;
  kill(id: string, caller?: string, reason?: string): "requested" | "already-finished";
};

const FIRST_DELAY = 15_000;
const MAX_DELAY = 15 * 60_000;
const TERMINAL = new Set(["completed", "failed", "cancelled", "lost"]);

export function isTerminal(state: string): boolean {
  return TERMINAL.has(state);
}

function nextDelay(previous: number): number {
  return Math.min(MAX_DELAY, Math.round(previous * 1.7));
}

function sleep(ms: number, signal: { cancelled: boolean }): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    void signal;
  });
}

/**
 * Watch one remote job from this host and settle the DSH background job when it
 * finishes. Polling is adaptive (15s growing to 15min) and only asks the
 * scheduler/process for state: no remote sampler, no remote log growth.
 */
export function startJobWatcher(
  ctx: Context,
  pool: ConnectionPool,
  getServers: () => ServerSpec[],
  recordId: string,
  ownerSessionId?: string,
): string | null {
  const jobs = ctx.get("jobs") as JobsService | undefined;
  if (!jobs?.start) return null;
  const state = { cancelled: false };
  try {
    return jobs.start({
      kind: "mss-job",
      label: `远程作业 ${recordId}`,
      ...(ownerSessionId ? { owner: ownerSessionId } : {}),
      outputLimitBytes: 4096,
      run(job: JobHandle): JobHooks {
        const done = (async (): Promise<JobOutcome> => {
          let delay = FIRST_DELAY;
          let lastState = "";
          for (;;) {
            if (state.cancelled) return { status: "killed", detail: "监控已取消" };
            const record = loadJob(recordId);
            if (!record) return { status: "failed", detail: "作业账本不存在" };
            if (isTerminal(record.state)) {
              job.append(`${record.state} exit=${record.exitCode ?? "?"}\n`);
              return {
                status: record.state === "completed" ? "completed" : record.state === "cancelled" ? "killed" : "failed",
                detail: `${record.state} 退出码 ${record.exitCode ?? "未知"}`,
                result: `${record.server} ${record.id} ${record.state}`,
              };
            }
            const server = getServers().find((entry) => entry.id === record.server);
            if (!server) return { status: "failed", detail: `服务器 ${record.server} 已不在配置中` };
            let refreshed: JobRecord | null = null;
            try {
              refreshed = await refreshJob(ctx, pool, server, record);
            } catch (error) {
              job.append(`状态查询失败：${(error as Error).message}\n`);
            }
            if (refreshed && isTerminal(refreshed.state)) continue;
            if (refreshed && refreshed.state !== lastState) {
              lastState = refreshed.state;
              job.updateProgress(`${refreshed.state} · 已等待 ${Math.round(delay / 1000)}s 轮询`);
            } else {
              job.updateProgress(refreshed ? `${refreshed.state} · 下次检查 ${Math.round(delay / 1000)}s 后` : "等待连接…");
            }
            await sleep(delay, state);
            delay = nextDelay(delay);
          }
        })();
        done.catch(() => undefined);
        return {
          cancel() {
            state.cancelled = true;
          },
          done,
        };
      },
    });
  } catch {
    return null;
  }
}

/** Resume watchers for unfinished jobs after a plugin reload. */
export function resumeWatchers(
  ctx: Context,
  pool: ConnectionPool,
  getServers: () => ServerSpec[],
): number {
  let count = 0;
  for (const record of listJobs()) {
    if (isTerminal(record.state) || record.watchJobId) continue;
    if (startJobWatcher(ctx, pool, getServers, record.id)) count += 1;
  }
  return count;
}
