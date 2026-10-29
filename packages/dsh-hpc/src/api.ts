import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type { ConnectionPool } from "./core/pool.js";
import type { SessionRegistry } from "./core/session.js";
import { connect, execRemote } from "./core/ssh.js";
import { findServer, HpcError, type Config } from "./core/types.js";

/**
 * Two sampling modes:
 * - slurm: compute-node capacity from sinfo/scontrol/squeue; the login node is only a reference line
 * - bare:  this machine's own CPU/memory/GPU/disk
 */
function buildScript(): string {
  return [
    "if command -v scontrol >/dev/null 2>&1; then",
    "  echo __MODE__slurm",
    "  echo __SINFO__; sinfo -h -N -o '%P|%t|%m' 2>/dev/null | head -400",
    "  echo __NODES__; scontrol show node -o 2>/dev/null | head -400",
    "  echo __QUEUE__; squeue -h -o '%T' 2>/dev/null | sort | uniq -c",
    "elif command -v qsub >/dev/null 2>&1 || command -v qstat >/dev/null 2>&1; then",
    "  echo __MODE__queue",
    "  echo __QUEUESYS__pbs",
    "elif command -v bsub >/dev/null 2>&1 || command -v bjobs >/dev/null 2>&1; then",
    "  echo __MODE__queue",
    "  echo __QUEUESYS__lsf",
    "else",
    "  echo __MODE__bare",
    "  echo __LOAD__; uptime",
    "  echo __CPU__; top -bn1 2>/dev/null | grep -m1 'Cpu(s)' || echo unknown",
    "  echo __MEM__; free -m 2>/dev/null | grep -m1 'Mem:' || echo unknown",
    "  echo __MEMINFO__; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo 2>/dev/null || true",
    "  echo __GPU__; nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null || echo none",
    "  echo __DISK__; df -P -h -x tmpfs -x devtmpfs 2>/dev/null | tail -n +2 | head -10",
    "fi",
    "echo __LOGINLOAD__; uptime",
    "echo __LOGINCPU__; top -bn1 2>/dev/null | grep -m1 'Cpu(s)' || echo unknown",
    "echo __LOGINMEM__; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo 2>/dev/null || true",
    "echo __NPROC__; nproc 2>/dev/null || echo 1",
  ].join("\n");
}

type WebServer = {
  register(route: {
    kind: "exact";
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }): () => void;
};

