import { readFile } from "node:fs/promises";
import { Client, type ConnectConfig } from "ssh2";
import { createHash } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { MultiserversError, shellQuote, type ExecResult, type ServerSpec } from "./types.js";

/** Credential reference holding a server password (never stored in config). */
export function passwordRefFor(id: string): string {
  const clean = id.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return `MSS_${clean}_PASSWORD`;
}

export async function resolvePassword(ctx: Context, server: ServerSpec): Promise<string> {
  const refName = server.passwordRef ?? passwordRefFor(server.id);
  const hit = await ctx.credentials.resolve(credentialRef(refName));
  if (!hit || !hit.value) {
    throw new MultiserversError(
      `No password stored for server "${server.id}". Set credential ${refName} in the DSH credential store.`,
    );
  }
  return hit.value;
}

export function fingerprintOf(rawKey: Buffer): string {
  return `SHA256:${createHash("sha256").update(rawKey).digest("base64").replace(/=+$/, "")}`;
}

export type Connection = {
  client: Client;
  fingerprint: string;
  close(): void;
};

export type ConnectOptions = {
  connectTimeoutMs: number;
  /** TCP keepalive probe interval; 0 disables. */
  keepaliveIntervalMs?: number;
  /** Fail unless the host key matches this pinned fingerprint. */
  expectedFingerprint?: string | null;
};

export async function connect(ctx: Context, server: ServerSpec, options: ConnectOptions): Promise<Connection> {
  const client = new Client();
  let observed = "";
  const connectConfig: ConnectConfig = {
    host: server.host,
    port: server.port ?? 22,
    username: server.username,
    readyTimeout: options.connectTimeoutMs,
    keepaliveInterval: options.keepaliveIntervalMs ?? 30_000,
    hostVerifier: (rawKey: Buffer) => {
      observed = fingerprintOf(rawKey);
      const expected = options.expectedFingerprint;
      // Unknown host: accept and report (the caller decides whether to pin).
      // Changed host: refuse. This mirrors TOFU and never silently accepts drift.
      return !expected || expected === observed;
    },
  };

  if (server.auth === "password") {
    connectConfig.password = await resolvePassword(ctx, server);
  } else {
    if (!server.keyPath) throw new MultiserversError(`Server "${server.id}" uses key auth but has no keyPath`);
    try {
      connectConfig.privateKey = await readFile(server.keyPath);
    } catch (error) {
      throw new MultiserversError(
        `Cannot read private key for "${server.id}" at ${server.keyPath}: ${(error as Error).message}`,
      );
    }
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      client.removeListener("ready", onReady);
      reject(
        new MultiserversError(
          `Connection to "${server.id}" (${server.host}:${server.port ?? 22}) failed: ${error.message}`,
        ),
      );
    };
    const onReady = () => {
      client.removeListener("error", onError);
      resolve();
    };
    client.once("error", onError);
    client.once("ready", onReady);
    client.connect(connectConfig);
  });

  return { client, fingerprint: observed, close: () => client.end() };
}

/** Run a one-off command through the remote login shell with a hard timeout. */
export function execRemote(
  client: Client,
  command: string,
  options: { timeoutMs: number; cwd?: string; signal?: AbortSignal },
): Promise<ExecResult> {
  const started = Date.now();
  const wrapped = options.cwd
    ? `cd ${shellQuote(options.cwd)} && bash -lc ${shellQuote(command)}`
    : `bash -lc ${shellQuote(command)}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      finish({ code: null, stdout, stderr, timedOut, durationMs: Date.now() - started });
      try {
        client.end();
      } catch {
        /* already closed */
      }
    }, options.timeoutMs);
    const onAbort = () => {
      finish({ code: null, stdout, stderr, timedOut: true, durationMs: Date.now() - started });
      try {
        client.end();
      } catch {
        /* already closed */
      }
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    client.exec(wrapped, (error, stream) => {
      if (error) {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        reject(new MultiserversError(`Remote command failed to start: ${error.message}`));
        return;
      }
      stream.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      stream.on("close", (code: number | null) => {
        finish({ code, stdout, stderr, timedOut, durationMs: Date.now() - started });
      });
      stream.on("error", (streamError: Error) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        reject(new MultiserversError(`Remote command stream failed: ${streamError.message}`));
      });
    });
  });
}
