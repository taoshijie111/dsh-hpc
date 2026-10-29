#!/usr/bin/env node
/**
 * Large-file transfer benchmark + cancellation/resume test.
 * Env: MSS_BIG_MB (default 512), HPC_TEST_SERVER (default bare-test).
 */
import { createHash } from "node:crypto";
import { closeSync, createReadStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
const require_mkdir = (dir) => mkdirSync(dir, { recursive: true });
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as plugin from "../lib/index.js";
const __need = ["HPC_TEST_HOST_A", "HPC_TEST_USER", "HPC_TEST_PASSWORD_A", "HPC_TEST_HOST_B", "HPC_TEST_PASSWORD_B"];
if (__need.some((key) => !process.env[key])) {
  console.log(`SKIP: set ${__need.join(", ")} to run integration tests`);
  process.exit(0);
}


const sizeMb = Number(process.env.MSS_BIG_MB ?? 512);
const serverId = process.env.HPC_TEST_SERVER ?? "bare-test";

function credentialStore() {
  const file = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), ".credentials.yaml");
  const map = new Map();
  if (!existsSync(file)) return map;
  let inRefs = false;
  const text = readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (/^refs:/.test(line)) {
      inRefs = true;
      continue;
    }
    if (/^\S/.test(line) && inRefs) inRefs = false;
    if (!inRefs) continue;
    const match = /^\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (match) map.set(match[1], match[2].trim().replace(/^["']|["']$/g, ""));
  }
  return map;
}

const store = credentialStore();
const registered = new Map();
const ctx = {
  tools: { register: (d) => (registered.set(d.name, d), () => registered.delete(d.name)) },
  credentials: {
    resolve: async (ref) => {
      const name = typeof ref === "string" ? ref : (ref && (ref.name ?? ref.ref)) || String(ref);
      return store.has(name) ? { value: store.get(name) } : undefined;
    },
    describe: async () => ({ configured: true }),
    set: async () => undefined,
    unset: async () => undefined,
  },
  get: () => undefined,
  inject: (_names, callback) => callback({}),
  effect: () => {},
};
plugin.apply(ctx, {
  servers: [
    {
      id: serverId,
      host: serverId === "slurm-test" ? (process.env.HPC_TEST_HOST_A ?? "") : (process.env.HPC_TEST_HOST_B ?? ""),
      port: 22,
      username: (process.env.HPC_TEST_USER ?? ""),
      auth: "password",
      passwordRef: serverId === "slurm-test" ? "HPC_TEST_PASSWORD_A" : "HPC_TEST_PASSWORD_B",
      kind: "bare",
    },
  ],
  connectTimeoutMs: 20000,
  commandTimeoutMs: 120000,
  keepaliveIntervalMs: 30000,
  idleTimeoutMs: 600000,
  maxSessionsPerServer: 4,
  sessionIdleTimeoutMs: 1800000,
});
const call = (name, args, signal) => registered.get(name).execute(args, { signal: signal ?? new AbortController().signal });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sha = (path) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
const human = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const work = mkdtempSync(join(tmpdir(), "hpc-big-"));
const localPath = join(work, "big.bin");
const downloadDir = join(work, "download");
require_mkdir(downloadDir);
const block = Buffer.alloc(8 * 1024 * 1024, 7);
const handle = openSync(localPath, "w");
for (let index = 0; index < sizeMb / 8; index += 1) writeSync(handle, block);
closeSync(handle);
const localSha = await sha(localPath);
const localBytes = statSync(localPath).size;
console.log(`fixture: ${human(localBytes)} (${localSha.slice(0, 12)}…)`);

const home = (await call("shell_run", { server: serverId, command: 'printf %s "$HOME"' })).stdout.trim();
const base = `${home}/.hpc-big-${process.pid}`;
const remotePath = `${base}/big.bin`;
await call("shell_run", { server: serverId, command: `mkdir -p ${base}` });

try {
  // 1) cancellation: abort shortly after start
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 400);
  let cancelError = "";
  try {
    await call("upload", { server: serverId, localPath, remoteDir: base }, controller.signal);
  } catch (error) {
    cancelError = String(error.message);
  }
  check("abort cancels an in-flight upload", /cancel/i.test(cancelError), cancelError.slice(0, 60));
  const emptyPart = await call("shell_run", { server: serverId, command: `find ${base} -name '*.part' -size 0 | wc -l` });
  check("abort does not leave an empty .part", Number(emptyPart.stdout.trim()) === 0);
  await call("shell_run", { server: serverId, command: `rm -f ${remotePath}.part` });

  // 2) resume from a pre-created partial .part
  const prefix = Buffer.concat([block, block, block, block]); // 32 MB
  const prefixPath = join(work, "big.bin.part");
  writeFileSync(prefixPath, prefix);
  await call("upload", { server: serverId, localPath: prefixPath, remoteDir: base });

  // 3) full upload with adaptive chunking (resumes the .part)
  const upload = await call("upload", { server: serverId, localPath, remoteDir: base });
  check("large upload completes", upload.verified === true && upload.bytes > 0, `${human(upload.bytes)} · ${upload.durationMs} ms · ${upload.throughputMBps} MB/s`);
  check("upload resumed from the partial .part", upload.resumed === true);

  // 3) large download
  const download = await call("download", { server: serverId, remotePath, localDir: downloadDir });
  check("large download completes", download.verified === true, `${human(download.bytes)} · ${download.durationMs} ms · ${download.throughputMBps} MB/s`);
  const remoteSha = /^([0-9a-f]{64})/m.exec((await call("shell_run", { server: serverId, command: `sha256sum ${remotePath}` })).stdout)?.[1] ?? "";
  check("remote sha256 matches local", remoteSha === localSha, `${String(remoteSha).slice(0, 12)}…`);
  check("downloaded bytes match", (await sha(join(downloadDir, "big.bin"))) === localSha);

  // 4) explicit chunkSize override still works (skipped for very large fixtures)
  if (sizeMb <= 256) {
    const chunked = await call("upload", { server: serverId, localPath, remoteDir: `${base}/chunked`, chunkSize: 4 * 1024 * 1024 });
    check("explicit chunkSize accepted", chunked.verified === true, `chunk=4MB · ${chunked.throughputMBps} MB/s`);
  }

  const leftovers = await call("shell_run", { server: serverId, command: `find ${base} -name '*.part' | wc -l` });
  check("no .part leftover after resume", Number(leftovers.stdout.trim()) === 0);
} catch (error) {
  check("benchmark completed without throwing", false, error?.message ?? String(error));
} finally {
  try {
    await call("shell_run", { server: serverId, command: `rm -rf ${base}` });
  } catch {
    /* ignore */
  }
  const failed = results.filter((entry) => !entry.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
