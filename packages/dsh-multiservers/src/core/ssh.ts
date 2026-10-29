import { readFile } from "node:fs/promises";
import { Client, type ConnectConfig, type SFTPWrapper } from "ssh2";
import { createHash } from "node:crypto";
import { MultiserversError, shellQuote, type Config, type ExecResult, type ServerSpec } from "./types.js";
import type { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";

/** `<owner>/<id>` credential record; we keep passwords in the DSH credential store. */
export function passwordRefFor(id: string): string {
  const clean = id.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return `MSS_${clean}_PASSWORD`;
}

export async function resolvePassword(ctx: Context, server: ServerSpec): Promise<string> {
  const refName = server.passwordRef ?? passwordRefFor(server.id);
  const hit = await ctx.credentials.resolve(credentialRef(refName));
  if (!hit || !hit.value) {
    throw new MultiserversError(
      `No password stored for server "${server.id}". Set credential ${refName} (the DSH credential store, same place provider API keys live).`,
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
  /** Fail unless the host key matches this pinned fingerprint. */
  expectedFingerprint?: string | null;
};

export async function connect(
  ctx: Context,
  server: ServerSpec,
  options: ConnectOptions,
): Promise<Connection> {
  const client = new Client();
  let observed = "";
  const connectConfig: ConnectConfig = {
    host: server.host,
    port: server.port ?? 22,
    username: server.username,
    readyTimeout: options.connectTimeoutMs,
    keepaliveInterval: 15_000,
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
    const onError = (error: Error & { level?: string }) => {
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

  return {
    client,
    fingerprint: observed,
    close: () => client.end(),
  };
}

/** Run a command through the remote login shell with a hard timeout. */
export function execRemote(
  connection: Connection,
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
        connection.client.end();
      } catch {
        /* already closed */
      }
    }, options.timeoutMs);
    const onAbort = () => {
      finish({ code: null, stdout, stderr, timedOut: true, durationMs: Date.now() - started });
      try {
        connection.client.end();
      } catch {
        /* already closed */
      }
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    connection.client.exec(wrapped, (error, stream) => {
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

function sftpOf(connection: Connection): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    connection.client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp)));
  });
}

export type RemoteEntry = {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  mode: number;
  modifiedAt: string | null;
  linkTarget?: string;
};

type RawEntry = { filename: string; longname: string; attrs: Record<string, unknown> };

export async function listDirectory(connection: Connection, path: string): Promise<RemoteEntry[]> {
  const sftp = await sftpOf(connection);
  const entries = await new Promise<RawEntry[]>((resolve, reject) => {
    sftp.readdir(path, (error, list) => (error ? reject(error) : resolve(list as unknown as RawEntry[])));
  });
  return entries
    .map((entry) => {
      const attrs = entry.attrs as {
        mode?: number;
        size?: number;
        mtime?: number;
        isDirectory?: () => boolean;
        isFile?: () => boolean;
        isSymbolicLink?: () => boolean;
      };
      const mode = attrs.mode ?? 0;
      const type = attrs.isDirectory?.()
        ? "directory"
        : attrs.isSymbolicLink?.()
          ? "symlink"
          : attrs.isFile?.()
            ? "file"
            : "other";
      const linkTarget = type === "symlink" ? entry.longname.split(" -> ")[1] : undefined;
      return {
        name: entry.filename,
        type,
        size: attrs.size ?? 0,
        mode,
        modifiedAt: attrs.mtime ? new Date(attrs.mtime * 1000).toISOString() : null,
        ...(linkTarget ? { linkTarget } : {}),
      } as RemoteEntry;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function statPath(connection: Connection, path: string): Promise<RemoteEntry> {
  const sftp = await sftpOf(connection);
  const stats = await new Promise<Record<string, unknown>>((resolve, reject) => {
    sftp.stat(path, (error, value) => (error ? reject(error) : resolve(value as never)));
  });
  const attrs = stats as {
    mode?: number;
    size?: number;
    mtime?: number;
    isDirectory?: () => boolean;
    isFile?: () => boolean;
  };
  const type = attrs.isDirectory?.() ? "directory" : attrs.isFile?.() ? "file" : "other";
  return {
    name: path.split("/").pop() || path,
    type,
    size: attrs.size ?? 0,
    mode: attrs.mode ?? 0,
    modifiedAt: attrs.mtime ? new Date(attrs.mtime * 1000).toISOString() : null,
  };
}

export async function makeDirectory(connection: Connection, path: string, recursive: boolean): Promise<void> {
  const sftp = await sftpOf(connection);
  if (!recursive) {
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(path, (error) => (error ? reject(error) : resolve()));
    });
    return;
  }
  const parts = path.split("/").filter(Boolean);
  let current = path.startsWith("/") ? "" : ".";
  for (const part of parts) {
    current = `${current}/${part}`;
    await new Promise<void>((resolve) => {
      sftp.mkdir(current, () => resolve());
    });
  }
}

export async function removePath(connection: Connection, path: string, recursive: boolean): Promise<void> {
  if (!path.startsWith("/")) throw new MultiserversError(`Refusing to remove a relative path: ${path}`);
  const command = recursive ? `rm -rf -- ${shellQuote(path)}` : `rm -f -- ${shellQuote(path)}`;
  const result = await execRemote(connection, command, { timeoutMs: 60_000 });
  if (result.code !== 0) throw new MultiserversError(`Remove failed (exit ${result.code}): ${result.stderr.trim()}`);
}

export async function uploadFile(connection: Connection, localPath: string, remotePath: string): Promise<void> {
  const sftp = await sftpOf(connection);
  await new Promise<void>((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (error) => (error ? reject(error) : resolve()));
  });
}

export async function downloadFile(connection: Connection, remotePath: string, localPath: string): Promise<void> {
  const sftp = await sftpOf(connection);
  await new Promise<void>((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, (error) => (error ? reject(error) : resolve()));
  });
}
