import type { JobState } from "./jobs.js";

/**
 * Pure state-machine helpers for the remote-job watchdog.
 *
 * The watchdog binds a job to a stable handle — a Slurm JOBID, or a bare-metal
 * PID plus its kernel start time — and resolves the state on every poll. These
 * functions hold the whole decision table so it can be tested without SSH:
 * the caller only supplies raw scheduler output.
 */

/** Consecutive unresolved polls before the watchdog escalates to `scontrol`. */
export const UNKNOWN_LIMIT = 3;
/** Output must be silent this long before a vanished job is called lost. */
export const LOST_SILENCE_MS = 60_000;

export type Verdict = {
  state: JobState;
  exitCode?: number | null;
  /** Explanation persisted on terminal transitions and shown in job output. */
  note?: string;
};

const FAILED_STATES = /FAILED|TIMEOUT|OUT_OF_MEMORY|NODE_FAIL|PREEMPTED|BOOT_FAIL|DEADLINE/;
const INTERMEDIATE_RUNNING = new Set(["COMPLETING", "STAGE_OUT", "REQUEUED", "RESIZING"]);
const INTERMEDIATE_QUEUED = new Set(["CONFIGURING", "REQUEUED_HOLD"]);

/** Map one scheduler state word onto this plugin's state machine. */
export function mapSlurmState(text: string): Verdict | null {
  const word = (text.trim().toUpperCase().split(/\s+/)[0] ?? "").replace(/\+$/, "");
  if (!word) return null;
  if (word.startsWith("PENDING") || INTERMEDIATE_QUEUED.has(word)) return { state: "queued" };
  if (word.startsWith("RUNNING") || word.startsWith("SUSPENDED") || INTERMEDIATE_RUNNING.has(word)) {
    return { state: "running" };
  }
  if (word.startsWith("COMPLETED")) return { state: "completed", exitCode: null };
  if (word.startsWith("CANCELLED")) return { state: "cancelled" };
  if (FAILED_STATES.test(word)) return { state: "failed" };
  return null;
}

/**
 * Classify one `sacct -n -P --format=State,ExitCode,Elapsed` row. `sacct` keeps
 * reporting a job while it runs, so a RUNNING row is as authoritative as
 * `squeue` and prevents a false "lost" while accounting catches up.
 */
export function classifySlurmAccounting(line: string): Verdict | null {
  const row = line.trim().split("|");
  const stateText = (row[0] ?? "").trim();
  if (!stateText) return null;
  const base = mapSlurmState(stateText);
  if (!base) return null;
  const raw = (row[1] ?? "").split(":")[0]?.trim() ?? "";
  const code = raw === "" ? null : Number(raw);
  const exitCode = code !== null && Number.isFinite(code) ? code : null;
  if (base.state === "completed") {
    if (exitCode === null) return { state: "completed", exitCode: null };
    return { state: exitCode === 0 ? "completed" : "failed", exitCode };
  }
  if (base.state === "failed") return { state: "failed", exitCode };
  return base;
}

/** Classify the single line printed by `scontrol show job <id> -o`. */
export function classifySlurmScontrol(text: string): Verdict | null {
  const state = /(?:^|\s)JobState=([A-Z_]+)/.exec(text)?.[1];
  if (!state) return null;
  const base = mapSlurmState(state);
  if (!base) return null;
  const exit = /(?:^|\s)ExitCode=(-?\d+):\d+/.exec(text)?.[1];
  if (base.state === "completed" || base.state === "failed") {
    const code = exit === undefined ? null : Number(exit);
    if (code === null || !Number.isFinite(code)) return { state: base.state, exitCode: null };
    return { state: code === 0 ? "completed" : "failed", exitCode: code };
  }
  return base;
}

export type SlurmPollInput = {
  /** `record.unknownPolls`, i.e. polls that already failed to resolve a state. */
  unknownPolls: number;
  /** stdout of `squeue -h -j <id> -o %T` (empty once the job leaves the queue). */
  queue: string;
  /** stdout of the `sacct` probe (empty when accounting is disabled or lagging). */
  accounting: string;
};

