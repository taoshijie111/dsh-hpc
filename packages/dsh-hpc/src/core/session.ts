import { randomBytes } from "node:crypto";
import type { Client, ClientChannel } from "ssh2";
import type { Context } from "@deepseek-ai/cordis";
import type { ConnectionPool } from "./pool.js";
import { findServer, HpcError, type Config, type ServerSpec } from "./types.js";

const MARKER = "\x1eMSS";
const MAX_BUFFER = 1024 * 1024;
const DEFAULT_SESSION = "main";

export type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when the shell had to be restarted, so cwd/env from before is lost. */
  stateReset: boolean;
  durationMs: number;
  cwd: string | null;
  truncated: boolean;
  totalBytes: number;
};

export type SessionInfo = {
  server: string;
  name: string;
  alive: boolean;
  createdAt: string;
  lastUsedAt: string;
};

type Pending = {
  token: string;
  stdout: string;
  stderr: string;
  resolve: (result: RunResult) => void;
  startedAt: number;
  timeoutMs: number;
  timer: NodeJS.Timeout | null;
  signal?: AbortSignal;
  onAbort?: () => void;
  truncated: boolean;
  totalBytes: number;
};

type Queued = {
  command: string;
  timeoutMs: number;
  signal?: AbortSignal;
  resolve: (result: RunResult) => void;
  reject: (error: Error) => void;
};

