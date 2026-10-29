import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-commands";
import type { ConnectionPool } from "./core/pool.js";
import type { SessionRegistry } from "./core/session.js";
import { execRemote } from "./core/ssh.js";
import { findServer, MultiserversError, type Config } from "./core/types.js";

type CommandResult = { kind: "success" | "error"; text: string };

const SAMPLE_SCRIPT = [
  "echo __LOAD__; uptime",
  "echo __MEM__; free -m | head -3",
  "echo __CPU__; top -bn1 | sed -n '1,5p'",
  "echo __GPU__; (nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader 2>/dev/null || rocm-smi --showuse 2>/dev/null || echo none)",
  "echo __DISK__; df -h -x tmpfs -x devtmpfs 2>/dev/null | head -6",
  "echo __JOBS__; (squeue -u $USER -h -o '%.10i %.9P %.20j %.8T %.10M' 2>/dev/null | head -8 || echo none)",
].join("; ");

function pad(value: string, width: number): string {
  // Rough visual width: CJK characters occupy two cells.
  let cells = 0;
  for (const char of value) cells += /[\u3000-\u9fff\uff00-\uffef]/.test(char) ? 2 : 1;
  return value + " ".repeat(Math.max(0, width - cells));
}

function formatIdle(ms: number | null): string {
  if (ms === null) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function formatServers(config: Config, pool: ConnectionPool, sessions: SessionRegistry): string {
  const live = new Map(pool.list().map((entry) => [entry.serverId, entry]));
  const lines = ["服务器\t状态\t会话\t转发"];
  for (const server of config.servers) {
    const state = live.get(server.id);
    const names = sessions
      .list()
      .filter((session) => session.server === server.id)
      .map((session) => session.name);
    lines.push(
      [
        server.label && server.label !== server.id ? `${server.id}（${server.label}）` : server.id,
        state ? `已连接 · 空闲 ${formatIdle(state.idleSinceMs)}` : "未连接",
        names.length > 0 ? names.join(",") : "—",
        state && state.forwards.length > 0 ? state.forwards.map((f) => `:${f.localPort}→${f.remoteHost}:${f.remotePort}`).join(",") : "—",
      ].join("\t"),
    );
  }
  lines.push("", "用 /server <id> 查看单台机器的 CPU / 内存 / GPU / 磁盘 / 作业。");
  return lines.join("\n");
}

function section(text: string, name: string): string {
  const start = text.indexOf(`__${name}__`);
  if (start < 0) return "";
  const rest = text.slice(start + name.length + 4);
  const end = rest.search(/\n__[A-Z]+__/);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

function formatUsage(serverId: string, raw: string): string {
  const load = section(raw, "LOAD");
  const mem = section(raw, "MEM");
  const cpu = section(raw, "CPU");
  const gpu = section(raw, "GPU");
  const disk = section(raw, "DISK");
  const jobs = section(raw, "JOBS");
  const blocks = [`服务器 ${serverId}`];
  if (load) blocks.push(`负载  ${load}`);
  if (mem) blocks.push(`内存\n${mem}`);
  if (cpu) blocks.push(`CPU\n${cpu}`);
  blocks.push(`GPU\n${gpu || "未检测到 GPU 工具（nvidia-smi / rocm-smi）"}`);
  if (disk) blocks.push(`磁盘\n${disk}`);
  blocks.push(`我的作业\n${jobs || "none"}`);
  return blocks.join("\n\n");
}

export function registerCommands(
  ctx: Context,
  getConfig: () => Config,
  pool: ConnectionPool,
  sessions: SessionRegistry,
): Array<() => void> {
  const disposers: Array<() => void> = [];
  disposers.push(ctx.commands.register({
      name: "servers",
      description: "查看已配置服务器的连接、会话与端口转发状态",
      handler: async (): Promise<CommandResult> => ({
        kind: "success",
        text: formatServers(getConfig(), pool, sessions),
      }),
    }),
    ctx.commands.register({
      name: "usage",
      description: "查看某台服务器的 CPU / 内存 / GPU / 磁盘 / 作业",
      input: { hint: "<server-id>" },
      handler: async ({ rawInput }): Promise<CommandResult> => {
        const serverId = (rawInput ?? "").trim().split(/\s+/)[0] ?? "";
        if (!serverId) return { kind: "error", text: "用法：/server <server-id>（可先用 /servers 查看列表）" };
        try {
          const config = getConfig();
          const server = findServer(config, serverId);
          const state = await pool.ensure(ctx, server);
          const sample = await execRemote(state.client, SAMPLE_SCRIPT, { timeoutMs: 20_000 });
          if (sample.code !== 0 && !sample.stdout.includes("__LOAD__")) {
            return { kind: "error", text: `采样失败：${sample.stderr.trim() || `exit ${sample.code}`}` };
          }
          return { kind: "success", text: formatUsage(server.id, sample.stdout) };
        } catch (error) {
          return { kind: "error", text: error instanceof MultiserversError ? error.message : String(error) };
        }
      },
    }));
  console.log(`[multiservers] slash commands registered: ${disposers.length}`);
  return disposers;
}

export { pad };
