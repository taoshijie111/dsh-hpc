#!/usr/bin/env node
/**
 * Transfer queue test: batch upload/download, failure policy, background fallback.
 * Runs foreground by default because the harness has no DSH job registry.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as plugin from "../lib/index.js";
const __need = ["HPC_TEST_HOST_A", "HPC_TEST_USER", "HPC_TEST_PASSWORD_A", "HPC_TEST_HOST_B", "HPC_TEST_PASSWORD_B"];
if (__need.some((key) => !process.env[key])) {
  console.log(`SKIP: set ${__need.join(", ")} to run integration tests`);
  process.exit(0);
}


const serverId = process.env.HPC_TEST_SERVER ?? "bare-test";

function credentialStore() {
  const file = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), ".credentials.yaml");
  const map = new Map();
  if (!existsSync(file)) return map;
  let inRefs = false;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
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
const call = (name, args) => registered.get(name).execute(args, { signal: new AbortController().signal });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const work = mkdtempSync(join(tmpdir(), "hpc-queue-"));
const runId = `${Date.now().toString(36)}`;
const files = ["a.txt", "b.txt", "c.txt"];
const dir = join(work, "pkg");
mkdirSync(join(dir, "nested"), { recursive: true });
writeFileSync(join(dir, "nested", "d.bin"), Buffer.alloc(2048, 5));
for (const name of files) writeFileSync(join(work, name), `${name} ${runId}\n`);

const home = (await call("shell_run", { server: serverId, command: 'printf %s "$HOME"' })).stdout.trim();
const base = `${home}/.hpc-queue-${runId}`;
await call("shell_run", { server: serverId, command: `mkdir -p ${base}` });

try {
  // 1) upload queue: three files + one directory
  const uploadItems = [
    ...files.map((name) => ({ source: join(work, name), targetDir: base })),
    { source: dir, targetDir: base },
    { source: join(work, "a.txt"), targetDir: `${base}/newdir/deep` },
  ];
  const upload = await call("transfer_queue", { server: serverId, direction: "upload", items: JSON.stringify(uploadItems), background: false });
  check("queue upload completes all items", upload.failed === 0 && upload.items.filter((entry) => entry.ok).length === 5, `files=${upload.files}`);
  const remoteFiles = await call("shell_run", { server: serverId, command: `find ${base} -type f | wc -l` });
  check("remote has 3 files + 2 nested + new dir", Number(remoteFiles.stdout.trim()) === 5);

  // 2) download queue into separate directories
  const downDir = join(work, "down");
  const downloadItems = [
    ...files.map((name) => ({ source: `${base}/${name}`, targetDir: downDir })),
    { source: `${base}/pkg`, targetDir: downDir },
  ];
  const download = await call("transfer_queue", { server: serverId, direction: "download", items: JSON.stringify(downloadItems), background: false });
  check("queue download completes all items", download.failed === 0, `files=${download.files}`);
  check("downloaded content matches", readFileSync(join(downDir, "a.txt"), "utf8") === `a.txt ${runId}\n`);
  check("downloaded directory matches", readFileSync(join(downDir, "pkg", "nested", "d.bin")).length === 2048);

  // 3) continueOnError=true keeps going after a bad item
  const mixed = [
    { source: join(work, "missing.txt"), targetDir: base },
    ...files.map((name) => ({ source: join(work, name), targetDir: `${base}/retry` })),
  ];
  const tolerant = await call("transfer_queue", { server: serverId, direction: "upload", items: JSON.stringify(mixed), background: false });
  check("continueOnError keeps going", tolerant.failed === 1 && tolerant.items.filter((entry) => entry.ok).length === 3);

  // 4) continueOnError=false stops at the first failure
  const strict = await call("transfer_queue", {
    server: serverId,
    direction: "upload",
    items: JSON.stringify(mixed),
    continueOnError: false,
    background: false,
  });
  check("continueOnError=false stops early", strict.failed === 1 && strict.items.length === 1, `items=${strict.items.length}`);

  // 5) background requested without a job registry falls back to foreground
  const fallback = await call("transfer_queue", { server: serverId, direction: "upload", items: JSON.stringify([{ source: join(work, "a.txt"), targetDir: base }]) });
  check("background falls back to foreground without registry", fallback.background === undefined && fallback.failed === 0);

  // 6) invalid JSON is rejected clearly
  let invalid = "";
  try {
    await call("transfer_queue", { server: serverId, direction: "upload", items: "not-json", background: false });
  } catch (error) {
    invalid = String(error.message);
  }
  check("invalid items JSON is rejected", /items must be a JSON array/i.test(invalid), invalid.slice(0, 60));
} catch (error) {
  check("run completed without throwing", false, error?.message ?? String(error));
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