/** Normalize anything a failed start can throw into one HpcError message. */
function sessionError(error: unknown, fallback: string): HpcError {
  if (error instanceof HpcError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new HpcError(`${fallback}: ${message}`);
}

/**
 * A sticky shell: one long-lived `bash -l` process on an existing connection.
 * Commands are framed with a random sentinel so output boundaries and exit
 * codes are unambiguous, while `cd`/exports/module state persists between calls.
 */
export class ShellSession {
  readonly createdAt = Date.now();
  private stream: ClientChannel | null = null;
  private buffer = "";
  private pending: Pending | null = null;
  private queue: Queued[] = [];
  private starting: Promise<void> | null = null;
  private restarting: Promise<void> | null = null;
  private pumping = false;
  private closed = false;
  private dead = false;
  private lastUsed = Date.now();

  constructor(
    private readonly client: Client,
    readonly serverId: string,
    readonly name: string,
    private readonly readyTimeoutMs = 15_000,
  ) {}

  get alive(): boolean {
    return !this.closed && !this.dead && this.stream !== null;
  }

  /** True while a command runs or is queued; idle reaping skips busy sessions. */
  get busy(): boolean {
    return this.pending !== null || this.queue.length > 0;
  }

  start(): Promise<void> {
    if (!this.starting) {
      const attempt = this.spawn();
      this.starting = attempt;
      // A failed start must neither become an unhandled rejection nor poison
      // later attempts: current awaiters still see the rejection, but the
      // cached promise is cleared so the next call can spawn again.
      void attempt.catch(() => {
        if (this.starting === attempt) this.starting = null;
      });
    }
    return this.starting;
  }

  private spawn(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;

      const succeed = (): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        timer = null;
        this.buffer = "";
        resolve();
      };
      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        timer = null;
        const stream = this.stream;
        this.stream = null;
        this.dead = true;
        try {
          stream?.close();
        } catch {
          /* already gone */
        }
        reject(new HpcError(message));
      };

      this.client.exec("bash -l", (error, stream) => {
        if (settled) {
          try {
            stream?.close();
          } catch {
            /* already gone */
          }
          return;
        }
        if (error) {
          fail(`Could not start a shell session: ${error.message}`);
          return;
        }
        this.stream = stream;
        this.dead = false;
        const readyMarker = `${MARKER}READY:${randomBytes(12).toString("hex")}${MARKER}`;
        stream.on("data", (chunk: Buffer) => {
          this.onData(chunk);
          if (!settled && this.buffer.includes(readyMarker)) succeed();
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          if (this.pending) this.pending.stderr += chunk.toString("utf8");
        });
        stream.on("close", () => {
          if (!settled) {
            fail("Shell session closed before it became ready");
            return;
          }
          this.onClose(stream);
        });
        stream.on("error", (streamError: Error) => {
          if (!settled) {
            fail(`Shell session failed before it became ready: ${streamError.message}`);
            return;
          }
          this.onClose(stream);
        });

        // Login-shell startup output is allowed to arrive first; it is discarded
        // once the readiness marker is seen.
        stream.write(`printf '${readyMarker}\n'
`);
        timer = setTimeout(() => fail("Shell session did not become ready"), this.readyTimeoutMs);
        timer.unref?.();
      });
    });
  }

  private onData(chunk: Buffer): void {
    const text = chunk.toString("utf8");
    if (!this.pending) {
      this.buffer += text;
      return;
    }
    this.pending.totalBytes += Buffer.byteLength(text);
    this.buffer += text;
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer = this.buffer.slice(this.buffer.length - MAX_BUFFER);
      this.pending.truncated = true;
    }
    this.drain();
  }

  private drain(): void {
    const pending = this.pending;
    if (!pending) return;
    const marker = `${MARKER}${pending.token}:`;
    const start = this.buffer.indexOf(marker);
    if (start < 0) return;
    const end = this.buffer.indexOf(MARKER, start + marker.length);
    if (end < 0) return;
    const payload = this.buffer.slice(start + marker.length, end);
    const after = this.buffer.slice(end + MARKER.length);
    // payload is "<code>:<cwd>"
    const separator = payload.indexOf(":");
    const code = separator >= 0 ? Number(payload.slice(0, separator)) : null;
    const cwd = separator >= 0 ? payload.slice(separator + 1) : null;
    const stdout = this.buffer.slice(0, start).replace(/\x1e$/, "");
    this.buffer = after;
    this.pending = null;
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
    pending.resolve({
      code: Number.isFinite(code as number) ? (code as number) : null,
      stdout,
      stderr: pending.stderr,
      timedOut: false,
      stateReset: false,
      durationMs: Date.now() - pending.startedAt,
      cwd,
      truncated: pending.truncated,
      totalBytes: pending.totalBytes,
    });
    this.lastUsed = Date.now();
    this.pumpInBackground();
  }

  /**
   * `closed` identifies the stream that went away. A close event from a stream
   * that restart() already replaced must not tear the new one down.
   */
  private onClose(closed?: ClientChannel): void {
    if (closed && this.stream && this.stream !== closed) return;
    this.dead = true;
    this.stream = null;
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
      pending.resolve({
        code: null,
        stdout: pending.stdout,
        stderr: pending.stderr,
        timedOut: false,
        stateReset: true,
        durationMs: Date.now() - pending.startedAt,
        cwd: null,
        truncated: pending.truncated,
        totalBytes: pending.totalBytes,
      });
    }
    const queued = this.queue;
    this.queue = [];
    for (const item of queued) {
      item.resolve({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        stateReset: true,
        durationMs: 0,
        cwd: null,
        truncated: false,
        totalBytes: 0,
      });
    }
  }

  async run(command: string, timeoutMs: number, signal?: AbortSignal): Promise<RunResult> {
    if (this.closed) throw new HpcError(`Session "${this.name}" is closed`);
    if (!this.alive) await this.restart();
    return this.enqueue(command, timeoutMs, signal);
  }

  private enqueue(command: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
      if (this.closed) {
        reject(new HpcError(`Session "${this.name}" is closed`));
        return;
      }
      this.queue.push({ command, timeoutMs, resolve, reject, ...(signal ? { signal } : {}) });
      this.pumpInBackground();
    });
  }

  private pumpInBackground(): void {
    void this.pump().catch(() => undefined);
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      if (this.pending) return;
      const next = this.queue.shift();
      if (!next) return;
      try {
        await this.start();
      } catch (error) {
        // A dead shell must fail the pending commands, never escape as an
        // unhandled rejection: the DSH host treats those as fatal and exits.
        this.dead = true;
        const failure = sessionError(error, `Could not start session "${this.name}"`);
        next.reject(failure);
        this.rejectQueue(failure);
        return;
      }
      if (this.closed) {
        const failure = new HpcError(`Session "${this.name}" is closed`);
        next.reject(failure);
        this.rejectQueue(failure);
        return;
      }
      const pending: Pending = {
        token: randomBytes(10).toString("hex"),
        stdout: "",
        stderr: "",
        resolve: next.resolve,
        startedAt: Date.now(),
        timeoutMs: next.timeoutMs,
        timer: null,
        ...(next.signal ? { signal: next.signal } : {}),
        truncated: false,
        totalBytes: 0,
      };
      this.pending = pending;
      const stream = this.stream;
      if (!stream) {
        this.pending = null;
        const failure = new HpcError(`Session "${this.name}" lost its shell before the command could run`);
        next.reject(failure);
        this.rejectQueue(failure);
        return;
      }
      const payload = `${next.command}\n__mss_rc=$?\nprintf '${MARKER}${pending.token}:%s:%s${MARKER}\\n' "$__mss_rc" "$PWD"\n`;
      try {
        stream.write(payload);
      } catch (error) {
        this.pending = null;
        this.dead = true;
        const failure = sessionError(error, `Could not write to session "${this.name}"`);
        next.reject(failure);
        this.rejectQueue(failure);
        return;
      }
      pending.timer = setTimeout(() => {
        void this.resetAfterTimeout(pending).catch(() => undefined);
      }, next.timeoutMs);
      pending.timer.unref?.();
      pending.onAbort = () => {
        void this.resetAfterTimeout(pending).catch(() => undefined);
      };
      if (pending.signal) pending.signal.addEventListener("abort", pending.onAbort, { once: true });
    } finally {
      this.pumping = false;
    }
  }

  private rejectQueue(error: Error): void {
    const queued = this.queue;
    this.queue = [];
    for (const item of queued) item.reject(error);
  }

  private async resetAfterTimeout(pending: Pending): Promise<void> {
    if (this.pending !== pending) return;
    this.pending = null;
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
    const stdout = this.buffer;
    this.buffer = "";
    try {
      this.stream?.close();
    } catch {
      /* ignore */
    }
    this.stream = null;
    this.dead = true;
    pending.resolve({
      code: null,
      stdout,
      stderr: pending.stderr,
      timedOut: true,
      stateReset: true,
      durationMs: Date.now() - pending.startedAt,
      cwd: null,
      truncated: pending.truncated,
      totalBytes: pending.totalBytes,
    });
    if (!this.closed) {
      try {
        await this.restart();
      } catch {
        this.dead = true;
      }
    }
    if (!this.pending) this.pumpInBackground();
  }

  private restart(): Promise<void> {
    this.restarting ??= this.doRestart().finally(() => {
      this.restarting = null;
    });
    return this.restarting;
  }

  private async doRestart(): Promise<void> {
    const previous = this.stream;
    this.stream = null;
    this.buffer = "";
    this.dead = false;
    this.starting = null;
    try {
      previous?.close();
    } catch {
      /* already gone */
    }
    try {
      await this.start();
    } catch (error) {
      this.dead = true;
      throw sessionError(error, `Could not start session "${this.name}" on "${this.serverId}"`);
    }
  }

  describe(): SessionInfo {
    return {
      server: this.serverId,
      name: this.name,
      alive: this.alive,
      createdAt: new Date(this.createdAt).toISOString(),
      lastUsedAt: new Date(this.lastUsed).toISOString(),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      this.stream?.write("exit\n");
    } catch {
      /* ignore */
    }
    const stream = this.stream;
    setTimeout(() => {
      try {
        stream?.close();
      } catch {
        /* ignore */
      }
    }, 300).unref?.();
    this.stream = null;
    this.dead = true;
  }
}

