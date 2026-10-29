import { createServer, type Server as NetServer } from "node:net";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import type { ConnectionPool } from "./core/pool.js";
import { downloadWithResume, uploadWithResume } from "./core/transfer.js";
import type { SessionRegistry } from "./core/session.js";
import { execRemote, passwordRefFor } from "./core/ssh.js";
import { cancelJob, loadJob, queryJobs, readJobLogs, saveJob, submitJob } from "./core/jobs.js";
import { startJobWatcher } from "./core/watch.js";
import { startTransferJob } from "./core/transfer-job.js";
import { MultiserversError, PLUGIN_ID, findServer, type Config, type ServerSpec } from "./core/types.js";

const text = (value: unknown) => [{ type: "text" as const, text: JSON.stringify(value, null, 2) }];
const objectOutput = {
  schema: { type: "object", additionalProperties: true } as const,
  render: (_args: unknown, value: unknown) => text(value),
};
const DEFAULT_MAX_BYTES = 256 * 1024;
const jsonSafe = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

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
        kind: { type: "string", enum: ["auto", "bare", "slurm", "pbs", "lsf"], description: "Scheduling backend; defaults to auto detection." },
        partition: { type: "string", description: "Default Slurm partition for jobs." },
        account: { type: "string", description: "Default Slurm account." },
        qos: { type: "string", description: "Default Slurm QOS." },
        time: { type: "string", description: "Default Slurm time limit." },
        cpusPerTask: { type: "number", description: "Default CPUs per job." },
        memory: { type: "string", description: "Default memory per job." },
        gpus: { type: "number", description: "Default GPUs per job." },
        jobRoot: { type: "string", description: "Remote directory for job scripts and logs." },
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
        const defaults = {
          ...(existing?.schedulerDefaults ?? {}),
          ...(args.partition ? { partition: args.partition } : {}),
          ...(args.account ? { account: args.account } : {}),
          ...(args.qos ? { qos: args.qos } : {}),
          ...(args.time ? { time: args.time } : {}),
          ...(args.cpusPerTask ? { cpusPerTask: args.cpusPerTask } : {}),
          ...(args.memory ? { memory: args.memory } : {}),
          ...(args.gpus ? { gpus: args.gpus } : {}),
        };
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
          ...(args.kind ? { kind: args.kind as "auto" | "bare" | "slurm" } : {}),
          ...(Object.keys(defaults).length ? { schedulerDefaults: defaults } : {}),
          ...(args.jobRoot ? { jobRoot: args.jobRoot } : {}),
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
        background: { type: "boolean", description: "Run in the background; read progress with job_output and cancel with job_kill." },
        chunkSize: { type: "number", description: "Transfer chunk size in bytes; defaults adapt to file size." },
      },
      output: objectOutput,
      async execute(args, exec) {
        const server = findServer(getConfig(), args.server);
        const state = await pool.ensure(ctx, server);
        const options = {
          overwrite: Boolean(args.overwrite),
          signal: exec.signal,
          ...(args.chunkSize ? { chunkSize: args.chunkSize } : {}),
        };
        if (args.background) {
          const started = startTransferJob(ctx, exec.agent, state.client, "upload", { localPath: args.localPath, remotePath: args.remotePath }, options);
          if (!started.jobId) throw new MultiserversError(`background upload unavailable: ${started.error ?? "unknown error"}`);
          return jsonSafe({ server: server.id, background: true, jobId: started.jobId, localPath: args.localPath, remotePath: args.remotePath });
        }
        const startedAt = Date.now();
        const result = await uploadWithResume(state.client, args.localPath, args.remotePath, options);
        const durationMs = Date.now() - startedAt;
        return jsonSafe({ server: server.id, ...result, durationMs, throughputMBps: result.bytes > 0 ? Math.round((result.bytes / (1024 * 1024) / (durationMs / 1000)) * 10) / 10 : 0 });
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
        background: { type: "boolean", description: "Run in the background; read progress with job_output and cancel with job_kill." },
        chunkSize: { type: "number", description: "Transfer chunk size in bytes; defaults adapt to file size." },
      },
      output: objectOutput,
      async execute(args, exec) {
        const server = findServer(getConfig(), args.server);
        const state = await pool.ensure(ctx, server);
        const options = {
          overwrite: Boolean(args.overwrite),
          signal: exec.signal,
          ...(args.chunkSize ? { chunkSize: args.chunkSize } : {}),
        };
        if (args.background) {
          const started = startTransferJob(ctx, exec.agent, state.client, "download", { localPath: args.localPath, remotePath: args.remotePath }, options);
          if (!started.jobId) throw new MultiserversError(`background download unavailable: ${started.error ?? "unknown error"}`);
          return jsonSafe({ server: server.id, background: true, jobId: started.jobId, remotePath: args.remotePath, localPath: args.localPath });
        }
        const started = Date.now();
        const result = await downloadWithResume(state.client, args.remotePath, args.localPath, options);
        const durationMs = Date.now() - started;
        return jsonSafe({ server: server.id, ...result, durationMs, throughputMBps: result.bytes > 0 ? Math.round((result.bytes / (1024 * 1024) / (durationMs / 1000)) * 10) / 10 : 0 });
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


  register(
    defineTool({
      name: "job_submit",
      description:
        "Submit a long-running job on a server and return immediately. The server's type decides the route: a Slurm cluster gets sbatch (queued, survives disconnect), a bare-metal host gets a detached setsid/nohup process. Returns jobId; poll it with job_status, read output with job_logs, stop it with job_cancel. Scripts are staged under the server's jobRoot.",
      parameters: {
        server: { type: "string", required: true, description: "Server id from server_list." },
        command: { type: "string", description: "Shell command to run as the job body." },
        script: { type: "string", description: "Full bash script; takes precedence over command." },
        workdir: { type: "string", required: true, description: "Absolute working directory on the server." },
        name: { type: "string", description: "Short job name for schedulers and logs." },
        partition: { type: "string", description: "Slurm partition (overrides the server default)." },
        account: { type: "string", description: "Slurm account." },
        qos: { type: "string", description: "Slurm QOS." },
        time: { type: "string", description: "Slurm time limit, e.g. 4:00:00." },
        cpusPerTask: { type: "number", description: "CPUs for the job." },
        memory: { type: "string", description: "Memory request, e.g. 32G." },
        gpus: { type: "number", description: "GPUs requested (Slurm --gres)." },
        watch: { type: "boolean", description: "Watch the job locally and notify this session when it ends; defaults to true." },
      },
      output: objectOutput,
      async execute(args, exec) {
        const config = getConfig();
        const server = findServer(config, args.server);
        const resources = {
          ...(args.partition ? { partition: args.partition } : {}),
          ...(args.account ? { account: args.account } : {}),
          ...(args.qos ? { qos: args.qos } : {}),
          ...(args.time ? { time: args.time } : {}),
          ...(args.cpusPerTask ? { cpusPerTask: args.cpusPerTask } : {}),
          ...(args.memory ? { memory: args.memory } : {}),
          ...(args.gpus ? { gpus: args.gpus } : {}),
        };
        const record = await submitJob(
          ctx,
          pool,
          server,
          { ...(args.command ? { command: args.command } : {}), ...(args.script ? { script: args.script } : {}), workdir: args.workdir, ...(args.name ? { name: args.name } : {}), ...(Object.keys(resources).length ? { resources } : {}) },
          async (backend) => {
            const latest = getConfig();
            await writeServers(
              ctx,
              latest.servers.map((entry) => (entry.id === server.id ? { ...entry, resolvedKind: backend } : entry)),
            );
          },
        );
        let watchJobId: string | null = null;
        let watchError: string | undefined;
        if (args.watch !== false) {
          try {
            const watch = startJobWatcher(ctx, pool, () => getConfig().servers, record.id, exec.agent);
            if (watch.id) {
              watchJobId = watch.id;
              record.watchJobId = watch.id;
              saveJob(record);
            }
            if (!watch.id || watch.ownerBound === false) watchError = watch.error ?? "watcher is not bound to this session; completion notices may not arrive";
          } catch (watchFailure) {
            watchError = `watcher registration threw: ${(watchFailure as Error).message}`;
            console.error("[multiservers] watcher registration threw", watchFailure);
          }
        }
        return jsonSafe({ ...record, jobId: record.id, watching: Boolean(watchJobId), ...(watchError ? { watchError } : {}) });
      },
    }),
  );

  register(
    defineTool({
      name: "job_status",
      description:
        "Check job state (queued/running/completed/failed/cancelled/lost/unknown), exit code and log tail. With jobId, one job; with server only, all jobs of that server; with neither, all tracked jobs. Reads the host ledger and reconciles against the scheduler or the process.",
      parameters: {
        jobId: { type: "string", description: "Job id returned by job_submit." },
        server: { type: "string", description: "Filter by server id." },
      },
      output: objectOutput,
      async execute(args) {
        const jobs = await queryJobs(ctx, pool, getConfig().servers, {
          ...(args.server ? { serverId: args.server } : {}),
          ...(args.jobId ? { jobId: args.jobId } : {}),
        });
        return jsonSafe({
          jobs: jobs.map((job) => ({
            jobId: job.id,
            server: job.server,
            backend: job.backend,
            schedulerJobId: job.schedulerJobId ?? null,
            state: job.state,
            exitCode: job.exitCode ?? null,
            workdir: job.workdir,
            outPath: job.outPath,
            createdAt: job.createdAt,
            lastCheckedAt: job.lastCheckedAt,
            watching: Boolean(job.watchJobId),
          })),
        });
      },
    }),
  );

  register(
    defineTool({
      name: "job_logs",
      description:
        "Read a job's output incrementally. Pass offset from a previous call to continue. Defaults to 64 KiB per call and reports truncated when more remains. Read stdout or stderr separately.",
      parameters: {
        jobId: { type: "string", required: true, description: "Job id returned by job_submit." },
        offset: { type: "number", description: "Byte offset to start from; use nextOffset from the previous call." },
        maxBytes: { type: "number", description: "Maximum bytes to read; defaults to 64 KiB." },
        stream: { type: "string", enum: ["stdout", "stderr"], description: "Which stream to read; defaults to stdout." },
      },
      output: objectOutput,
      async execute(args) {
        const record = loadJob(args.jobId);
        if (!record) throw new MultiserversError(`Unknown job "${args.jobId}"`);
        const server = findServer(getConfig(), record.server);
        const result = await readJobLogs(ctx, pool, server, record, {
          ...(args.offset !== undefined ? { offset: args.offset } : {}),
          ...(args.maxBytes !== undefined ? { maxBytes: args.maxBytes } : {}),
          ...(args.stream ? { stream: args.stream } : {}),
        });
        return { jobId: record.id, server: record.server, ...result };
      },
    }),
  );

  register(
    defineTool({
      name: "job_wait",
      description:
        "Block until a job reaches a terminal state or the timeout expires (default 5 minutes). Use it for short jobs instead of polling; long-running jobs are announced by their watcher.",
      parameters: {
        jobId: { type: "string", required: true, description: "Job id returned by job_submit." },
        timeoutMs: { type: "number", description: "Maximum wait in milliseconds; defaults to 300000." },
      },
      output: objectOutput,
      async execute(args) {
        const timeoutMs = args.timeoutMs ?? 300_000;
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const jobs = await queryJobs(ctx, pool, getConfig().servers, { jobId: args.jobId });
          const job = jobs[0];
          if (!job) throw new MultiserversError(`Unknown job "${args.jobId}"`);
          const terminal = ["completed", "failed", "cancelled", "lost"].includes(job.state);
          if (terminal || Date.now() >= deadline) {
            return jsonSafe({
              jobId: job.id,
              state: job.state,
              exitCode: job.exitCode ?? null,
              timedOut: !terminal,
              waitedMs: timeoutMs - Math.max(0, deadline - Date.now()),
            });
          }
          await new Promise((resolve) => setTimeout(resolve, Math.min(5000, Math.max(250, deadline - Date.now()))));
        }
      },
    }),
  );

  register(
    defineTool({
      name: "job_cancel",
      description:
        "Cancel a running or queued job: scancel on Slurm, SIGTERM then SIGKILL on bare metal. The ledger records cancelled.",
      parameters: {
        jobId: { type: "string", required: true, description: "Job id returned by job_submit." },
      },
      output: objectOutput,
      async execute(args) {
        const record = loadJob(args.jobId);
        if (!record) throw new MultiserversError(`Unknown job "${args.jobId}"`);
        if (record.watchJobId) {
          const jobs = ctx.get("jobs") as { kill?: (id: string, caller?: string, reason?: string) => string } | undefined;
          try {
            jobs?.kill?.(record.watchJobId, undefined, "作业已取消");
          } catch {
            /* watcher already gone */
          }
        }
        const server = findServer(getConfig(), record.server);
        const cancelled = await cancelJob(ctx, pool, server, record);
        return jsonSafe({ jobId: cancelled.id, state: cancelled.state });
      },
    }),
  );

  return disposers;
}
