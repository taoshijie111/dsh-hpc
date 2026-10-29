import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import type { ConnectionPool } from "./core/pool.js";
import { downloadWithResume, uploadWithResume } from "./core/transfer.js";
import type { SessionRegistry } from "./core/session.js";
import { execRemote, passwordRefFor } from "./core/ssh.js";
import { MultiserversError, PLUGIN_ID, findServer, type Config, type ServerSpec } from "./core/types.js";

const text = (value: unknown) => [{ type: "text" as const, text: JSON.stringify(value, null, 2) }];
const objectOutput = {
  schema: { type: "object", additionalProperties: true } as const,
  render: (_args: unknown, value: unknown) => text(value),
};

type SettingsLike = {
  describe(): Array<{ ns: string; revision: number; value?: unknown }>;
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>;
};

export async function writeServers(ctx: Context, servers: ServerSpec[]): Promise<void> {
  const settings = ctx.get("settings") as SettingsLike | undefined;
  if (!settings) {
    throw new MultiserversError(
      "The Settings service is not mounted; add servers by editing this plugin's config in the profile cordis.patch.yml.",
    );
  }
  const own = settings.describe().find((entry) => entry.ns === PLUGIN_ID);
  await settings.update(PLUGIN_ID, { servers }, own?.revision);
}

/** Store a password in the DSH credential store (the same store provider API keys use). */
export async function storePassword(ctx: Context, serverId: string, password: string): Promise<string> {
  const refName = passwordRefFor(serverId);
  await ctx.credentials.set(credentialRef(refName), password);
  return refName;
}

function serverSummary(config: Config) {
  return config.servers.map((server) => ({
    id: server.id,
    label: server.label ?? server.id,
    host: server.host,
    port: server.port ?? 22,
    username: server.username,
    auth: server.auth,
    passwordRef: server.auth === "password" ? (server.passwordRef ?? passwordRefFor(server.id)) : null,
    keyPath: server.keyPath ?? null,
    hostKeyPinned: Boolean(server.hostKey),
  }));
}

const CAPABILITY_COMMAND = [
  "printf 'platform=%s\\n' \"$(uname -srm)\"",
  "printf 'hostname=%s\\n' \"$(hostname)\"",
  "printf 'user=%s\\n' \"$(id -un)\"",
  "printf 'home=%s\\n' \"$HOME\"",
  "printf 'shell=%s\\n' \"$SHELL\"",
  "for c in sbatch squeue sacct scancel sinfo scontrol qsub qstat bsub tmux rsync python3 conda module docker singularity apptainer; do printf 'tool_%s=%s\\n' \"$c\" \"$(command -v \"$c\" 2>/dev/null || echo MISSING)\"; done",
  "df -h 2>/dev/null | head -12",
].join("; ");

