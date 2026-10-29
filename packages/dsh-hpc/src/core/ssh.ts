import { readFile } from "node:fs/promises";
import { Client, type ConnectConfig } from "ssh2";
import { createHash } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { HpcError, shellQuote, type ExecResult, type ServerSpec } from "./types.js";

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

/** True when a keyboard-interactive prompt asks for a one-time verification code. */
export function isVerificationPrompt(prompt: string): boolean {
  const codeSignal =
    /(verification|one[- ]?time|otp|authenticator|passcode|dynamic|token|code|验证码|动态码|动态|令牌)/i.test(prompt);
  // "One-time password" is a code prompt; a plain password/passphrase prompt is not.
  const passwordSignal = /password|passphrase|密码/i.test(prompt) && !/one[- ]?time/i.test(prompt);
  return codeSignal && !passwordSignal;
}

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

  let interactiveSecret: string | undefined;
  if (server.auth === "password") {
    connectConfig.password = await resolvePassword(ctx, server);
    interactiveSecret = connectConfig.password;
  } else {
    if (!server.keyPath) throw new HpcError(`Server "${server.id}" uses key auth but has no keyPath`);
    try {
      connectConfig.privateKey = await readFile(server.keyPath);
    } catch (error) {
      throw new HpcError(
        `Cannot read private key for "${server.id}" at ${server.keyPath}: ${(error as Error).message}`,
      );
    }
    if (server.keyPassphraseRef) {
      const hit = await ctx.credentials.resolve(credentialRef(server.keyPassphraseRef));
      if (hit?.value) {
        connectConfig.passphrase = hit.value;
        interactiveSecret = hit.value;
      }
    }
  }
  // Keyboard-interactive servers: answer password/passphrase prompts with the
  // stored secret and verification-code prompts with the caller-supplied code.
  connectConfig.tryKeyboard = true;
  let sawVerificationPrompt = false;
  client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
    const answers = prompts.map((rawPrompt: unknown) => {
      const prompt = typeof rawPrompt === "string" ? rawPrompt : String((rawPrompt as { prompt?: string })?.prompt ?? "");
      if (isVerificationPrompt(prompt)) {
        sawVerificationPrompt = true;
        return options.verificationCode ?? interactiveSecret ?? "";
      }
      return interactiveSecret ?? "";
    });
    finish(answers);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      client.removeListener("ready", onReady);
      const twoFactorHint =
        sawVerificationPrompt && !options.verificationCode
          ? ` Server "${server.id}" asks for one-time verification code (2FA): ask the user for the current 6-digit code, then retry with server_connect(server: "${server.id}", otp: "<code>").`
          : "";
      reject(
        new HpcError(
          `Connection to "${server.id}" (${server.host}:${server.port ?? 22}) failed: ${error.message}.${twoFactorHint}`,
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
