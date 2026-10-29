import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type { ConnectionPool } from "./core/pool.js";
import type { SessionRegistry } from "./core/session.js";
import { connect, execRemote } from "./core/ssh.js";
import { findServer, MultiserversError, type Config } from "./core/types.js";

const SAMPLE_SCRIPT = [
  "echo __LOAD__; uptime",
  "echo __NPROC__; nproc 2>/dev/null || echo 1",
  "echo __CPU__; top -bn1 2>/dev/null | grep -m1 'Cpu(s)' || echo unknown",
  "echo __MEM__; free -m 2>/dev/null | grep -m1 'Mem:' || echo unknown",
  "echo __MEMINFO__; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo 2>/dev/null || true",
  "echo __GPU__; nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null || echo none",
  "echo __DISK__; df -P -h -x tmpfs -x devtmpfs 2>/dev/null | tail -n +2 | head -8",
  "echo __JOBS__; squeue -u $USER -h 2>/dev/null | wc -l || echo 0",
].join("; ");

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
  return req.method === "GET" && req.headers["x-multiservers-request"] === "1";
}

function section(raw: string, name: string): string {
  const start = raw.indexOf(`__${name}__`);
  if (start < 0) return "";
  const rest = raw.slice(start + name.length + 4);
  const end = rest.search(/\n__[A-Z]+__/);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

function parseCpu(raw: string, nproc: number): { usagePercent: number | null; cores: number; load: number[] } {
  const loadMatch = /load average:\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(raw);
  const load = loadMatch ? [Number(loadMatch[1]), Number(loadMatch[2]), Number(loadMatch[3])] : [];
  const idleMatch = /([\d.]+)\s*id/.exec(raw);
  const usagePercent = idleMatch ? Math.max(0, Math.min(100, Math.round((100 - Number(idleMatch[1])) * 10) / 10)) : null;
  return { usagePercent, cores: nproc, load };
}

function parseMemory(raw: string, meminfo: string): { totalMb: number; usedMb: number; availableMb: number; percent: number } | null {
  const parts = raw.split(/\s+/);
  if (parts.length >= 7) {
    const totalMb = Number(parts[1]);
    const usedMb = Number(parts[2]);
    const availableMb = Number(parts[6] ?? parts[3]);
    if (Number.isFinite(totalMb) && totalMb > 0) {
      return { totalMb, usedMb, availableMb, percent: Math.round((usedMb / totalMb) * 1000) / 10 };
    }
  }
  const totalKb = Number(/MemTotal:\s*(\d+)/.exec(meminfo)?.[1]);
  const availableKb = Number(/MemAvailable:\s*(\d+)/.exec(meminfo)?.[1]);
  if (!Number.isFinite(totalKb) || totalKb <= 0) return null;
  const totalMb = Math.round(totalKb / 1024);
  const availableMb = Number.isFinite(availableKb) ? Math.round(availableKb / 1024) : 0;
  const usedMb = Math.max(0, totalMb - availableMb);
  return { totalMb, usedMb, availableMb, percent: Math.round((usedMb / totalMb) * 1000) / 10 };
}

function parseGpus(raw: string): Array<{ index: number; name: string; utilPercent: number; memUsedMb: number; memTotalMb: number }> {
  if (!raw || raw === "none") return [];
  const gpus = [];
  for (const line of raw.split("\n")) {
    const cells = line.split(",").map((cell) => cell.trim());
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

/** Register the settings-page HTTP facade: status snapshot and on-demand resource sampling. */
export function registerApi(
  webServer: WebServer,
  getConfig: () => Config,
  pool: ConnectionPool,
  sessions: SessionRegistry,
): Array<() => void> {
  const status = webServer.register({
    kind: "exact",
    path: "/api/multiservers/status",
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
    path: "/api/multiservers/usage",
    handler: async (req, res) => {
      if (!allowed(req)) return json(res, 403, { error: "forbidden" });
      const url = new URL(req.url ?? "/", "http://local");
      const serverId = url.searchParams.get("server") ?? "";
      try {
        const server = findServer(getConfig(), serverId);
        // Manual sampling owns a dedicated connection: connect, sample, disconnect.
        const started = Date.now();
        const connection = await connect(ctxForApi, server, {
          connectTimeoutMs: 15_000,
          keepaliveIntervalMs: 0,
          expectedFingerprint: server.hostKey ?? null,
        });
        try {
          const result = await execRemote(connection.client, SAMPLE_SCRIPT, { timeoutMs: 25_000 });
          const nproc = Number(section(result.stdout, "NPROC")) || 1;
          const loadRaw = section(result.stdout, "LOAD");
          const cpu = parseCpu(`${loadRaw}\n${section(result.stdout, "CPU")}`, nproc);
          const memory = parseMemory(section(result.stdout, "MEM"), section(result.stdout, "MEMINFO"));
          const gpus = parseGpus(section(result.stdout, "GPU"));
          const disks = parseDisks(section(result.stdout, "DISK"));
          const jobsRaw = section(result.stdout, "JOBS");
          const jobs = Number(jobsRaw.trim()) || 0;
          json(res, 200, {
            server: server.id,
            sampledAt: new Date().toISOString(),
            elapsedMs: Date.now() - started,
            cpu,
            memory,
            gpus,
            disks,
            jobs,
          });
        } finally {
          try {
            connection.client.end();
          } catch {
            /* already closed */
          }
        }
      } catch (error) {
        json(res, 502, { error: error instanceof MultiserversError ? error.message : String(error) });
      }
    },
  });

  return [status, usage];
}
