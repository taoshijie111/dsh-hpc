#!/usr/bin/env node
/**
 * S0 endpoint probe (read-only).
 *
 * Purpose: verify the "connect + exec" primitive of the future core against a real
 * host, and collect an endpoint profile without installing anything remotely.
 *
 * Credentials come from the environment only and are never written to disk:
 *   SSH_HOST, SSH_PORT (default 22), SSH_USER, SSH_PASS (or SSH_KEY_PATH)
 *
 * Every command below is read-only. Nothing is created, modified or deleted on
 * the remote host.
 */
import { createHash } from "node:crypto";
import ssh2 from "ssh2";

const { Client } = ssh2;

const host = process.env.SSH_HOST;
const port = Number(process.env.SSH_PORT ?? 22);
const username = process.env.SSH_USER;
const password = process.env.SSH_PASS;
const keyPath = process.env.SSH_KEY_PATH;

if (!host || !username || (!password && !keyPath)) {
  console.error("missing SSH_HOST / SSH_USER / (SSH_PASS or SSH_KEY_PATH)");
  process.exit(2);
}

/** Read-only commands. Each entry is [label, command]. */
const PROBES = [
  ["identity", "hostname; uname -srm"],
  ["os", "cat /etc/os-release 2>/dev/null | head -3"],
  ["cpu_mem", "nproc 2>/dev/null; free -g 2>/dev/null | head -2"],
  [
    "tools",
    'for c in sbatch squeue sacct scancel sinfo scontrol qsub qstat tmux rsync python3 conda module docker singularity apptainer; do printf "%s=" "$c"; command -v "$c" 2>/dev/null || echo MISSING; done',
  ],
  ["rsync_version", "rsync --version 2>/dev/null | head -1"],
  ["storage", "df -h 2>/dev/null | head -12"],
  ["home", 'echo "HOME=$HOME"; echo "SHELL=$SHELL"; echo "USER=$(id -un)"'],
  ["quota", "quota -s 2>/dev/null | head -6 || true"],
];

function fingerprint(rawKey) {
  return `SHA256:${createHash("sha256").update(rawKey).digest("base64").replace(/=+$/, "")}`;
}

function execOnce(conn, command, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ code: null, out, err: `${err}\n[timeout ${timeoutMs}ms]` });
      }
    }, timeoutMs);
    conn.exec(command, (error, stream) => {
      if (error) {
        clearTimeout(timer);
        settled = true;
        resolve({ code: null, out: "", err: String(error.message) });
        return;
      }
      stream.on("data", (chunk) => {
        out += chunk.toString("utf8");
      });
      stream.stderr.on("data", (chunk) => {
        err += chunk.toString("utf8");
      });
      stream.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, out, err });
      });
    });
  });
}

const conn = new Client();
const started = Date.now();
let observedFingerprint = null;

const connectOptions = {
  host,
  port,
  username,
  readyTimeout: 20_000,
  // S0 only: accept-and-record so the operator can pin the key on the next run.
  // The product will refuse unknown keys (NFR-1).
  hostVerifier: (rawKey) => {
    observedFingerprint = fingerprint(rawKey);
    return true;
  },
  ...(password ? { password } : { privateKey: await import("node:fs").then((fs) => fs.readFileSync(keyPath)) }),
};

conn.on("ready", async () => {
  const banner = {
    host,
    port,
    username,
    connectedInMs: Date.now() - started,
    hostKeyFingerprint: observedFingerprint,
    transport: conn._sock?.getProtocol?.() ?? null,
  };

  const results = {};
  for (const [label, command] of PROBES) {
    const result = await execOnce(conn, command);
    results[label] = result;
  }

  const profile = buildProfile(results);
  console.log(JSON.stringify({ banner, profile, raw: results }, null, 2));
  conn.end();
});

conn.on("error", (error) => {
  console.log(JSON.stringify({ error: error.message, code: error.code ?? null }, null, 2));
  process.exit(1);
});

conn.connect(connectOptions);

/** Turn raw command output into a coarse endpoint profile (no scheduler assumptions). */
function buildProfile(results) {
  const toolsText = results.tools?.out ?? "";
  const tools = Object.fromEntries(
    toolsText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, value] = line.split("=");
        return [name, !value || value === "MISSING" ? null : value];
      }),
  );

  const schedulers = ["sbatch", "qsub", "bsub", "qstat"].filter((name) => tools[name]);
  return {
    platform: results.identity?.out?.split("\n")[1]?.trim() ?? null,
    schedulers,
    schedulerFlavor:
      tools.sbatch ? "slurm" : tools.qsub ? "pbs-or-torque" : tools.bsub ? "lsf" : "none-detected",
    transfer: { rsyncAvailable: Boolean(tools.rsync), sftpAssumed: true },
    interactive: { tmux: Boolean(tools.tmux) },
    runtimes: {
      python3: Boolean(tools.python3),
      conda: Boolean(tools.conda),
      singularity: Boolean(tools.singularity || tools.apptainer),
      docker: Boolean(tools.docker),
    },
    moduleSystem: Boolean(tools.module),
    probeCompletedAt: new Date().toISOString(),
  };
}
