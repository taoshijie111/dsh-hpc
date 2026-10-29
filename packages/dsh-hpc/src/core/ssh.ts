import { readFile } from "node:fs/promises";
import { Client, type ConnectConfig } from "ssh2";
import { createHash } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { answerPrompts, formatAuthFailure, type PromptAnswerOptions } from "./auth.js";
import { HpcError, shellQuote, type ExecResult, type ServerSpec } from "./types.js";

export { isVerificationPrompt } from "./auth.js";

/** Credential reference holding a server password (never stored in config). */
export function passwordRefFor(id: string): string {
  const clean = id.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return `MSS_${clean}_PASSWORD`;
}

export async function resolvePassword(ctx: Context, server: ServerSpec): Promise<string> {
  const refName = server.passwordRef ?? passwordRefFor(server.id);
  const hit = await ctx.credentials.resolve(credentialRef(refName));
  if (!hit || !hit.value) {
    throw new HpcError(
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
  /** One-time verification code for keyboard-interactive (2FA) prompts. */
  verificationCode?: string;
};

export async function connect(ctx: Context, server: ServerSpec, options: ConnectOptions): Promise<Connection> {
  // Resolve auth material once; each attempt reuses it.
  let password: string | undefined;
  let privateKey: Buffer | undefined;
  let passphrase: string | undefined;
  let interactiveSecret: string | undefined;
  if (server.auth === "password") {
    password = await resolvePassword(ctx, server);
    interactiveSecret = password;
  } else {
    if (!server.keyPath) throw new HpcError(`Server "${server.id}" uses key auth but has no keyPath`);
    try {
      privateKey = await readFile(server.keyPath);
    } catch (error) {
      throw new HpcError(
        `Cannot read private key for "${server.id}" at ${server.keyPath}: ${(error as Error).message}`,
      );
    }
    if (server.keyPassphraseRef) {
      const hit = await ctx.credentials.resolve(credentialRef(server.keyPassphraseRef));
      if (hit?.value) {
        passphrase = hit.value;
        interactiveSecret = hit.value;
      }
    }
  }
  const code = options.verificationCode?.trim();
  // Prompt texts observed across attempts, used for actionable auth diagnostics.
  const promptsSeen: string[] = [];

  const attempt = (passwordOverride?: string): Promise<Connection> =>
    new Promise<Connection>((resolve, reject) => {
      const client = new Client();
      let observed = "";
      let sawVerificationPrompt = false;
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
        tryKeyboard: true,
      };
      if (privateKey) connectConfig.privateKey = privateKey;
      if (passphrase) connectConfig.passphrase = passphrase;
      const effectivePassword = passwordOverride ?? password;
      if (effectivePassword !== undefined) connectConfig.password = effectivePassword;

      client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
        const result = answerPrompts(prompts, {
          ...(interactiveSecret !== undefined ? { secret: interactiveSecret } : {}),
          ...(code !== undefined ? { code } : {}),
          recordPrompt: (prompt: string) => {
            if (prompt && promptsSeen.length < 8 && !promptsSeen.includes(prompt)) promptsSeen.push(prompt);
          },
        } as PromptAnswerOptions);
        if (result.sawCodePrompt) sawVerificationPrompt = true;
        finish(result.answers);
      });

      const diagnostics = (message: string) =>
        formatAuthFailure({
          serverId: server.id,
          host: server.host,
          port: server.port ?? 22,
          message,
          promptsSeen,
          codeProvided: Boolean(code),
          sawCodePrompt: sawVerificationPrompt,
        });

      client.once("error", (error: Error) => {
        reject(new HpcError(diagnostics(error.message)));
      });
      client.once("ready", () => {
        resolve({ client, fingerprint: observed, close: () => client.end() });
      });
      client.connect(connectConfig);
    });

  try {
    return await attempt();
  } catch (firstError) {
    // Some gateways expect the one-time code appended to the password and never
    // send a keyboard-interactive prompt. Try that only when the caller provided
    // a code and the first attempt saw no prompt (never more than two attempts,
    // to avoid locking the account).
    if (!code || promptsSeen.length > 0) throw firstError;
    try {
      return await attempt(password ? `${password}${code}` : code);
    } catch (secondError) {
      throw new HpcError(
        `${(firstError as Error).message} Retried with password+code: ${(secondError as Error).message}`,
      );
    }
  }
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
    let channel: { destroy?: () => void; close?: () => void } | undefined;
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
        channel?.destroy?.();
        channel?.close?.();
      } catch {
        /* already closed */
      }
    }, options.timeoutMs);
    const onAbort = () => {
      finish({ code: null, stdout, stderr, timedOut: true, durationMs: Date.now() - started });
      try {
        channel?.destroy?.();
        channel?.close?.();
      } catch {
        /* already closed */
      }
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    client.exec(wrapped, (error, stream) => {
      if (error) {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        reject(new HpcError(`Remote command failed to start: ${error.message}`));
        return;
      }
      channel = stream;
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
        reject(new HpcError(`Remote command stream failed: ${streamError.message}`));
      });
    });
  });
}
