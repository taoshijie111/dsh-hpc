import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import {
  connect,
  downloadFile,
  execRemote,
  listDirectory,
  makeDirectory,
  passwordRefFor,
  removePath,
  resolvePassword,
  statPath,
  uploadFile,
} from "./core/ssh.js";
import {
  MultiserversError,
  PLUGIN_ID,
  findServer,
  shellQuote,
  type Config,
  type ServerSpec,
} from "./core/types.js";

const text = (value: unknown) => [{ type: "text" as const, text: JSON.stringify(value, null, 2) }];
const objectOutput = {
  schema: { type: "object", additionalProperties: true } as const,
  render: (_args: unknown, value: unknown) => text(value),
};

const CONNECT_TIMEOUT = (config: Config) => config.connectTimeoutMs ?? 15_000;
const COMMAND_TIMEOUT = (config: Config) => config.commandTimeoutMs ?? 120_000;

/** A settings service, when the composition mounts one. */
type SettingsLike = {
  describe(): Array<{ ns: string; revision: number }>;
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>;
};

async function writeServers(ctx: Context, servers: ServerSpec[]): Promise<void> {
  const settings = ctx.get("settings") as SettingsLike | undefined;
  if (!settings) {
    throw new MultiserversError(
      "The Settings service is not mounted; add servers by editing this plugin's config in the profile cordis.patch.yml.",
    );
  }
  const own = settings.describe().find((entry) => entry.ns === PLUGIN_ID);
  await settings.update(PLUGIN_ID, { servers }, own?.revision);
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

export function registerTools(ctx: Context, getConfig: () => Config): Array<() => void> {
  const disposers: Array<() => void> = [];
  const register = (definition: unknown) => {
    disposers.push(ctx.tools.register(definition as never));
  };

  register(
    defineTool({
      name: "server_list",
      description:
        "List the remote servers configured for this workspace, with host, port, user, authentication mode and whether a host key is pinned. Call this first when a task mentions a server.",
      parameters: {},
      output: objectOutput,
      async execute() {
        const config = getConfig();
        return { servers: serverSummary(config) };
      },
    }),
  );

  register(
    defineTool({
      name: "server_test",
      description:
        "Open an SSH connection to a configured server and report reachability, the observed host key fingerprint, whether it matches the pinned key, and the login latency. Read-only. Pass pin=true to store the observed fingerprint as the server's pinned key (only when no key is pinned yet).",
      parameters: {
        server: { type: "string", required: true, description: "Server id from server_list." },
        pin: { type: "boolean", description: "Store the observed host key fingerprint when none is pinned." },
      },
      output: objectOutput,
      async execute(args, exec) {
        const config = getConfig();
        const server = findServer(config, args.server);
        if (server.hostKey && args.pin) {
          throw new MultiserversError(`Server "${server.id}" already pins a host key; remove it explicitly before re-pinning.`);
        }
        const started = Date.now();
        const connection = await connect(ctx, server, {
          connectTimeoutMs: CONNECT_TIMEOUT(config),
          expectedFingerprint: server.hostKey ?? null,
        });
        try {
          const probe = await execRemote(connection, "printf 'ok'", {
            timeoutMs: 10_000,
            signal: exec.signal,
          });
          const matches = server.hostKey ? server.hostKey === connection.fingerprint : true;
          let pinned = Boolean(server.hostKey);
          if (args.pin && !server.hostKey) {
            const next = config.servers.map((entry) =>
              entry.id === server.id ? { ...entry, hostKey: connection.fingerprint } : entry,
            );
            await writeServers(ctx, next);
            pinned = true;
          }
          return {
            server: server.id,
            reachable: probe.code === 0,
            latencyMs: Date.now() - started,
            hostKeyFingerprint: connection.fingerprint,
            hostKeyPinned: pinned,
            hostKeyMatches: matches,
          };
        } finally {
          connection.close();
        }
      },
    }),
  );

  register(
    defineTool({
      name: "server_probe",
      description:
        "Collect a read-only capability profile of a server: OS, hostname, login user/home/shell, whether Slurm/PBS/LSF clients, tmux, rsync, python, conda, module, docker or singularity are installed, and mounted filesystems with capacity. Use this before deciding how to run a workload or where data can live.",
      parameters: {
        server: { type: "string", required: true, description: "Server id from server_list." },
      },
      output: objectOutput,
      async execute(args, exec) {
        const config = getConfig();
        const server = findServer(config, args.server);
        const connection = await connect(ctx, server, {
          connectTimeoutMs: CONNECT_TIMEOUT(config),
          expectedFingerprint: server.hostKey ?? null,
        });
        try {
          const result = await execRemote(connection, CAPABILITY_COMMAND, {
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
            hostKeyFingerprint: connection.fingerprint,
            platform: fields.platform ?? null,
            hostname: fields.hostname ?? null,
            user: fields.user ?? null,
            home: fields.home ?? null,
            shell: fields.shell ?? null,
            schedulers: ["sbatch", "qsub", "bsub"].filter((name) => fields[`tool_${name}`] && fields[`tool_${name}`] !== "MISSING"),
            tools: Object.fromEntries(
              ["tmux", "rsync", "python3", "conda", "module", "docker", "singularity", "apptainer"].map((toolName) => {
                const found = fields[`tool_${toolName}`];
                return [toolName, found && found !== "MISSING" ? found : null];
              }),
            ),
            storage: result.stdout
              .split("\n")
              .filter((line) => /^\/|^Filesystem|^\S+\s+\d+[KMGTP]?\s+\d+/.test(line))
              .slice(0, 12),
            rawExitCode: result.code,
          };
        } finally {
          connection.close();
        }
      },
    }),
  );

  register(
    defineTool({
      name: "run",
      description:
        "Run a shell command on a configured server through the remote login shell (bash -lc) and return exit code, stdout and stderr. Bounded by a timeout; the call is cancelled when the agent aborts it. Use for inspection and short operations. For long or GPU workloads on a scheduler host, submit a job instead (sbatch/squeue), or use a background-capable follow-up slice.",
      parameters: {
        server: { type: "string", required: true, description: "Server id from server_list." },
        command: { type: "string", required: true, description: "Shell command to run. Quote paths; the plugin passes the string to bash -lc." },
        cwd: { type: "string", description: "Absolute directory to run in." },
        timeoutMs: { type: "number", description: "Timeout in milliseconds; defaults to the plugin's commandTimeoutMs." },
      },
      output: objectOutput,
      async execute(args, exec) {
        const config = getConfig();
        const server = findServer(config, args.server);
        const connection = await connect(ctx, server, {
          connectTimeoutMs: CONNECT_TIMEOUT(config),
          expectedFingerprint: server.hostKey ?? null,
        });
        try {
          return { server: server.id, ...(await execRemote(connection, args.command, {
            timeoutMs: args.timeoutMs ?? COMMAND_TIMEOUT(config),
            ...(args.cwd ? { cwd: args.cwd } : {}),
            signal: exec.signal,
          })) };
        } finally {
          connection.close();
        }
      },
    }),
  );

  register(
    defineTool({
      name: "ls",
      description: "List a directory on a configured server over SFTP. Returns name, type, size, mode and modification time.",
      parameters: {
        server: { type: "string", required: true, description: "Server id from server_list." },
        path: { type: "string", required: true, description: "Absolute remote directory path." },
      },
      output: objectOutput,
      async execute(args) {
        const config = getConfig();
        const server = findServer(config, args.server);
        const connection = await connect(ctx, server, {
          connectTimeoutMs: CONNECT_TIMEOUT(config),
          expectedFingerprint: server.hostKey ?? null,
        });
        try {
          return { server: server.id, path: args.path, entries: await listDirectory(connection, args.path) };
        } finally {
          connection.close();
        }
      },
    }),
  );

  register(
    defineTool({
      name: "stat",
      description: "Show type, size, permissions and modification time for one remote path.",
      parameters: {
        server: { type: "string", required: true, description: "Server id from server_list." },
        path: { type: "string", required: true, description: "Absolute remote path." },
      },
      output: objectOutput,
      async execute(args) {
        const config = getConfig();
        const server = findServer(config, args.server);
        const connection = await connect(ctx, server, {
          connectTimeoutMs: CONNECT_TIMEOUT(config),
          expectedFingerprint: server.hostKey ?? null,
        });
        try {
          return { server: server.id, entry: await statPath(connection, args.path) };
        } finally {
          connection.close();
        }
      },
    }),
  );

  register(
    defineTool({
      name: "mkdir",
      description: "Create a directory on a configured server. Set recursive=true to create parents.",
      parameters: {
        server: { type: "string", required: true, description: "Server id from server_list." },
        path: { type: "string", required: true, description: "Absolute remote directory path." },
        recursive: { type: "boolean", description: "Create parent directories too." },
      },
      output: objectOutput,
      async execute(args) {
        const config = getConfig();
        const server = findServer(config, args.server);
        const connection = await connect(ctx, server, {
          connectTimeoutMs: CONNECT_TIMEOUT(config),
          expectedFingerprint: server.hostKey ?? null,
        });
        try {
          await makeDirectory(connection, args.path, Boolean(args.recursive));
          return { server: server.id, path: args.path, created: true };
        } finally {
          connection.close();
        }
      },
    }),
  );

  register(
    defineTool({
      name: "rm",
      description:
        "Remove one remote path. Directories require recursive=true and confirm=true; the path must be absolute. Prefer listing the parent first so you know exactly what is removed.",
      parameters: {
        server: { type: "string", required: true, description: "Server id from server_list." },
        path: { type: "string", required: true, description: "Absolute remote path." },
        recursive: { type: "boolean", description: "Remove a directory tree." },
        confirm: { type: "boolean", description: "Required with recursive=true; acknowledges data loss." },
      },
      output: objectOutput,
      async execute(args) {
        if (args.recursive && args.confirm !== true) {
          throw new MultiserversError("recursive removal requires confirm=true");
        }
        const config = getConfig();
        const server = findServer(config, args.server);
        const connection = await connect(ctx, server, {
          connectTimeoutMs: CONNECT_TIMEOUT(config),
          expectedFingerprint: server.hostKey ?? null,
        });
        try {
          await removePath(connection, args.path, Boolean(args.recursive));
          return { server: server.id, path: args.path, removed: true };
        } finally {
          connection.close();
        }
      },
    }),
  );

  register(
    defineTool({
      name: "upload",
      description:
        "Upload one local file to a configured server over SFTP, overwriting the destination. Returns the byte count written. Large datasets belong on the server already; transfer only code, configs and small inputs.",
      parameters: {
        server: { type: "string", required: true, description: "Server id from server_list." },
        localPath: { type: "string", required: true, description: "Absolute local path." },
        remotePath: { type: "string", required: true, description: "Absolute remote destination path." },
      },
      output: objectOutput,
      async execute(args) {
        const config = getConfig();
        const server = findServer(config, args.server);
        const connection = await connect(ctx, server, {
          connectTimeoutMs: CONNECT_TIMEOUT(config),
          expectedFingerprint: server.hostKey ?? null,
        });
        try {
          await uploadFile(connection, args.localPath, args.remotePath);
          const entry = await statPath(connection, args.remotePath);
          return { server: server.id, remotePath: args.remotePath, bytes: entry.size };
        } finally {
          connection.close();
        }
      },
    }),
  );

  register(
    defineTool({
      name: "download",
      description:
        "Download one remote file to a local path over SFTP, overwriting the destination. Use for results and small artifacts; leave large datasets on the server.",
      parameters: {
        server: { type: "string", required: true, description: "Server id from server_list." },
        remotePath: { type: "string", required: true, description: "Absolute remote path." },
        localPath: { type: "string", required: true, description: "Absolute local destination path." },
      },
      output: objectOutput,
      async execute(args) {
        const config = getConfig();
        const server = findServer(config, args.server);
        const connection = await connect(ctx, server, {
          connectTimeoutMs: CONNECT_TIMEOUT(config),
          expectedFingerprint: server.hostKey ?? null,
        });
        try {
          await downloadFile(connection, args.remotePath, args.localPath);
          return { server: server.id, remotePath: args.remotePath, localPath: args.localPath };
        } finally {
          connection.close();
        }
      },
    }),
  );

  register(
    defineTool({
      name: "server_add",
      description:
        "Register a remote server. The password, when provided, is stored in the DSH credential store (the same store provider API keys use), never in plugin configuration; only its reference name is written to the profile. Requires the Settings service. Validate reachability afterwards with server_test.",
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
        if (auth === "password" && !args.password) {
          throw new MultiserversError("password auth requires a password");
        }
        if (auth === "key" && !args.keyPath) {
          throw new MultiserversError("key auth requires keyPath");
        }
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
        "Remove a configured server. By default the stored password credential is also removed; pass forgetPassword=false to keep it. Does not touch anything on the remote host.",
      parameters: {
        server: { type: "string", required: true, description: "Server id from server_list." },
        forgetPassword: { type: "boolean", description: "Also remove the stored password credential; defaults to true." },
      },
      output: objectOutput,
      async execute(args) {
        const config = getConfig();
        const server = findServer(config, args.server);
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

/** Store a password in the DSH credential store (same place provider API keys live). */
export async function storePassword(ctx: Context, serverId: string, password: string): Promise<string> {
  const refName = passwordRefFor(serverId);
  await ctx.credentials.set(credentialRef(refName), password);
  return refName;
}

export async function checkPasswordConfigured(ctx: Context, server: ServerSpec): Promise<boolean> {
  const refName = server.passwordRef ?? passwordRefFor(server.id);
  const info = await ctx.credentials.describe(credentialRef(refName));
  return Boolean(info?.configured);
}

export { resolvePassword, shellQuote };