export let ctxForApi: Context;
export function setApiContext(ctx: Context): void {
  ctxForApi = ctx;
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function allowed(req: IncomingMessage): boolean {
  return req.method === "GET" && req.headers["x-hpc-request"] === "1";
}

function section(raw: string, name: string): string {
  const start = raw.indexOf(`__${name}__`);
  if (start < 0) return "";
  const rest = raw.slice(start + name.length + 4);
  const end = rest.search(/\n__[A-Z]+__/);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

type CpuStats = { usagePercent: number | null; cores: number; load: number[] };
type MemStats = { totalMb: number; usedMb: number; availableMb: number; percent: number };

function parseCpu(raw: string, nproc: number): CpuStats {
  const loadMatch = /load average:\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(raw);
  const load = loadMatch ? [Number(loadMatch[1]), Number(loadMatch[2]), Number(loadMatch[3])] : [];
  const idleMatch = /([\d.]+)\s*id/.exec(raw);
  const usagePercent = idleMatch ? Math.max(0, Math.min(100, Math.round((100 - Number(idleMatch[1])) * 10) / 10)) : null;
  return { usagePercent, cores: nproc, load };
}

function parseMemory(raw: string): MemStats | null {
  const totalKb = Number(/MemTotal:\s*(\d+)/.exec(raw)?.[1]);
  const availableKb = Number(/MemAvailable:\s*(\d+)/.exec(raw)?.[1]);
  if (Number.isFinite(totalKb) && totalKb > 0 && Number.isFinite(availableKb)) {
    const totalMb = Math.round(totalKb / 1024);
    const availableMb = Math.round(availableKb / 1024);
    const usedMb = Math.max(0, totalMb - availableMb);
    return { totalMb, usedMb, availableMb, percent: Math.round((usedMb / totalMb) * 1000) / 10 };
  }
  const parts = raw.split(/\s+/);
  if (parts.length >= 7) {
    const totalMb = Number(parts[1]);
    const usedMb = Number(parts[2]);
    const availableMb = Number(parts[6] ?? parts[3]);
    if (Number.isFinite(totalMb) && totalMb > 0) {
      return { totalMb, usedMb, availableMb, percent: Math.round((usedMb / totalMb) * 1000) / 10 };
    }
  }
  return null;
}

function parseGpus(raw: string): Array<{ index: number; name: string; utilPercent: number; memUsedMb: number; memTotalMb: number }> {
  if (!raw || raw === "none") return [];
  const gpus = [];
  for (const rawLine of raw.split("\n")) {
    const cells = rawLine.split(",").map((cell) => cell.trim());
    if (cells.length < 5) continue;
    const utilPercent = Number(cells[2]);
    const memUsedMb = Number(cells[3]);
    const memTotalMb = Number(cells[4]);
    if (!Number.isFinite(utilPercent) || !Number.isFinite(memTotalMb) || memTotalMb <= 0) continue;
    gpus.push({ index: Number(cells[0]) || gpus.length, name: cells[1] ?? "GPU", utilPercent, memUsedMb, memTotalMb });
  }
  return gpus;
}

function parseDisks(raw: string): Array<{ filesystem: string; size: string; used: string; avail: string; percent: number; mount: string }> {
  return raw
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 6)
    .filter((parts) => !/^\/boot/.test(parts[5]!) && !/^\/(sys|proc|run)/.test(parts[5]!) && parts[0] !== "efivarfs")
    .map((parts) => ({
      filesystem: parts[0]!,
      size: parts[1]!,
      used: parts[2]!,
      avail: parts[3]!,
      percent: Number(String(parts[4]).replace("%", "")) || 0,
      mount: parts[5]!,
    }))
    .filter((disk, index, all) => all.findIndex((entry) => entry.mount === disk.mount) === index)
    .slice(0, 4);
}

function parsePartitions(raw: string) {
  const partitions = new Map<string, { name: string; idle: number; mixed: number; allocated: number; down: number; other: number; memoryMb: number }>();
  for (const rawLine of raw.split("\n")) {
    const [partitionRaw, stateRaw, memoryRaw] = rawLine.trim().split("|");
    if (!partitionRaw) continue;
    const name = partitionRaw.replace(/\*$/, "") || "default";
    const entry = partitions.get(name) ?? { name, idle: 0, mixed: 0, allocated: 0, down: 0, other: 0, memoryMb: 0 };
    entry.memoryMb += Number(memoryRaw) || 0;
    const state = (stateRaw ?? "").trim().toLowerCase();
    if (state.startsWith("idle")) entry.idle += 1;
    else if (state.startsWith("mix")) entry.mixed += 1;
    else if (state.startsWith("alloc")) entry.allocated += 1;
    else if (/down|drain|fail|maint|unknown/.test(state)) entry.down += 1;
    else entry.other += 1;
    partitions.set(name, entry);
  }
  return [...partitions.values()].sort((a, b) => (b.idle + b.mixed + b.allocated) - (a.idle + a.mixed + a.allocated));
}

function parseNodes(raw: string) {
  const nodes = {
    total: 0,
    idle: 0,
    mixed: 0,
    allocated: 0,
    down: 0,
    other: 0,
    cpus: { total: 0, allocated: 0 },
    memoryMb: { total: 0, allocated: 0, freeMb: 0 },
    gpus: { total: 0, used: 0 },
  };
  for (const rawLine of raw.split("\n")) {
    const text = rawLine.trim();
    if (!text.startsWith("NodeName=")) continue;
    const field = (key: string) => new RegExp(`${key}=(\\S+)`).exec(text)?.[1] ?? "";
    nodes.total += 1;
    const state = field("State").toLowerCase();
    if (state.startsWith("idle")) nodes.idle += 1;
    else if (state.startsWith("mix")) nodes.mixed += 1;
    else if (state.startsWith("alloc")) nodes.allocated += 1;
    else if (/down|drain|fail|maint|unknown/.test(state)) nodes.down += 1;
    else nodes.other += 1;
    nodes.cpus.total += Number(field("CPUTot")) || 0;
    nodes.cpus.allocated += Number(field("CPUAlloc")) || 0;
    const realMemory = Number(field("RealMemory")) || 0;
    // Clusters often misreport RealMemory as 1; only trust plausible values.
    if (realMemory > 512) nodes.memoryMb.total += realMemory;
    nodes.memoryMb.allocated += Number(field("AllocMem")) || 0;
    nodes.memoryMb.freeMb += Number(field("FreeMem")) || 0;
    const gres = /Gres=([^\s]+)/.exec(text)?.[1] ?? "";
    const gpuTotal = /gpu:(\d+)/.exec(gres)?.[1];
    if (gpuTotal) nodes.gpus.total += Number(gpuTotal);
    const gresUsed = /GresUsed=([^\s]+)/.exec(text)?.[1] ?? "";
    const gpuUsed = /gpu:(\d+)/.exec(gresUsed)?.[1];
    if (gpuUsed) nodes.gpus.used += Number(gpuUsed);
  }
  return nodes;
}

function parseQueue(raw: string): { running: number; pending: number; other: number } {
  const result = { running: 0, pending: 0, other: 0 };
  for (const rawLine of raw.split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)/.exec(rawLine);
    if (!match) continue;
    const count = Number(match[1]);
    const state = match[2]!.toUpperCase();
    if (state === "RUNNING" || state === "COMPLETING" || state === "CONFIGURING") result.running += count;
    else if (state === "PENDING") result.pending += count;
    else result.other += count;
  }
  return result;
}

