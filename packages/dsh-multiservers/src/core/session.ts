import { randomBytes } from "node:crypto";
import type { Client, ClientChannel } from "ssh2";
import type { Context } from "@deepseek-ai/cordis";
import type { ConnectionPool } from "./pool.js";
import { findServer, MultiserversError, type Config, type ServerSpec } from "./types.js";

const MARKER = "\x1eMSS";
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
};

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
  private queue: Array<{ command: string; timeoutMs: number; signal?: AbortSignal; resolve: (r: RunResult) => void }> = [];
  private starting: Promise<void> | null = null;
  private closed = false;
  private dead = false;
  private lastUsed = Date.now();

  constructor(
    private readonly client: Client,
    readonly serverId: string,
    readonly name: string,
  ) {}

  get alive(): boolean {
    return !this.closed && !this.dead && this.stream !== null;
  }

  start(): Promise<void> {
    this.starting ??= this.spawn();
    return this.starting;
  }

  private spawn(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.client.exec("bash -l", (error, stream) => {
        if (error) {
          reject(new MultiserversError(`Could not start a shell session: ${error.message}`));
          return;
        }
        this.stream = stream;
        this.dead = false;
        const readyToken = randomBytes(12).toString("hex");
        const readyMarker = `${MARKER}READY:${readyToken}${MARKER}`;
        stream.on("data", (chunk: Buffer) => this.onData(chunk));
        stream.stderr.on("data", (chunk: Buffer) => {
          if (this.pending) this.pending.stderr += chunk.toString("utf8");
        });
        stream.on("close", () => this.onClose());
        stream.on("error", () => this.onClose());

        // Login-shell startup output is allowed to arrive first; it is discarded
        // once the readiness marker is seen.
        stream.write(`printf '${readyMarker}\n'
`);
        const poll = setInterval(() => {
          if (!this.buffer.includes(readyMarker)) return;
          clearInterval(poll);
          clearTimeout(fail);
          this.buffer = "";
          resolve();
        }, 10);
        poll.unref?.();
        const fail = setTimeout(() => {
          clearInterval(poll);
          reject(new MultiserversError("Shell session did not become ready"));
        }, 15_000);
        fail.unref?.();
      });
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
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
    });
    this.lastUsed = Date.now();
    void this.pump();
  }

  private onClose(): void {
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
      });
    }
  }

  async run(command: string, timeoutMs: number, signal?: AbortSignal): Promise<RunResult> {
    if (this.closed) throw new MultiserversError(`Session "${this.name}" is closed`);
    if (!this.alive) await this.restart();
    return this.enqueue(command, timeoutMs, signal);
  }

  private enqueue(command: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<RunResult> {
    return new Promise<RunResult>((resolve) => {
      this.queue.push({ command, timeoutMs, resolve, ...(signal ? { signal } : {}) });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pending) return;
    const next = this.queue.shift();
    if (!next) return;
    await this.start();
    const pending: Pending = {
      token: randomBytes(10).toString("hex"),
      stdout: "",
      stderr: "",
      resolve: next.resolve,
      startedAt: Date.now(),
      timeoutMs: next.timeoutMs,
      timer: null,
      ...(next.signal ? { signal: next.signal } : {}),
    };
    this.pending = pending;
    const stream = this.stream!;
    const payload = `${next.command}\n__mss_rc=$?\nprintf '${MARKER}${pending.token}:%s:%s${MARKER}\\n' "$__mss_rc" "$PWD"\n`;
    stream.write(payload);
    pending.timer = setTimeout(() => {
      void this.resetAfterTimeout(pending);
    }, next.timeoutMs);
    pending.timer.unref?.();
    pending.onAbort = () => {
      void this.resetAfterTimeout(pending);
    };
    if (pending.signal) pending.signal.addEventListener("abort", pending.onAbort, { once: true });
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
    });
    if (!this.closed) await this.restart();
    if (!this.pending) void this.pump();
  }

  private async restart(): Promise<void> {
    this.stream = null;
    this.dead = false;
    this.buffer = "";
    this.starting = null;
    try {
      await this.start();
    } catch {
      this.dead = true;
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
    private readonly maxPerServer: () => number,
  ) {}

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
    if (inUse >= this.maxPerServer()) {
      throw new MultiserversError(
        `Server "${serverId}" already has ${inUse} sessions (limit ${this.maxPerServer()}); close an idle session first.`,
      );
    }
    const connection = await this.pool.ensure(ctx, server);
    const session = new ShellSession(connection.client, serverId, name);
    await session.start();
    this.sessions.set(key, session);
    this.pool.attachSession(serverId, name);
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
  }
}
