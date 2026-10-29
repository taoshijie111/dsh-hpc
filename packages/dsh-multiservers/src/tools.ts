import { createServer, type Server as NetServer } from "node:net";
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
const DEFAULT_MAX_BYTES = 256 * 1024;

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

const CAPABILITY_COMMAND = [
  "printf 'platform=%s\\n' \"$(uname -srm)\"",
  "printf 'hostname=%s\\n' \"$(hostname)\"",
  "printf 'user=%s\\n' \"$(id -un)\"",
  "printf 'home=%s\\n' \"$HOME\"",
  "printf 'shell=%s\\n' \"$SHELL\"",
  "for c in sbatch squeue sacct scancel sinfo scontrol qsub qstat bsub tmux rsync python3 conda module docker singularity apptainer; do printf 'tool_%s=%s\\n' \"$c\" \"$(command -v \"$c\" 2>/dev/null || echo MISSING)\"; done",
  "df -h 2>/dev/null | head -12",
].join("; ");

function serverConfigSummary(server: ServerSpec) {
  return {
    id: server.id,
    label: server.label ?? server.id,
    host: server.host,
    port: server.port ?? 22,
    username: server.username,
    auth: server.auth,
    keyPath: server.keyPath ?? null,
    hostKeyPinned: Boolean(server.hostKey),
  };
}

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
        "List configured servers together with their live state: address, user, authentication, host-key pin, whether the connection is open, its idle time, which named shell sessions exist and which local ports are forwarded. Start here when a task mentions a server.",
      parameters: {},
      output: objectOutput,
      async execute() {
        const config = getConfig();
        const live = new Map(pool.list().map((entry) => [entry.serverId, entry]));
        return {
          servers: config.servers.map((server) => {
            const state = live.get(server.id);
            return {
              ...serverConfigSummary(server),
              connected: Boolean(state),
              connectedAt: state?.connectedAt ?? null,
              idleSinceMs: state?.idleSinceMs ?? null,
              sessions: state?.sessions ?? [],
              forwards: state?.forwards ?? [],
            };
          }),
        };
      },
    }),
  );

  register(
    defineTool({
      name: "server_add",
      description:
        "Register or update a remote server. Authentication secrets are never accepted here: password-auth servers get their password in DSH Settings → 服务器, and key-auth servers may reference a local key path plus an optional passphrase credential. Requires the Settings service.",
      parameters: {
        id: { type: "string", required: true, description: "Stable id, lowercase letters/digits/dashes." },
        host: { type: "string", required: true, description: "Hostname or IP address." },
        username: { type: "string", required: true, description: "Login user." },
        port: { type: "number", description: "SSH port; defaults to 22." },
        label: { type: "string", description: "Human-readable label." },
        auth: { type: "string", enum: ["password", "key"], description: "Authentication mode; defaults to password." },
        keyPath: { type: "string", description: "Absolute local private key path (key auth)." },
        keyPassphraseRef: {
          type: "string",
          description: "Credential reference holding the key passphrase (key auth).",
        },
        hostKey: { type: "string", description: "Pinned host key fingerprint, e.g. SHA256:..." },
      },
      output: objectOutput,
      async execute(args) {
        const config = getConfig();
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(args.id)) {
          throw new MultiserversError("id must match ^[a-z0-9][a-z0-9-]{0,63}$");
        }
        const auth = (args.auth ?? "password") as "password" | "key";
        if (auth === "key" && !args.keyPath) throw new MultiserversError("key auth requires keyPath");
        const existing = config.servers.find((entry) => entry.id === args.id);
        const server: ServerSpec = {
          ...(existing ?? {}),
          id: args.id,
          host: args.host,
          username: args.username,
          auth,
          ...(args.port !== undefined ? { port: args.port } : {}),
          ...(args.label !== undefined ? { label: args.label } : {}),
          ...(args.keyPath ? { keyPath: args.keyPath } : {}),
          ...(args.keyPassphraseRef ? { keyPassphraseRef: args.keyPassphraseRef } : {}),
          ...(args.hostKey ? { hostKey: args.hostKey } : {}),
        };
        const next = existing
          ? config.servers.map((entry) => (entry.id === args.id ? server : entry))
          : [...config.servers, server];
        await writeServers(ctx, next);
        return {
          saved: serverConfigSummary(server),
          created: !existing,
          total: next.length,
          note: auth === "password" ? "设置 password 请到 DSH Settings → 服务器" : null,
        };
      },
    }),
  );

  register(
    defineTool({
      name: "server_remove",
      description:
        "Remove a configured server and close its connection, sessions and forwards. By default the stored password credential is removed too. Does not touch the remote host.",
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
          await ctx.credentials.unset(credentialRef(server.passwordRef ?? passwordRefFor(server.id))).catch(() => undefined);
        }
        return { removed: server.id, remaining: next.length };
      },
    }),
  );

  register(
    defineTool({
      name: "server_test",
      description:
        "Connect to (or reuse) a server and report reachability, login latency, the observed host key fingerprint and whether it matches the pinned one. Pass profile=true to also collect the capability profile (OS, schedulers, rsync, tmux, storage). Never pins a key: approve the fingerprint in DSH Settings → 服务器.",
      parameters: {
        server: { type: "string", required: true, description: "Server id from server_list." },
        profile: { type: "boolean", description: "Also collect the capability profile." },
      },
      output: objectOutput,
      async execute(args, exec) {
        const config = getConfig();
        const server = findServer(config, args.server);
        const started = Date.now();
        const state = await pool.ensure(ctx, server);
        const result: Record<string, any> = {
          server: server.id,
          reachable: state.alive,
          latencyMs: Date.now() - started,
          hostKeyFingerprint: state.fingerprint,
          hostKeyPinned: Boolean(server.hostKey),
          hostKeyMatches: !server.hostKey || server.hostKey === state.fingerprint,
        };
        if (args.profile) {
          const probe = await execRemote(state.client, CAPABILITY_COMMAND, { timeoutMs: 30_000, signal: exec.signal });
          const fields: Record<string, string> = {};
          for (const line of probe.stdout.split("\n")) {
            const index = line.indexOf("=");
            if (index > 0) fields[line.slice(0, index).trim()] = line.slice(index + 1);
          }
          result.profile = {
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
            storage: probe.stdout.split("\n").filter((line) => /^\S+\s+\d+[KMGTP]?\s+\d+/.test(line)).slice(0, 12),
          };
        }
        return result;
      },
    }),
  );

  register(
    defineTool({
      name: "server_disconnect",
      description:
        "Log out of a server: close its shell sessions, forwarded ports and the SSH connection. Remote processes started outside sessions keep running.",
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
      name: "shell_run",
      description:
        "Run a shell command in a named sticky session (created on demand). The session is a real login shell, so cd/exports/module loads persist for later calls; commands in one session run serially. Output is capped at maxBytes and marked truncated. A timeout restarts only that session and reports stateReset. Do not run interactive programs or long compute jobs here — use nohup/tmux or the scheduler.",
      parameters: {
        server: { type: "string", required: true, description: "Server id from server_list." },
        command: { type: "string", required: true, description: "Shell command to run." },
        session: { type: "string", description: "Session name; defaults to 'main'." },
        timeoutMs: { type: "number", description: "Timeout in milliseconds; defaults to the plugin's commandTimeoutMs." },
        maxBytes: { type: "number", description: "Maximum captured output bytes; defaults to 256 KiB." },
      },
      output: objectOutput,
      async execute(args, exec) {
        const config = getConfig();
        const limit = args.maxBytes ?? DEFAULT_MAX_BYTES;
        const result = await sessions.run(ctx, config, args.server, args.command, {
          session: sessionName(args.session),
          timeoutMs: args.timeoutMs ?? commandTimeout(),
          signal: exec.signal,
        });
        const cap = (value: string) => (value.length > limit ? `${value.slice(0, limit)}\n[truncated]` : value);
        return {
          server: args.server,
          session: sessionName(args.session),
          ...result,
          stdout: cap(result.stdout),
          stderr: cap(result.stderr),
          truncated: result.stdout.length > limit || result.stderr.length > limit,
        };
      },
    }),
  );

  register(
    defineTool({
      name: "shell_close",
      description: "Close one named shell session. The SSH connection stays open for other sessions, transfers and forwards.",
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
      name: "upload",
      description:
        "Upload a local file or directory to the server. Directories are copied file-by-file. Each file stages as <target>.part and is renamed after sha256 verification; an existing smaller partial resumes from its size; different existing content is refused unless overwrite=true. Large datasets should already live on the server.",
      parameters: {
        server: { type: "string", required: true, description: "Server id from server_list." },
        localPath: { type: "string", required: true, description: "Absolute local file or directory path." },
        remotePath: { type: "string", required: true, description: "Absolute remote destination path." },
        overwrite: { type: "boolean", description: "Replace existing files with different content." },
      },
      output: objectOutput,
      async execute(args, exec) {
        const server = findServer(getConfig(), args.server);
        const state = await pool.ensure(ctx, server);
        const result = await uploadWithResume(state.client, args.localPath, args.remotePath, {
          overwrite: Boolean(args.overwrite),
          signal: exec.signal,
        });
        return { server: server.id, ...result };
      },
    }),
  );

  register(
    defineTool({
      name: "download",
      description:
        "Download a remote file or directory. Directories are copied file-by-file. Each file stages locally as <target>.part and is renamed after sha256 verification; a smaller local partial resumes; different existing content is refused unless overwrite=true. Use for results and small artifacts; leave large datasets on the server.",
      parameters: {
        server: { type: "string", required: true, description: "Server id from server_list." },
        remotePath: { type: "string", required: true, description: "Absolute remote file or directory path." },
        localPath: { type: "string", required: true, description: "Absolute local destination path." },
        overwrite: { type: "boolean", description: "Replace existing local files with different content." },
      },
      output: objectOutput,
      async execute(args, exec) {
        const server = findServer(getConfig(), args.server);
        const state = await pool.ensure(ctx, server);
        const result = await downloadWithResume(state.client, args.remotePath, args.localPath, {
          overwrite: Boolean(args.overwrite),
          signal: exec.signal,
        });
        return { server: server.id, ...result };
      },
    }),
  );

  register(
    defineTool({
      name: "forward",
      description:
        "Forward a local TCP port to a host reachable from the server (for example a Jupyter or TensorBoard port on a compute node). Opens a listener on 127.0.0.1 and tunnels through the pooled SSH connection. Pass close=true with localPort to stop an earlier forward. Forwards also close on server_disconnect and plugin unload.",
      parameters: {
        server: { type: "string", required: true, description: "Server id from server_list." },
        remoteHost: { type: "string", description: "Target host as seen from the server; defaults to 127.0.0.1." },
        remotePort: { type: "number", description: "Target port on the remote side." },
        localPort: { type: "number", description: "Local port to listen on; 0 or omitted picks a free one." },
        close: { type: "boolean", description: "Close the forward identified by localPort instead of opening one." },
      },
      output: objectOutput,
      async execute(args) {
        const server = findServer(getConfig(), args.server);
        const state = await pool.ensure(ctx, server);
        if (args.close) {
          if (!args.localPort) throw new MultiserversError("close requires localPort");
          return {
            server: server.id,
            localPort: args.localPort,
            remoteHost: null,
            remotePort: null,
            closed: pool.closeForward(state, args.localPort),
          };
        }
        if (!args.remotePort) throw new MultiserversError("remotePort is required");
        const remoteHost = args.remoteHost ?? "127.0.0.1";
        const localServer = createServer((socket) => {
          state.client.forwardOut("127.0.0.1", socket.remotePort ?? 0, remoteHost, args.remotePort!, (error, stream) => {
            if (error) {
              socket.destroy();
              return;
            }
            socket.pipe(stream).pipe(socket);
            socket.on("error", () => stream.destroy());
            stream.on("error", () => socket.destroy());
            socket.on("close", () => stream.destroy());
            stream.on("close", () => socket.destroy());
          });
        });
        const localPort = await new Promise<number>((resolve, reject) => {
          localServer.once("error", reject);
          localServer.listen(args.localPort ?? 0, "127.0.0.1", () => {
            const address = localServer.address();
            if (!address || typeof address === "string") return reject(new Error("no local port"));
            resolve(address.port);
          });
        });
        pool.addForward(state, { localPort, remoteHost, remotePort: args.remotePort, server: localServer });
        return { server: server.id, localPort, remoteHost, remotePort: args.remotePort, closed: false };
      },
    }),
  );

  return disposers;
}
