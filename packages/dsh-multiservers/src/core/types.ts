/** Shared shapes for the plugin's host half. */

export type AuthMode = "password" | "key";

export interface ServerSpec {
  /** Stable id used by tools; `[a-z0-9-]`. */
  id: string;
  label?: string;
  host: string;
  /** Defaults to 22. */
  port?: number;
  username: string;
  auth: AuthMode;
  /** Credential reference name (POSIX identifier) holding the password. */
  passwordRef?: string;
  /** Local private key path, for `auth: "key"`. */
  keyPath?: string;
  /** Pinned host key fingerprint, e.g. `SHA256:...`. Empty means first use pins it. */
  hostKey?: string;
}

export interface Config {
  servers: ServerSpec[];
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  /** TCP keepalive probe interval; 0 disables. */
  keepaliveIntervalMs?: number;
  /** Idle connection reaping; 0 keeps connections open until explicit logout. */
  idleTimeoutMs?: number;
  /** Named sessions allowed per server. */
  maxSessionsPerServer?: number;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export class MultiserversError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MultiserversError";
  }
}

/** Namespace/id of this plugin's Loader entry; settings writes address it. */
export const PLUGIN_ID = "multiservers";

export function findServer(config: Config, id: string): ServerSpec {
  const server = config.servers.find((entry) => entry.id === id);
  if (!server) {
    const known = config.servers.map((entry) => entry.id).join(", ") || "(none)";
    throw new MultiserversError(`Unknown server "${id}". Configured servers: ${known}`);
  }
  return server;
}

/** POSIX shell single-quote escaping; every remote command is built from this. */
export function shellQuote(value: string): string {
  if (value === "") return "''";
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
