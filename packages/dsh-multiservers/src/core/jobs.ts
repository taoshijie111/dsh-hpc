import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { ConnectionPool } from "./pool.js";
import { execRemote } from "./ssh.js";
import { MultiserversError, shellQuote, type Config, type ServerSpec } from "./types.js";

export type JobBackend = "bare" | "slurm";
export type ResolvedBackend = "bare" | "slurm" | "pbs" | "lsf";
export type JobState = "queued" | "running" | "completed" | "failed" | "cancelled" | "lost" | "unknown";

export type JobResources = {
  partition?: string;
  account?: string;
  qos?: string;
  time?: string;
  cpusPerTask?: number;
  memory?: string;
  gpus?: number;
};

export type JobSpec = {
  command?: string;
  script?: string;
  workdir: string;
  name?: string;
  resources?: JobResources;
};

export type JobRecord = {
  id: string;
  server: string;
  backend: JobBackend;
  schedulerJobId?: string;
  name: string;
  command: string;
  workdir: string;
  resources: Required<Pick<JobResources, never>> & JobResources;
  jobRoot: string;
  scriptPath: string;
  outPath: string;
  errPath: string;
  exitPath?: string;
  pid?: number;
  pidStart?: string;
  state: JobState;
  exitCode?: number | null;
  /** DSH background job id watching this remote job, when registered. */
  watchJobId?: string;
  createdAt: string;
  lastCheckedAt: string;
};

const ledgerDir = () => join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "multiservers", "jobs");

function ledgerPath(id: string): string {
  return join(ledgerDir(), `${id}.json`);
}

export function saveJob(record: JobRecord): void {
  mkdirSync(ledgerDir(), { recursive: true });
  writeFileSync(ledgerPath(record.id), JSON.stringify(record, null, 2), "utf8");
}

export function loadJob(id: string): JobRecord | undefined {
  try {
    return JSON.parse(readFileSync(ledgerPath(id), "utf8")) as JobRecord;
  } catch {
    return undefined;
  }
}