/** Named sessions per server, sharing one pooled connection. */
export class SessionRegistry {
  private readonly sessions = new Map<string, ShellSession>();

  constructor(
    private readonly pool: ConnectionPool,
    private readonly options: {
      maxPerServer: () => number;
      idleTimeoutMs: () => number;
      /** How long `bash -l` may take before the session counts as failed. */
      readyTimeoutMs?: () => number;
    },
  ) {}

  private sweepTimer: NodeJS.Timeout | null = null;

  private armSweep(): void {
    if (this.sweepTimer || this.sessions.size === 0) return;
    this.sweepTimer = setInterval(() => this.sweepIdle(), 60_000);
    this.sweepTimer.unref?.();
  }

  private sweepIdle(): void {
    const timeout = this.options.idleTimeoutMs();
    if (timeout > 0) {
      const now = Date.now();
      for (const session of [...this.sessions.values()]) {
        if (!session.alive || session.busy) continue;
        if (now - Date.parse(session.describe().lastUsedAt) > timeout) {
          void this.close(session.serverId, session.name).catch(() => undefined);
        }
      }
    }
    if (this.sessions.size === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private key(serverId: string, name: string): string {
    return `${serverId}::${name}`;
  }

  async open(ctx: Context, config: Config, server: ServerSpec, name = DEFAULT_SESSION): Promise<ShellSession> {
    const serverId = server.id;
    const key = this.key(serverId, name);
    const existing = this.sessions.get(key);
    if (existing && existing.alive) return existing;
    if (existing) {
      await existing.close();
      this.sessions.delete(key);
      this.pool.detachSession(serverId, name);
    }
    const inUse = [...this.sessions.values()].filter((session) => session.serverId === serverId && session.alive).length;
    const limit = this.options.maxPerServer();
    if (inUse >= limit) {
      throw new HpcError(
        `Server "${serverId}" already has ${inUse} sessions (limit ${limit}); close an idle session first.`,
      );
    }
    const connection = await this.pool.ensure(ctx, server);
    const session = new ShellSession(connection.client, serverId, name, this.options.readyTimeoutMs?.() ?? 15_000);
    await session.start();
    this.sessions.set(key, session);
    this.pool.attachSession(serverId, name);
    this.armSweep();
    return session;
  }

  async run(
    ctx: Context,
    config: Config,
    serverId: string,
    command: string,
    options: { session?: string; timeoutMs: number; signal?: AbortSignal },
  ): Promise<RunResult> {
    const server = findServer(config, serverId);
    const session = await this.open(ctx, config, server, options.session ?? DEFAULT_SESSION);
    return session.run(command, options.timeoutMs, options.signal);
  }

  get(serverId: string, name = DEFAULT_SESSION): ShellSession | undefined {
    return this.sessions.get(this.key(serverId, name));
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((session) => session.describe());
  }

  async close(serverId: string, name = DEFAULT_SESSION): Promise<boolean> {
    const key = this.key(serverId, name);
    const session = this.sessions.get(key);
    if (!session) return false;
    this.sessions.delete(key);
    await session.close();
    this.pool.detachSession(serverId, name);
    return true;
  }

  async closeForServer(serverId: string): Promise<void> {
    const names = [...this.sessions.values()].filter((session) => session.serverId === serverId).map((s) => s.name);
    for (const name of names) await this.close(serverId, name);
  }

  async closeAll(): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      try {
        await session.close();
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear();
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}
