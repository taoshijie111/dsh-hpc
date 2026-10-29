import type { Context } from "@deepseek-ai/cordis";
import type { Client } from "ssh2";
import { connect } from "./ssh.js";
import type { ServerSpec } from "./types.js";

export type ForwardInfo = {
  localPort: number;
  remoteHost: string;
  remotePort: number;
};

type Forward = ForwardInfo & { server: import("node:net").Server };

/**
 * One authenticated SSH connection per server, kept alive across tool calls.
 * A connection carries multiple shell sessions, SFTP channels and forwarded
 * ports; idle reaping never closes a connection that still has live sessions.
 */
export type ConnectionState = {
  serverId: string;
  client: Client;
  fingerprint: string;
  connectedAt: number;
  lastUsedAt: number;
  alive: boolean;
  idleTimer: NodeJS.Timeout | null;
  sessions: Set<string>;
  forwards: Map<number, Forward>;
};

export type PoolOptions = {
  connectTimeoutMs: () => number;
  keepaliveIntervalMs: () => number;
  /** 0 disables idle reaping. */
  idleTimeoutMs: () => number;
};

export class ConnectionPool {
  private readonly entries = new Map<string, ConnectionState>();
  private closed = false;

  constructor(private readonly options: PoolOptions) {}

  async ensure(
    ctx: Context,
    server: ServerSpec,
    options: { verificationCode?: string } = {},
  ): Promise<ConnectionState> {
    if (this.closed) throw new Error("Connection pool is closed");
    const existing = this.entries.get(server.id);
    if (existing && existing.alive) {
      this.touch(existing);
      return existing;
    }
    if (existing) this.forget(server.id);

    const connection = await connect(ctx, server, {
      connectTimeoutMs: this.options.connectTimeoutMs(),
      keepaliveIntervalMs: this.options.keepaliveIntervalMs(),
      expectedFingerprint: server.hostKey ?? null,
      ...(options.verificationCode ? { verificationCode: options.verificationCode } : {}),
    });
    const state: ConnectionState = {
      serverId: server.id,
      client: connection.client,
      fingerprint: connection.fingerprint,
      connectedAt: Date.now(),
      lastUsedAt: Date.now(),
      alive: true,
      idleTimer: null,
      sessions: new Set(),
      forwards: new Map(),
    };
    connection.client.once("close", () => {
      state.alive = false;
      state.sessions.clear();
      this.closeForwards(state);
      if (this.entries.get(server.id) === state) this.entries.delete(server.id);
    });
    connection.client.on("error", () => {
      state.alive = false;
    });
    this.entries.set(server.id, state);
    this.touch(state);
    return state;
  }

  get(serverId: string): ConnectionState | undefined {
    const state = this.entries.get(serverId);
    return state && state.alive ? state : undefined;
  }

  list(): Array<{
    serverId: string;
    fingerprint: string;
    connectedAt: string;
    idleSinceMs: number;
    sessions: string[];
    forwards: ForwardInfo[];
  }> {
    return [...this.entries.values()]
      .filter((state) => state.alive)
      .map((state) => ({
        serverId: state.serverId,
        fingerprint: state.fingerprint,
        connectedAt: new Date(state.connectedAt).toISOString(),
        idleSinceMs: Math.max(0, Date.now() - state.lastUsedAt),
        sessions: [...state.sessions],
        forwards: [...state.forwards.values()].map(({ localPort, remoteHost, remotePort }) => ({
          localPort,
          remoteHost,
          remotePort,
        })),
      }));
  }

  /** Register a listening local forward that uses this connection's channel. */
  addForward(state: ConnectionState, forward: Forward): void {
    state.forwards.set(forward.localPort, forward);
    this.touch(state);
  }

  closeForward(state: ConnectionState, localPort: number): boolean {
    const forward = state.forwards.get(localPort);
    if (!forward) return false;
    state.forwards.delete(localPort);
    try {
      forward.server.close();
    } catch {
      /* already closed */
    }
    return true;
  }

  drop(serverId: string): void {
    this.forget(serverId);
  }

  attachSession(serverId: string, session: string): void {
    const state = this.entries.get(serverId);
    if (!state) return;
    state.sessions.add(session);
    state.lastUsedAt = Date.now();
    this.clearIdle(state);
  }

  detachSession(serverId: string, session: string): void {
    const state = this.entries.get(serverId);
    if (!state) return;
    state.sessions.delete(session);
    state.lastUsedAt = Date.now();
    this.scheduleIdle(state);
  }

  async close(serverId: string): Promise<void> {
    this.forget(serverId);
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    for (const serverId of [...this.entries.keys()]) this.forget(serverId);
  }

  private touch(state: ConnectionState): void {
    state.lastUsedAt = Date.now();
    this.scheduleIdle(state);
  }

  private clearIdle(state: ConnectionState): void {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
  }

  private scheduleIdle(state: ConnectionState): void {
    const timeout = this.options.idleTimeoutMs();
    if (timeout <= 0 || state.sessions.size > 0) return;
    this.clearIdle(state);
    state.idleTimer = setTimeout(() => {
      const current = this.entries.get(state.serverId);
      if (current !== state) return;
      if (state.sessions.size > 0) return;
      this.forget(state.serverId);
    }, timeout);
    state.idleTimer.unref?.();
  }

  private closeForwards(state: ConnectionState): void {
    for (const forward of state.forwards.values()) {
      try {
        forward.server.close();
      } catch {
        /* ignore */
      }
    }
    state.forwards.clear();
  }

  private forget(serverId: string): void {
    const state = this.entries.get(serverId);
    if (!state) return;
    this.entries.delete(serverId);
    this.clearIdle(state);
    this.closeForwards(state);
    state.alive = false;
    try {
      state.client.end();
    } catch {
      /* already gone */
    }
  }
}