export function listJobs(server?: string): JobRecord[] {
  try {
    return readdirSync(ledgerDir())
      .filter((name) => name.endsWith(".json"))
      .map((name) => loadJob(name.slice(0, -5)))
      .filter((record): record is JobRecord => Boolean(record) && (!server || record!.server === server))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

function jobId(): string {
  return `mss-${randomBytes(6).toString("hex")}`;
}

function jobName(serverId: string, requested?: string): string {
  const base = (requested ?? serverId).replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 40);
  return `mss-${base}-${randomBytes(3).toString("hex")}`;
}

/** Resolve the backend for a server: explicit kind, cached detection, or a fresh probe. */
export async function resolveBackend(
  ctx: Context,
  pool: ConnectionPool,
  server: ServerSpec,
  persist?: (backend: ResolvedBackend) => Promise<void>,
): Promise<JobBackend> {
  if (server.kind === "bare" || server.kind === "slurm") return server.kind;
  if (server.resolvedKind === "bare" || server.resolvedKind === "slurm") return server.resolvedKind;
  const state = await pool.ensure(ctx, server);
  const result = await execRemote(
    state.client,
    [
      "if command -v scontrol >/dev/null 2>&1 || (command -v sbatch >/dev/null 2>&1 && command -v squeue >/dev/null 2>&1); then echo slurm",
      "elif command -v qsub >/dev/null 2>&1 || command -v qstat >/dev/null 2>&1; then echo pbs",
      "elif command -v bsub >/dev/null 2>&1 || command -v bjobs >/dev/null 2>&1; then echo lsf",
      "else echo bare; fi",
    ].join(String.fromCharCode(10)),
    { timeoutMs: 15_000 },
  );
  const detected = result.stdout.trim();
  if (detected === "pbs" || detected === "lsf") {
    await persist?.(detected);
    throw new MultiserversError(
      `Server "${server.id}" runs ${detected.toUpperCase()}; job submission currently supports Slurm and bare metal only.`,
    );
  }
  const backend: JobBackend = detected === "slurm" ? "slurm" : "bare";
  await persist?.(backend);
  return backend;
}

async function remoteHome(ctx: Context, pool: ConnectionPool, server: ServerSpec): Promise<string> {
  const state = await pool.ensure(ctx, server);
  const result = await execRemote(state.client, 'printf %s "$HOME"', { timeoutMs: 15_000 });
  const home = result.stdout.trim();
  if (!home.startsWith("/")) throw new MultiserversError(`Could not resolve HOME on ${server.id}`);
  return home;
}

function expandPath(path: string, home: string): string {
  return path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;
}

function jobRootFor(server: ServerSpec, home: string): string {
  return expandPath(server.jobRoot ?? "~/.multiservers/jobs", home);
}

function mergedResources(server: ServerSpec, overrides?: JobResources): JobResources {
  return { ...(server.schedulerDefaults ?? {}), ...(overrides ?? {}) };
}

function scriptForBare(record: JobRecord): string {
  return [
    "#!/bin/bash",
    `cd ${shellQuote(record.workdir)} || exit 127`,
    record.command,
    "__mss_rc=$?",
    `echo $__mss_rc > ${shellQuote(record.exitPath!)}`,
    "exit $__mss_rc",
    "",
  ].join("\n");
}

function sbatchLines(record: JobRecord): string {
  const lines = [
    "#!/bin/bash",
    `#SBATCH --job-name=${record.name}`,
    `#SBATCH --chdir=${record.workdir}`,
    `#SBATCH --output=${record.outPath}`,
    `#SBATCH --error=${record.errPath}`,
  ];
  const r = record.resources;
  if (r.partition) lines.push(`#SBATCH --partition=${r.partition}`);
  if (r.account) lines.push(`#SBATCH --account=${r.account}`);
  if (r.qos) lines.push(`#SBATCH --qos=${r.qos}`);
  if (r.time) lines.push(`#SBATCH --time=${r.time}`);
  if (r.cpusPerTask) lines.push(`#SBATCH --cpus-per-task=${r.cpusPerTask}`);
  if (r.memory) lines.push(`#SBATCH --mem=${r.memory}`);
  if (r.gpus) lines.push(`#SBATCH --gres=gpu:${r.gpus}`);
  lines.push("", record.command, "");
  return lines.join("\n");
}

async function writeRemoteFile(
  ctx: Context,
  pool: ConnectionPool,
  server: ServerSpec,
  path: string,
  content: string,
): Promise<void> {
  const state = await pool.ensure(ctx, server);
  const encoded = Buffer.from(content, "utf8").toString("base64");
  const result = await execRemote(
    state.client,
    `printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(path)} && chmod 700 ${shellQuote(path)}`,
    { timeoutMs: 30_000 },
  );
  if (result.code !== 0) throw new MultiserversError(`Could not write remote script: ${result.stderr.trim()}`);
}

export async function submitJob(
  ctx: Context,
  pool: ConnectionPool,
  server: ServerSpec,
  spec: JobSpec,
  persistBackend?: (backend: ResolvedBackend) => Promise<void>,
): Promise<JobRecord> {
  const command = (spec.script ? `bash ${shellQuote("<script>")}` : spec.command) ?? "";
  if (!spec.script && !spec.command) throw new MultiserversError("job_submit needs command or script");
  if (!spec.workdir.startsWith("/")) throw new MultiserversError("workdir must be absolute");

  const backend = await resolveBackend(ctx, pool, server, persistBackend);
  const home = await remoteHome(ctx, pool, server);
  const root = jobRootFor(server, home);
  const id = jobId();
  const name = jobName(server.id, spec.name);
  const record: JobRecord = {
    id,
    server: server.id,
    backend,
    name,
    command: spec.script ?? spec.command ?? "",
    workdir: spec.workdir,
    resources: mergedResources(server, spec.resources),
    jobRoot: root,
    scriptPath: `${root}/${id}.sh`,
    outPath: `${root}/${id}.out`,
    errPath: `${root}/${id}.err`,
    ...(backend === "bare" ? { exitPath: `${root}/${id}.exit` } : {}),
    state: "queued",
    createdAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
  };
  const state = await pool.ensure(ctx, server);
  const mkdir = await execRemote(state.client, `mkdir -p ${shellQuote(root)}`, { timeoutMs: 15_000 });
  if (mkdir.code !== 0) throw new MultiserversError(`Cannot create job directory ${root}: ${mkdir.stderr.trim()}`);

  if (backend === "bare") {
    await writeRemoteFile(ctx, pool, server, record.scriptPath, scriptForBare(record));
    const pidPath = `${root}/${id}.pid`;
    // The channel may stay open as long as the detached child holds inherited fds,
    // so cap the wait and read the pid from its file instead of the channel tail.
    const launch = await execRemote(
      state.client,
      `cd ${shellQuote(root)} && setsid nohup bash ${shellQuote(record.scriptPath)} > ${shellQuote(record.outPath)} 2> ${shellQuote(record.errPath)} < /dev/null & echo $! > ${shellQuote(pidPath)}`,
      { timeoutMs: 6_000 },
    );
    const pidRead = await execRemote(state.client, `cat ${shellQuote(pidPath)} 2>/dev/null || true`, { timeoutMs: 10_000 });
    const pid = Number((pidRead.stdout.trim() || launch.stdout.trim()).split(/\s+/).pop());
    if (!Number.isInteger(pid) || pid <= 0) throw new MultiserversError(`Could not start background job: ${launch.stderr.trim()}`);
    record.pid = pid;
    const startTime = await execRemote(state.client, `awk '{print $22}' /proc/${pid}/stat 2>/dev/null || true`, {
      timeoutMs: 10_000,
    });
    record.pidStart = startTime.stdout.trim() || undefined;
    record.state = "running";
  } else {
    record.command = spec.script ?? spec.command ?? "";
    await writeRemoteFile(ctx, pool, server, record.scriptPath, sbatchLines(record));
    const submit = await execRemote(state.client, `sbatch --parsable ${shellQuote(record.scriptPath)}`, {
      timeoutMs: 30_000,
    });
    if (submit.code !== 0) {
      throw new MultiserversError(`sbatch failed: ${(submit.stderr || submit.stdout).trim()}`);
    }
    const schedulerJobId = submit.stdout.trim().split(";")[0] ?? "";
    if (!/^\d+$/.test(schedulerJobId)) throw new MultiserversError(`Unexpected sbatch output: ${submit.stdout.trim()}`);
    record.schedulerJobId = schedulerJobId;
    record.state = "queued";
  }

  saveJob(record);
  return record;
}

async function refreshBare(ctx: Context, pool: ConnectionPool, server: ServerSpec, record: JobRecord): Promise<JobRecord> {
  const state = await pool.ensure(ctx, server);
  const probe = await execRemote(
    state.client,
    [
      `if [ -f ${shellQuote(record.exitPath!)} ]; then echo "EXIT:$(cat ${shellQuote(record.exitPath!)})";`,
      `elif kill -0 ${record.pid ?? 0} 2>/dev/null; then echo ALIVE:$(awk '{print $22}' /proc/${record.pid ?? 0}/stat 2>/dev/null);`,
      "else echo GONE; fi",
    ].join(String.fromCharCode(10)),
    { timeoutMs: 15_000 },
  );
  const line = probe.stdout.trim();
  record.lastCheckedAt = new Date().toISOString();
  if (line.startsWith("EXIT:")) {
    const code = Number(line.slice(5).trim());
    record.exitCode = Number.isFinite(code) ? code : null;
    record.state = record.state === "cancelled" ? "cancelled" : code === 0 ? "completed" : "failed";
  } else if (line.startsWith("ALIVE:")) {
    const start = line.slice(6).trim();
    if (record.pidStart && start && start !== record.pidStart) {
      record.state = "lost";
    } else if (record.state !== "cancelled") {
      record.state = "running";
    }
  } else {
    record.state = record.state === "cancelled" ? "cancelled" : "lost";
  }
  saveJob(record);
  return record;
}

async function refreshSlurm(ctx: Context, pool: ConnectionPool, server: ServerSpec, record: JobRecord): Promise<JobRecord> {
  const state = await pool.ensure(ctx, server);
  const id = record.schedulerJobId ?? "";
  const queue = await execRemote(state.client, `squeue -h -j ${id} -o %T 2>/dev/null || true`, { timeoutMs: 20_000 });
  record.lastCheckedAt = new Date().toISOString();
  const running = queue.stdout.trim().toUpperCase();
  if (running) {
    record.state = running.startsWith("PENDING") ? "queued" : "running";
    saveJob(record);
    return record;
  }
  const accounting = await execRemote(
    state.client,
    `sacct -j ${id} -n -P --format=State,ExitCode,Elapsed 2>/dev/null | head -1 || true`,
    { timeoutMs: 20_000 },
  );
  const row = accounting.stdout.trim().split("|");
  const stateText = (row[0] ?? "").split(" ")[0] ?? "";
  if (!stateText) {
    record.state = "unknown";
  } else if (stateText.startsWith("COMPLETED")) {
    const code = Number((row[1] ?? "0:0").split(":")[0]);
    record.exitCode = Number.isFinite(code) ? code : null;
    record.state = code === 0 ? "completed" : "failed";
  } else if (stateText.startsWith("CANCELLED")) {
    record.state = "cancelled";
  } else if (/FAILED|TIMEOUT|OUT_OF_MEMORY|NODE_FAIL|PREEMPTED|BOOT_FAIL|DEADLINE/.test(stateText)) {
    record.state = "failed";
  } else {
    record.state = "unknown";
  }
  saveJob(record);
  return record;
}

/** Reconcile one ledger record with the scheduler or process. */
export async function refreshJob(
  ctx: Context,
  pool: ConnectionPool,
  server: ServerSpec,
  record: JobRecord,
): Promise<JobRecord> {
  return record.backend === "slurm"
    ? refreshSlurm(ctx, pool, server, record)
    : refreshBare(ctx, pool, server, record);
}

export async function queryJobs(
  ctx: Context,
  pool: ConnectionPool,
  servers: ServerSpec[],
  options: { serverId?: string; jobId?: string },
): Promise<JobRecord[]> {
  const records = options.jobId ? [loadJob(options.jobId)].filter(Boolean) as JobRecord[] : listJobs(options.serverId);
  const results: JobRecord[] = [];
  for (const record of records) {
    if (options.serverId && record.server !== options.serverId) continue;
    const server = servers.find((entry) => entry.id === record.server);
    if (!server) {
      record.state = "lost";
      results.push(record);
      continue;
    }
    if (["completed", "failed", "cancelled", "lost"].includes(record.state)) {
      results.push(record);
      continue;
    }
    results.push(
      record.backend === "slurm"
        ? await refreshSlurm(ctx, pool, server, record)
        : await refreshBare(ctx, pool, server, record),
    );
  }
  return results;
}

export async function readJobLogs(
  ctx: Context,
  pool: ConnectionPool,
  server: ServerSpec,
  record: JobRecord,
  options: { offset?: number; maxBytes?: number; stream?: "stdout" | "stderr" },
): Promise<{ text: string; nextOffset: number; truncated: boolean }> {
  const path = options.stream === "stderr" ? record.errPath : record.outPath;
  const offset = Math.max(0, options.offset ?? 0);
  const maxBytes = Math.max(1, options.maxBytes ?? 64 * 1024);
  const state = await pool.ensure(ctx, server);
  const result = await execRemote(
    state.client,
    `if [ -f ${shellQuote(path)} ]; then tail -c +${offset + 1} ${shellQuote(path)} | head -c ${maxBytes}; fi`,
    { timeoutMs: 30_000 },
  );
  const text = result.stdout;
  const nextOffset = offset + Buffer.byteLength(text, "utf8");
  const sizeCheck = await execRemote(
    state.client,
    `if [ -f ${shellQuote(path)} ]; then wc -c < ${shellQuote(path)}; else echo 0; fi`,
    { timeoutMs: 15_000 },
  );
  const total = Number(sizeCheck.stdout.trim()) || 0;
  return { text, nextOffset, truncated: total > nextOffset };
}

export async function cancelJob(
  ctx: Context,
  pool: ConnectionPool,
  server: ServerSpec,
  record: JobRecord,
): Promise<JobRecord> {
  const state = await pool.ensure(ctx, server);
  if (record.backend === "slurm" && record.schedulerJobId) {
    await execRemote(state.client, `scancel ${record.schedulerJobId}`, { timeoutMs: 20_000 });
  } else if (record.pid) {
    await execRemote(state.client, `kill -TERM -- -${record.pid} 2>/dev/null || kill -TERM ${record.pid} 2>/dev/null || true`, {
      timeoutMs: 15_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await execRemote(state.client, `kill -KILL ${record.pid} 2>/dev/null || true`, { timeoutMs: 15_000 });
  }
  record.state = "cancelled";
  record.lastCheckedAt = new Date().toISOString();
  saveJob(record);
  return record;
}

/** Detect and describe the scheduler for server_test(profile). */
export async function describeScheduler(
  ctx: Context,
  pool: ConnectionPool,
  server: ServerSpec,
): Promise<{ backend: JobBackend; detected: boolean }> {
  const backend = await resolveBackend(ctx, pool, server);
  return { backend, detected: !server.kind || server.kind === "auto" };
}

export type { Config };
