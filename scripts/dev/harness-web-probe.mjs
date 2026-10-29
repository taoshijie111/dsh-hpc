#!/usr/bin/env node
/**
 * S1-b probe: can we learn a harness's native web UI address without tmux?
 *
 * Spawns the harness web command, reads piped stdio, extracts the address line,
 * then shuts it down. Read-only outside the harness's own data directory.
 *
 * Usage: node scripts/dev/harness-web-probe.mjs dsh|kimi
 */
import { spawn } from "node:child_process";

const which = process.argv[2] ?? "dsh";
const spec =
  which === "dsh"
    ? { command: "dsh", args: ["--profile", "web", "--no-open", "--port", "0"] }
    : { command: "kimi", args: ["web", "--port", "0"] };

const PREFIX = /(?:dsh web|kimi web|Local|Listening|http)[^\n]*/i;
const URL_RE = /http:\/\/127\.0\.0\.1:(\d{1,5})\/?(?:\?token=([A-Za-z0-9_-]+))?/g;
const TOKEN_RE = /(?:token|bearer)[^\n]{0,160}/i;

let out = "";
let err = "";
const child = spawn(spec.command, spec.args, {
  shell: process.platform === "win32",
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
});

const started = Date.now();
const seen = [];
let done = false;

function finish(reason) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  const urls = [...out.matchAll(URL_RE)].map((m) => ({ port: Number(m[1]), token: m[2] ?? null }));
  console.log(
    JSON.stringify(
      {
        harness: which,
        reason,
        elapsedMs: Date.now() - started,
        urls,
        addressLine: (out.match(PREFIX) ?? [])[0] ?? null,
        tokenHint: (out + err).match(TOKEN_RE)?.[0] ?? null,
        stdoutSample: out.slice(0, 1200),
        stderrSample: err.slice(0, 800),
      },
      null,
      2,
    ),
  );
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(0), 300);
}

const timer = setTimeout(() => finish("timeout"), 45_000);

child.stdout.on("data", (chunk) => {
  out += chunk.toString("utf8");
  if (URL_RE.test(out)) {
    URL_RE.lastIndex = 0;
    finish("address-found");
  }
  URL_RE.lastIndex = 0;
});
child.stderr.on("data", (chunk) => {
  err += chunk.toString("utf8");
  seen.push(chunk.toString("utf8").slice(0, 200));
});
child.on("error", (error) => {
  err += `\n[spawn error] ${error.message}`;
  finish("spawn-error");
});
child.on("exit", (code) => finish(`exited:${code}`));