export type SlurmPollPlan = {
  /** Final verdict, or null when the caller must escalate to `scontrol`. */
  verdict: Verdict | null;
  /** Counter to persist on the record. */
  unknownPolls: number;
  escalate: boolean;
};

/**
 * Decide what a single poll can conclude. A job that keeps resolving to
 * "unknown" is not left to spin at the 15-minute backoff ceiling: after
 * UNKNOWN_LIMIT misses the caller runs the escalation probes.
 */
export function planSlurmPoll(input: SlurmPollInput): SlurmPollPlan {
  const queue = mapSlurmState(input.queue);
  if (queue) return { verdict: queue, unknownPolls: 0, escalate: false };
  const accounting = classifySlurmAccounting(input.accounting);
  if (accounting) return { verdict: accounting, unknownPolls: 0, escalate: false };
  const unknownPolls = Math.max(0, input.unknownPolls) + 1;
  if (unknownPolls < UNKNOWN_LIMIT) {
    return { verdict: { state: "unknown" }, unknownPolls, escalate: false };
  }
  return { verdict: null, unknownPolls, escalate: true };
}

export type SlurmEscalationInput = {
  /** stdout of `scontrol show job <id> -o` (empty when the controller forgot the job). */
  scontrol: string;
  /** Now minus the newest mtime of the job's out/err files; undefined when neither exists. */
  outputSilentMs?: number;
};

const ABSENT_JOB = /Invalid job id|not found|No such job|Unknown job|JobId=\S+ not found/i;

/**
 * Second look for a job the scheduler no longer lists. Slurm purges finished
 * jobs from `scontrol` almost immediately when accounting is off, so the final
 * fallback is the output file: a job that left every controller view and has
 * stopped writing output is over — its exit code is simply unknowable.
 *
 * "Lost" requires the controller to say the job is unknown. A controller that
 * is merely unreachable (restart, socket timeout) must not fabricate a result,
 * so an unrecognised scontrol answer stays `unknown`.
 */
export function applySlurmEscalation(input: SlurmEscalationInput): Verdict {
  const scontrol = classifySlurmScontrol(input.scontrol);
  if (scontrol) return scontrol;
  if (!ABSENT_JOB.test(input.scontrol)) return { state: "unknown" };
  if (input.outputSilentMs === undefined) {
    return {
      state: "lost",
      note: "调度器已不认这个作业号，也没有会计记录，输出文件不存在：退出码未知",
    };
  }
  if (input.outputSilentMs >= LOST_SILENCE_MS) {
    return {
      state: "lost",
      note: `调度器已不认这个作业号，也没有会计记录；输出已静默 ${Math.round(input.outputSilentMs / 1000)}s：退出码未知`,
    };
  }
  return { state: "unknown" };
}

export type BareProbeRecord = {
  state: JobState;
  /** Kernel start time of the PID captured at submit; guards against PID reuse. */
  pidStart?: string;
};

/**
 * Classify one bare-metal probe: `<id>.exit` (authoritative), `kill -0` plus
 * start time (PID reuse guard), or neither (the process is gone).
 */
export function classifyBare(record: BareProbeRecord, probe: string): Verdict {
  const line = probe.trim();
  // An empty probe means the probe itself failed (connection hiccup), which is
  // not evidence that the process is gone — never turn that into "lost".
  if (line === "") return { state: record.state === "cancelled" ? "cancelled" : "unknown" };
  if (line.startsWith("EXIT:")) {
    const code = Number(line.slice(5).trim());
    const exitCode = Number.isFinite(code) ? code : null;
    if (record.state === "cancelled") return { state: "cancelled", exitCode };
    if (exitCode === null) return { state: "failed", exitCode };
    return { state: exitCode === 0 ? "completed" : "failed", exitCode };
  }
  if (line.startsWith("ALIVE:")) {
    const start = line.slice(6).trim();
    if (record.pidStart && start && start !== record.pidStart) {
      return {
        state: "lost",
        note: "进程号已被系统复用：作业已结束，但没有写入退出码文件",
      };
    }
    return { state: record.state === "cancelled" ? "cancelled" : "running" };
  }
  return {
    state: record.state === "cancelled" ? "cancelled" : "lost",
    note: "进程已不存在，且没有写入退出码文件：退出码未知",
  };
}
