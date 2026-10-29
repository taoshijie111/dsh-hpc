#!/usr/bin/env node
/**
 * Job subsystem integration test: bare metal (setsid/nohup) + Slurm (sbatch).
 * Credentials are read at runtime from the DSH credential store; values are never printed.
 *
 * Env overrides: HPC_TEST_SLURM_ID, HPC_TEST_BARE_ID, HPC_TEST_USER, HPC_TEST_USER.
 */
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as plugin from "../lib/index.js";
const __need = ["HPC_TEST_HOST_A", "HPC_TEST_USER", "HPC_TEST_PASSWORD_A", "HPC_TEST_HOST_B", "HPC_TEST_PASSWORD_B"];
if (__need.some((key) => !process.env[key])) {
  console.log(`SKIP: set ${__need.join(", ")} to run integration tests`);
  process.exit(0);
}


const Slurm 测试机Id = process.env.HPC_TEST_SLURM_ID ?? "slurm-test";
const bareId = process.env.HPC_TEST_BARE_ID ?? "bare-test";
const user = process.env.MSS_USER ?? (process.env.HPC_TEST_USER ?? "");

function credentialStore() {
  const file = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), ".credentials.yaml");
  const map = new Map();
  if (!existsSync(file)) return map;
  let inRefs = false;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (/^refs:/.test(line)) {
      inRefs = true;
      continue;
    }
    if (/^\S/.test(line) && inRefs) inRefs = false;
    if (!inRefs) continue;
    const match = /^\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (match) map.set(match[1], match[2].trim().replace(/^["']|["']$/g, ""));
  }
  return map;
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const store = credentialStore();
const watched = [];
const killedWatches = [];
const fakeJobs = {
  start(spec) {
    watched.push(spec);
    const job = { id: `hpc-job-${watched.length}`, append() {}, updateProgress() {} };
    const hooks = spec.run(job);
    hooks.done.catch(() => undefined);
    return job.id;
  },
  kill(id) {
    killedWatches.push(id);
    return "requested";
  },
};
const registered = new Map();
const effects = [];
const ctx = {
  tools: { register: (d) => (registered.set(d.name, d), () => registered.delete(d.name)) },
  credentials: {
    resolve: async (ref) => {
      const name = typeof ref === "string" ? ref : (ref && (ref.name ?? ref.ref)) || String(ref);
      const value = store.get(name);
      return value ? { value } : undefined;
    },
    describe: async () => ({ configured: true }),
    set: async () => undefined,
    unset: async () => undefined,
  },
  get: (name) => (name === "jobs" ? fakeJobs : undefined),
  inject: (_names, callback) => callback({}),
  effect(fn) {
    const dispose = fn();
    if (typeof dispose === "function") effects.push(dispose);
    return dispose;
  },
};

const config = {
  servers: [
    { id: Slurm 测试机Id, host: (process.env.HPC_TEST_HOST_A ?? ""), port: 22, username: user, auth: "password", passwordRef: "HPC_TEST_PASSWORD_A", kind: "slurm" },
    { id: bareId, host: (process.env.HPC_TEST_HOST_B ?? ""), port: 22, username: user, auth: "password", passwordRef: "HPC_TEST_PASSWORD_B", kind: "bare" },
  ],
  connectTimeoutMs: 20000,
  commandTimeoutMs: 120000,
  keepaliveIntervalMs: 30000,
  idleTimeoutMs: 600000,
  maxSessionsPerServer: 4,
  sessionIdleTimeoutMs: 1800000,
};
plugin.apply(ctx, config);
const call = (name, args) => {
  const definition = registered.get(name);
  if (!definition) throw new Error(`tool ${name} missing`);
  return definition.execute(args, { signal: new AbortController().signal });
};

const cleanup = [];

try {
  check("job tools registered", ["job_submit", "job_status", "job_logs", "job_cancel"].every((n) => registered.has(n)));

  const bareHomeRaw = await call("shell_run", { server: bareId, command: 'printf %s "$HOME"' });
  const bareHome = bareHomeRaw.stdout.trim();
  const Slurm 测试机HomeRaw = await call("shell_run", { server: Slurm 测试机Id, command: 'printf %s "$HOME"' });
  const Slurm 测试机Home = Slurm 测试机HomeRaw.stdout.trim();
  check("target hosts reachable", bareHome.startsWith("/") && Slurm 测试机Home.startsWith("/"), `${bareId}:${bareHome} | ${Slurm 测试机Id}:${Slurm 测试机Home}`);

  // ---- bare metal ----
  const bare = await call("job_submit", {
    server: bareId,
    command: "echo hello-bare; sleep 10; echo bye-bare",
    workdir: bareHome,
    name: "baretest",
  });
  cleanup.push(bare.jobId);
  check("bare submit returns a running detached job", bare.backend === "bare" && bare.state === "running" && Boolean(bare.pid), `pid=${bare.pid}`);
  const bareRunning = await call("job_status", { jobId: bare.jobId });
  check("bare job reported running", bareRunning.jobs[0]?.state === "running");
  const partial = await call("job_logs", { jobId: bare.jobId });
  check("bare log readable during run", partial.text.includes("hello-bare"), JSON.stringify(partial.text.trim()));

  await sleep(13000);
  const bareDone = await call("job_status", { jobId: bare.jobId });
  check("bare job completes with exit 0", bareDone.jobs[0]?.state === "completed" && bareDone.jobs[0]?.exitCode === 0);
  const full = await call("job_logs", { jobId: bare.jobId });
  check("bare log has the tail", full.text.includes("bye-bare"));

  check("job_submit registers a local watcher", bare.watching === true && watched.length >= 1 && String(bare.watchJobId).startsWith("hpc-job-"), `watch=${bare.watchJobId}`);

  const waited = await call("job_wait", { jobId: bare.jobId, timeoutMs: 15000 });
  check("job_wait returns the terminal state", waited.state === "completed" && waited.exitCode === 0 && waited.timedOut === false);

  const bareLong = await call("job_submit", { server: bareId, command: "sleep 60", workdir: bareHome, name: "cancelme" });
  cleanup.push(bareLong.jobId);
  const cancelled = await call("job_cancel", { jobId: bareLong.jobId });
  check("bare cancel marks cancelled", cancelled.state === "cancelled");
  check("job_cancel stops the watcher", killedWatches.length >= 1);
  const gone = await call("job_status", { jobId: bareLong.jobId });
  check("bare cancelled job has no exit 0", gone.jobs[0]?.state === "cancelled");

  // ---- slurm ----
  const partitionRaw = await call("shell_run", { server: Slurm 测试机Id, command: "sinfo -h -o '%P' 2>/dev/null | head -1" });
  const partition = partitionRaw.stdout.trim().replace(/\*$/, "");
  check("slurm partition discovered", partition.length > 0, partition);
  const slurm = await call("job_submit", {
    server: Slurm 测试机Id,
    command: "echo hello-slurm; sleep 20",
    workdir: Slurm 测试机Home,
    partition,
  });
  cleanup.push(slurm.jobId);
  check("slurm submit returns a scheduler job id", slurm.backend === "slurm" && /^\d+$/.test(slurm.schedulerJobId ?? ""), `slurm=${slurm.schedulerJobId}`);
  await sleep(2000);
  const slurmStatus = await call("job_status", { jobId: slurm.jobId });
  check("slurm job is queued or running", ["queued", "running"].includes(slurmStatus.jobs[0]?.state));
  const slurmCancel = await call("job_cancel", { jobId: slurm.jobId });
  check("slurm cancel marks cancelled", slurmCancel.state === "cancelled");
  const slurmLogs = await call("job_logs", { jobId: slurm.jobId, maxBytes: 4096 });
  check("slurm log path readable", typeof slurmLogs.text === "string");
} catch (error) {
  console.error(error && error.stack); check("run completed without throwing", false, error?.message ?? String(error));
} finally {
  for (const id of cleanup) {
    const path = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "hpc", "jobs", `${id}.json`);
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      /* ignore */
    }
  }
  for (const dispose of effects.reverse()) {
    try {
      dispose();
    } catch {
      /* ignore */
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