export function registerTools(
  ctx: Context,
  getConfig: () => Config,
  pool: ConnectionPool,
  sessions: SessionRegistry,
): Array<() => void> {
  const disposers: Array<() => void> = [];
  const register = (definition: unknown) => {
    disposers.push(ctx.tools.register(definition as never));
  };
  const commandTimeout = () => getConfig().commandTimeoutMs ?? 120_000;
  const sessionName = (value?: string) => value?.trim() || "main";

  register(
    defineTool({
      name: "server_list",
      description:
        "List the remote servers configured for this workspace, with address, user, authentication mode and whether a host key is pinned. Start here when a task mentions a server.",
      parameters: {},
      output: objectOutput,
      async execute() {
        return { servers: serverSummary(getConfig()) };
      },
    }),
  );

  register(
    defineTool({
      name: "server_test",
      description:
        "Check that a configured server can be reached: connects (or reuses the existing connection), reports login latency, the observed host key fingerprint and whether it matches the pinned one. Read-only. Pass pin=true to store the observed fingerprint when none is pinned yet.",
      parameters: {
        server: { type: "string", required: true, description: "Server id from server_list." },
        pin: { type: "boolean", description: "Store the observed host key fingerprint when none is pinned." },
      },
      output: objectOutput,
      async execute(args) {
        const config = getConfig();
        const server = findServer(config, args.server);
        if (server.hostKey && args.pin) {
          throw new MultiserversError(
            `Server "${server.id}" already pins a host key; clear it explicitly before re-pinning.`,
          );
        }
        const started = Date.now();
        const state = await pool.ensure(ctx, server);
        let pinned = Boolean(server.hostKey);
        if (args.pin && !server.hostKey) {
          const next = config.servers.map((entry) =>
            entry.id === server.id ? { ...entry, hostKey: state.fingerprint } : entry,
          );
          await writeServers(ctx, next);
          pinned = true;
        }
        return {
          server: server.id,
          reachable: state.alive,
          latencyMs: Date.now() - started,
          hostKeyFingerprint: state.fingerprint,
          hostKeyPinned: pinned,
          hostKeyMatches: !server.hostKey || server.hostKey === state.fingerprint,
        };
      },
    }),
  );

  register(
    defineTool({
      name: "server_probe",
      description:
        "Read-only capability profile of a server: OS, hostname, login user/home/shell, whether Slurm/PBS/LSF clients, tmux, rsync, python, conda, module, docker or singularity exist, and mounted storage. Use it before deciding how to run work or where data can live.",
      parameters: {
        server: { type: "string", required: true, description: "Server id from server_list." },
      },
      output: objectOutput,
      async execute(args, exec) {
        const config = getConfig();
        const server = findServer(config, args.server);
        const state = await pool.ensure(ctx, server);
        const result = await execRemote(state.client, CAPABILITY_COMMAND, {
          timeoutMs: 30_000,
          signal: exec.signal,
        });
        const fields: Record<string, string> = {};
        for (const line of result.stdout.split("\n")) {
          const index = line.indexOf("=");
          if (index > 0) fields[line.slice(0, index).trim()] = line.slice(index + 1);
        }
        return {
          server: server.id,
          platform: fields.platform ?? null,
          hostname: fields.hostname ?? null,
          user: fields.user ?? null,
          home: fields.home ?? null,
          shell: fields.shell ?? null,
          schedulers: ["sbatch", "qsub", "bsub"].filter(
            (name) => fields[`tool_${name}`] && fields[`tool_${name}`] !== "MISSING",
          ),
          tools: Object.fromEntries(
            ["tmux", "rsync", "python3", "conda", "module", "docker", "singularity", "apptainer"].map((toolName) => {
              const found = fields[`tool_${toolName}`];
              return [toolName, found && found !== "MISSING" ? found : null];
            }),
          ),
          storage: result.stdout
            .split("\n")
            .filter((line) => /^\S+\s+\d+[KMGTP]?\s+\d+/.test(line))
            .slice(0, 12),
        };
      },
    }),
  );

  register(
    defineTool({
      name: "server_connect",
      description:
        "Log in to a configured server now (or reuse the existing connection) so later commands do not pay connection latency. Returns the connection summary. server_test keeps the connection open as well.",
      parameters: {
        server: { type: "string", required: true, description: "Server id from server_list." },
      },
      output: objectOutput,
      async execute(args) {
        const server = findServer(getConfig(), args.server);
        const started = Date.now();
        const state = await pool.ensure(ctx, server);
        return {
          server: server.id,
          connected: state.alive,
          latencyMs: Date.now() - started,
          hostKeyFingerprint: state.fingerprint,
          connectedAt: new Date(state.connectedAt).toISOString(),
        };
      },
    }),
  );

  register(
    defineTool({
      name: "server_disconnect",
      description:
        "Log out of a server: closes every shell session and the SSH connection. Remote processes started outside the sessions keep running.",
      parameters: {
        server: { type: "string", required: true, description: "Server id from server_list." },
      },
      output: objectOutput,
      async execute(args) {
        const server = findServer(getConfig(), args.server);
        await sessions.closeForServer(server.id);
        await pool.close(server.id);
        return { server: server.id, disconnected: true };
      },
    }),
  );

  register(
    defineTool({
      name: "server_status",
      description:
        "Show connection state: which servers are logged in, when they connected, idle time, and which named shell sessions exist.",
      parameters: {},
      output: objectOutput,
      async execute() {
        return { connections: pool.list(), sessions: sessions.list() };
      },
    }),
  );

  register(
    defineTool({
      name: "shell_open",
      description:
        "Open (or reuse) a named shell session on a server. Each session keeps its own working directory and environment, and runs commands one at a time. Pass a name to keep independent sessions (for example 'build' and 'logs'). Omitting the name uses 'main'.",
      parameters: {
        server: { type: "string", required: true, description: "Server id from server_list." },
        name: { type: "string", description: "Session name; defaults to 'main'." },
      },
      output: objectOutput,
      async execute(args) {
        const config = getConfig();
        const server = findServer(config, args.server);
        const session = await sessions.open(ctx, config, server, sessionName(args.name));
        return { server: server.id, session: session.name, alive: session.alive };
      },
    }),
  );

  register(
    defineTool({
      name: "shell_run",
      description:
        "Run a shell command inside a named session and return exit code, stdout and stderr. The session is a real login shell, so cd/exports/module loads persist for later calls in that session; commands in one session run serially. Default timeout comes from settings; a timeout restarts only that session (cwd/env are lost and stateReset is reported). Do not start interactive programs or long compute jobs here — use nohup/tmux or the scheduler.",
      parameters: {
        server: { type: "string", required: true, description: "Server id from server_list." },
        command: { type: "string", required: true, description: "Shell command to run." },
        session: { type: "string", description: "Session name; defaults to 'main'." },
        timeoutMs: { type: "number", description: "Timeout in milliseconds; defaults to the plugin's commandTimeoutMs." },
      },
      output: objectOutput,
      async execute(args, exec) {
        const config = getConfig();
        const result = await sessions.run(ctx, config, args.server, args.command, {
          session: sessionName(args.session),
          timeoutMs: args.timeoutMs ?? commandTimeout(),
          signal: exec.signal,
        });
        return { server: args.server, session: sessionName(args.session), ...result };
      },
    }),
  );

  register(
    defineTool({
      name: "shell_close",
      description:
        "Close one named shell session. The SSH connection stays open until idle timeout or server_disconnect.",
      parameters: {
        server: { type: "string", required: true, description: "Server id from server_list." },
        session: { type: "string", description: "Session name; defaults to 'main'." },
      },
      output: objectOutput,
      async execute(args) {
        const closed = await sessions.close(args.server, sessionName(args.session));
        return { server: args.server, session: sessionName(args.session), closed };
      },
    }),
  );

  register(
    defineTool({
      name: "session_list",
      description: "List shell sessions across servers with their liveness and last activity time.",
      parameters: {},
      output: objectOutput,
      async execute() {
        return { sessions: sessions.list() };
      },
    }),
  );

  register(
    defineTool({
      name: "upload",
      description:
        "Upload one local file to the server over SFTP. If a smaller file already exists there it resumes from that offset; an existing file with different content is refused unless overwrite=true. Verifies sha256 when the host has sha256sum. Transfer code, configs and small inputs; large datasets should already live on the server.",
      parameters: {
        server: { type: "string", required: true, description: "Server id from server_list." },
        localPath: { type: "string", required: true, description: "Absolute local path." },
        remotePath: { type: "string", required: true, description: "Absolute remote destination path." },
        overwrite: { type: "boolean", description: "Replace an existing file with different content." },
      },
      output: objectOutput,
      async execute(args) {
        const server = findServer(getConfig(), args.server);
        const state = await pool.ensure(ctx, server);
        const result = await uploadWithResume(state.client, args.localPath, args.remotePath, {
          overwrite: Boolean(args.overwrite),
        });
        return { server: server.id, ...result };
      },
    }),
  );

  register(
    defineTool({
      name: "download",
      description:
        "Download one remote file over SFTP. If a smaller local file exists it resumes from that offset; an existing local file with different content is refused unless overwrite=true. Verifies sha256 when available. Use for results and small artifacts; leave large datasets on the server.",
      parameters: {
        server: { type: "string", required: true, description: "Server id from server_list." },
        remotePath: { type: "string", required: true, description: "Absolute remote path." },
        localPath: { type: "string", required: true, description: "Absolute local destination path." },
        overwrite: { type: "boolean", description: "Replace an existing local file with different content." },
      },
      output: objectOutput,
      async execute(args) {
        const server = findServer(getConfig(), args.server);
        const state = await pool.ensure(ctx, server);
        const result = await downloadWithResume(state.client, args.remotePath, args.localPath, {
          overwrite: Boolean(args.overwrite),
        });
        return { server: server.id, ...result };
      },
    }),
  );

  register(
    defineTool({
      name: "server_add",
      description:
        "Register a remote server. The password, when provided, is stored in the DSH credential store, never in plugin configuration. Requires the Settings service. Validate with server_test afterwards.",
      parameters: {
        id: { type: "string", required: true, description: "Stable id, lowercase letters/digits/dashes." },
        host: { type: "string", required: true, description: "Hostname or IP address." },
        username: { type: "string", required: true, description: "Login user." },
        port: { type: "number", description: "SSH port; defaults to 22." },
        label: { type: "string", description: "Human-readable label." },
        auth: { type: "string", enum: ["password", "key"], description: "Authentication mode; defaults to password." },
        password: { type: "string", description: "Password to store in the credential store (password auth)." },
        keyPath: { type: "string", description: "Absolute local private key path (key auth)." },
        hostKey: { type: "string", description: "Pinned host key fingerprint, e.g. SHA256:...; omit to pin on first server_test." },
      },
      output: objectOutput,
      async execute(args) {
        const config = getConfig();
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(args.id)) {
          throw new MultiserversError("id must match ^[a-z0-9][a-z0-9-]{0,63}$");
        }
        if (config.servers.some((entry) => entry.id === args.id)) {
          throw new MultiserversError(`Server "${args.id}" already exists`);
        }
        const auth = (args.auth ?? "password") as "password" | "key";
        if (auth === "password" && !args.password) throw new MultiserversError("password auth requires a password");
        if (auth === "key" && !args.keyPath) throw new MultiserversError("key auth requires keyPath");
        let passwordRef: string | undefined;
        if (auth === "password" && args.password) passwordRef = await storePassword(ctx, args.id, args.password);
        const server: ServerSpec = {
          id: args.id,
          host: args.host,
          username: args.username,
          auth,
          ...(args.port !== undefined ? { port: args.port } : {}),
          ...(args.label ? { label: args.label } : {}),
          ...(passwordRef ? { passwordRef } : {}),
          ...(args.keyPath ? { keyPath: args.keyPath } : {}),
          ...(args.hostKey ? { hostKey: args.hostKey } : {}),
        };
        const next = [...config.servers, server];
        await writeServers(ctx, next);
        return { added: serverSummary({ ...config, servers: [server] }), total: next.length };
      },
    }),
  );

  register(
    defineTool({
      name: "server_remove",
      description:
        "Remove a configured server and close its connection and sessions. By default the stored password credential is removed too. Does not touch anything on the remote host.",
      parameters: {
        server: { type: "string", required: true, description: "Server id from server_list." },
        forgetPassword: { type: "boolean", description: "Also remove the stored password credential; defaults to true." },
      },
      output: objectOutput,
      async execute(args) {
        const config = getConfig();
        const server = findServer(config, args.server);
        await sessions.closeForServer(server.id);
        await pool.close(server.id);
        const next = config.servers.filter((entry) => entry.id !== server.id);
        await writeServers(ctx, next);
        if (server.auth === "password" && args.forgetPassword !== false) {
          const refName = server.passwordRef ?? passwordRefFor(server.id);
          await ctx.credentials.unset(credentialRef(refName)).catch(() => undefined);
        }
        return { removed: server.id, remaining: next.length };
      },
    }),
  );

  return disposers;
}