const DETECT_SCRIPT = [
  "if command -v scontrol >/dev/null 2>&1 || (command -v sbatch >/dev/null 2>&1 && command -v squeue >/dev/null 2>&1); then echo slurm",
  "elif command -v qsub >/dev/null 2>&1 || command -v qstat >/dev/null 2>&1; then echo pbs",
  "elif command -v bsub >/dev/null 2>&1 || command -v bjobs >/dev/null 2>&1; then echo lsf",
  "else echo bare; fi",
].join(String.fromCharCode(10));

type SettingsLike = {
  describe(): Array<{ ns: string; revision: number; value?: unknown }>;
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>;
};

/** Remember the detected kind so the server card stops showing "auto". */
async function persistResolvedKind(
  serverId: string,
  kind: "bare" | "slurm" | "pbs" | "lsf",
  current: Config,
): Promise<boolean> {
  const settings = ctxForApi?.get("settings") as SettingsLike | undefined;
  if (!settings) return false;
  try {
    const own = settings.describe().find((entry) => entry.ns === "hpc");
    const servers = current.servers.map((server) => (server.id === serverId ? { ...server, resolvedKind: kind } : server));
    await settings.update("hpc", { servers }, own?.revision);
    return true;
  } catch {
    return false;
  }
}

function percentOf(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

/** Turn a raw 2FA auth error into an actionable message for the settings page. */
function twoFactorMessage(message: string): string {
  if (/verification code|keyboard-interactive/i.test(message)) {
    return `${message} — this server needs a one-time verification code: ask the agent to run server_connect with the current code in the conversation, then retry.`;
  }
  return message;
}

/** Register the settings-page HTTP facade: status snapshot and on-demand resource sampling. */
export function registerApi(
  webServer: WebServer,
  getConfig: () => Config,
  pool: ConnectionPool,
  sessions: SessionRegistry,
): Array<() => void> {
  const status = webServer.register({
    kind: "exact",
    path: "/api/hpc/status",
    handler: (req, res) => {
      if (!allowed(req)) return json(res, 403, { error: "forbidden" });
      const config = getConfig();
      const live = new Map(pool.list().map((entry) => [entry.serverId, entry]));
      json(res, 200, {
        servers: config.servers.map((server) => {
          const state = live.get(server.id);
          return {
            id: server.id,
            label: server.label ?? server.id,
            host: server.host,
            port: server.port ?? 22,
            username: server.username,
            auth: server.auth,
            kind: server.kind === "auto" || !server.kind ? server.resolvedKind ?? "auto" : server.kind,
            configuredKind: server.kind ?? "auto",
            resolvedKind: server.resolvedKind ?? null,
            hostKeyPinned: Boolean(server.hostKey),
            connected: Boolean(state),
            idleSinceMs: state?.idleSinceMs ?? null,
            sessions: state?.sessions ?? [],
            forwards: state?.forwards ?? [],
          };
        }),
      });
    },
  });

  const usage = webServer.register({
    kind: "exact",
    path: "/api/hpc/usage",
    handler: async (req, res) => {
      if (!allowed(req)) return json(res, 403, { error: "forbidden" });
      const url = new URL(req.url ?? "/", "http://local");
      const serverId = url.searchParams.get("server") ?? "";
      try {
        const server = findServer(getConfig(), serverId);
        // Reuse the pooled connection when the agent already authenticated: 2FA
        // servers cannot prompt for a code from the settings page. Otherwise own
        // a temporary connection and close it after sampling.
        const started = Date.now();
        const pooled = pool.get(server.id);
        const own = pooled
          ? null
          : await connect(ctxForApi, server, {
              connectTimeoutMs: 15_000,
              keepaliveIntervalMs: 0,
              expectedFingerprint: server.hostKey ?? null,
            });
        const client = pooled ? pooled.client : own!.client;
        try {
          const result = await execRemote(client, buildScript(), { timeoutMs: 30_000 });
          const raw = result.stdout;
          const nproc = Number(section(raw, "NPROC")) || 1;
          const login = {
            cpu: parseCpu(`${section(raw, "LOGINLOAD")}\n${section(raw, "LOGINCPU")}`, nproc),
            memory: parseMemory(section(raw, "LOGINMEM")),
          };
          const modeRaw = section(raw, "MODE");
          const mode = modeRaw === "slurm" || server.kind === "slurm" ? "slurm" : modeRaw === "queue" ? "queue" : "bare";
          const base = { server: server.id, sampledAt: new Date().toISOString(), elapsedMs: Date.now() - started, mode, login };

          if (server.kind === "auto" || !server.kind) {
            const detected = mode === "slurm" ? "slurm" : mode === "queue" ? (section(raw, "QUEUESYS") === "lsf" ? "lsf" : "pbs") : "bare";
            const persisted = await persistResolvedKind(server.id, detected, getConfig());
            if (persisted) base.mode = detected;
          }

          if (mode === "queue") {
            json(res, 200, {
              ...base,
              kind: "queue",
              queueSystem: section(raw, "QUEUESYS") || "pbs",
              cpu: login.cpu,
              memory: login.memory,
              note: "该服务器使用 PBS/LSF 队列系统，当前仅提供登录节点资源；集群视图与作业工具暂未支持。",
            });
            return;
          }

          if (mode === "slurm") {
            const nodes = parseNodes(section(raw, "NODES"));
            const partitions = parsePartitions(section(raw, "SINFO"));
            json(res, 200, {
              ...base,
              kind: "slurm",
              cluster: {
                nodes,
                cpus: {
                  total: nodes.cpus.total,
                  allocated: nodes.cpus.allocated,
                  percent: percentOf(nodes.cpus.allocated, nodes.cpus.total),
                },
                memoryMb: {
                  total: nodes.memoryMb.total,
                  allocated: nodes.memoryMb.allocated,
                  freeMb: nodes.memoryMb.freeMb,
                  percent: nodes.memoryMb.total > 0 ? percentOf(nodes.memoryMb.allocated, nodes.memoryMb.total) : 0,
                },
                gpus: {
                  total: nodes.gpus.total,
                  used: nodes.gpus.used,
                  percent: percentOf(nodes.gpus.used, nodes.gpus.total),
                },
                partitions: partitions.map(({ memoryMb: _memory, ...rest }) => rest),
                jobs: parseQueue(section(raw, "QUEUE")),
              },
            });
            return;
          }

          json(res, 200, {
            ...base,
            kind: "bare",
            cpu: parseCpu(`${section(raw, "LOAD")}\n${section(raw, "CPU")}`, nproc),
            memory: parseMemory(section(raw, "MEMINFO")) ?? parseMemory(section(raw, "MEM")),
            gpus: parseGpus(section(raw, "GPU")),
            disks: parseDisks(section(raw, "DISK")),
            jobs: Number(section(raw, "JOBS").trim()) || 0,
          });
        } finally {
          if (own) {
            try {
              own.client.end();
            } catch {
              /* already closed */
            }
          }
        }
      } catch (error) {
        json(res, 502, { error: error instanceof HpcError ? twoFactorMessage(error.message) : String(error) });
      }
    },
  });

  const detect = webServer.register({
    kind: "exact",
    path: "/api/hpc/detect",
    handler: async (req, res) => {
      if (!allowed(req)) return json(res, 403, { error: "forbidden" });
      const url = new URL(req.url ?? "/", "http://local");
      const serverId = url.searchParams.get("server") ?? "";
      try {
        const config = getConfig();
        const server = findServer(config, serverId);
        if (server.kind && server.kind !== "auto") {
          json(res, 200, { server: server.id, kind: server.kind, pinned: true, persisted: false });
          return;
        }
        const pooled = pool.get(server.id);
        const own = pooled
          ? null
          : await connect(ctxForApi, server, {
              connectTimeoutMs: 15_000,
              keepaliveIntervalMs: 0,
              expectedFingerprint: server.hostKey ?? null,
            });
        const client = pooled ? pooled.client : own!.client;
        try {
          const result = await execRemote(client, DETECT_SCRIPT, { timeoutMs: 20_000 });
          const kind = (["slurm", "pbs", "lsf", "bare"].includes(result.stdout.trim()) ? result.stdout.trim() : "bare") as
            | "bare"
            | "slurm"
            | "pbs"
            | "lsf";
          const persisted = await persistResolvedKind(server.id, kind, config);
          json(res, 200, { server: server.id, kind, pinned: false, persisted });
        } finally {
          if (own) {
            try {
              own.client.end();
            } catch {
              /* already closed */
            }
          }
        }
      } catch (error) {
        json(res, 502, { error: error instanceof HpcError ? twoFactorMessage(error.message) : String(error) });
      }
    },
  });

  const configState = webServer.register({
    kind: "exact",
    path: "/api/hpc/config-state",
    handler: async (req, res) => {
      if (!allowed(req)) return json(res, 403, { error: "forbidden" });
      const settings = ctxForApi?.get("settings") as SettingsLike | undefined;
      if (!settings) return json(res, 200, { writable: false, error: "the settings service is not mounted" });
      try {
        const own = settings.describe().find((entry) => entry.ns === "hpc");
        // A no-op merge proves whether the settings service will accept writes for this entry.
        await settings.update("hpc", {}, own?.revision);
        return json(res, 200, { writable: true });
      } catch (error) {
        return json(res, 200, { writable: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  });

  return [status, usage, detect, configState];
}
