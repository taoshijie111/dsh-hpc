import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type { ConnectionPool } from "./core/pool.js";
import type { SessionRegistry } from "./core/session.js";
import { execRemote } from "./core/ssh.js";
import { findServer, MultiserversError, type Config } from "./core/types.js";

const SAMPLE_SCRIPT = [
  "echo __LOAD__; uptime",
  "echo __MEM__; free -m | head -3",
  "echo __CPU__; top -bn1 | sed -n '1,5p'",
  "echo __GPU__; (nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader 2>/dev/null || rocm-smi --showuse 2>/dev/null || echo none)",
  "echo __DISK__; df -h -x tmpfs -x devtmpfs 2>/dev/null | head -6",
  "echo __JOBS__; (squeue -u $USER -h -o '%.10i %.9P %.20j %.8T %.10M' 2>/dev/null | head -8 || echo none)",
].join("; ");

type WebServer = { register(route: { kind: "exact"; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void };

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
  // Same-origin browser fetch from our settings page; blocks drive-by cross-site reads.
  return req.method === "GET" && req.headers["x-multiservers-request"] === "1";
}

function section(text: string, name: string): string {
  const start = text.indexOf(`__${name}__`);
  if (start < 0) return "";
  const rest = text.slice(start + name.length + 4);
  const end = rest.search(/\n__[A-Z]+__/);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

/** HTTP facade for the settings page: status snapshot and per-server resource sample. */
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
        const state = await pool.ensure(ctxForApi, server);
        const sample = await execRemote(state.client, SAMPLE_SCRIPT, { timeoutMs: 20_000 });
        json(res, 200, {
          server: server.id,
          sampledAt: new Date().toISOString(),
          load: section(sample.stdout, "LOAD"),
          memory: section(sample.stdout, "MEM"),
          cpu: section(sample.stdout, "CPU"),
          gpu: section(sample.stdout, "GPU"),
          disk: section(sample.stdout, "DISK"),
          jobs: section(sample.stdout, "JOBS"),
        });
      } catch (error) {
        json(res, 502, { error: error instanceof MultiserversError ? error.message : String(error) });
      }
    },
  });

  return [status, usage];
}

/** Set by the plugin entry before registering routes (avoids threading ctx through every route). */
export let ctxForApi: Context;

export function setApiContext(ctx: Context): void {
  ctxForApi = ctx;
}
