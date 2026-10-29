#!/usr/bin/env node
/** Explicit parent-directory semantics for upload/download/transfer_queue. */
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
ctx();
function ctx() {
  globalThis.__ctx = {
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
}
plugin.apply(globalThis.__ctx, {
  servers: [
    {
      id: serverId,
      host: (process.env.HPC_TEST_HOST_B ?? ""),
      port: 22,
      username: (process.env.HPC_TEST_USER ?? ""),
      auth: "password",
      passwordRef: "HPC_TEST_PASSWORD_B",
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

const work = mkdtempSync(join(tmpdir(), "hpc-parent-"));
const runId = `${Date.now().toString(36)}`;
writeFileSync(join(work, "single.txt"), `single ${runId}\n`);
const pkg = join(work, "pkg");
mkdirSync(join(pkg, "nested"), { recursive: true });
writeFileSync(join(pkg, "nested", "x.txt"), "nested\n");

const home = (await call("shell_run", { server: serverId, command: 'printf %s "$HOME"' })).stdout.trim();
const base = `${home}/.hpc-parent-${runId}`;
const localOut = join(work, "out");
mkdirSync(localOut, { recursive: true });

try {
  // upload file into an explicit (not yet existing) remote parent directory
  const upFile = await call("upload", { server: serverId, localPath: join(work, "single.txt"), remoteDir: `${base}/dirs/first` });
  check(
    "upload file uses remoteDir + basename",
    upFile.path === `${base}/dirs/first/single.txt` && upFile.verified === true,
    upFile.path,
  );

  // upload directory into an explicit parent directory
  const upDir = await call("upload", { server: serverId, localPath: pkg, remoteDir: `${base}/dirs` });
  check("upload directory appends its basename", upDir.path === `${base}/dirs/pkg`, upDir.path);
  const count = await call("shell_run", { server: serverId, command: `find ${base}/dirs -type f | wc -l` });
  check("uploaded tree complete", Number(count.stdout.trim()) === 2);

  // download file into an explicit local parent directory
  const downFile = await call("download", { server: serverId, remotePath: `${base}/dirs/first/single.txt`, localDir: localOut });
  const downFileBasename = join(localOut, "single.txt");
  check(
    "download file uses localDir + basename",
    downFile.path === downFileBasename && readFileSync(downFileBasename, "utf8") === `single ${runId}\n`,
  );

  // download directory into an explicit local parent directory
  const downDir = await call("download", { server: serverId, remotePath: `${base}/dirs/pkg`, localDir: localOut });
  check("download directory appends its basename", downDir.path === join(localOut, "pkg"), downDir.path);
  check("downloaded tree complete", readFileSync(join(localOut, "pkg", "nested", "x.txt"), "utf8") === "nested\n");

  // queue uses source + targetDir
  const queue = await call("transfer_queue", {
    server: serverId,
    direction: "upload",
    background: false,
    items: JSON.stringify([
      { source: join(work, "single.txt"), targetDir: `${base}/queue/one` },
      { source: pkg, targetDir: `${base}/queue/two` },
    ]),
  });
  check("queue upload targetDir semantics", queue.failed === 0 && queue.files === 2, `files=${queue.files}`);

  // a full destination path without the parent parameter is rejected
  let legacyRejected = "";
  try {
    await call("upload", { server: serverId, localPath: join(work, "single.txt"), remotePath: `${base}/legacy/name.txt` });
  } catch (error) {
    legacyRejected = String(error.message);
  }
  check("upload without remoteDir is rejected", /remoteDir/.test(legacyRejected));

  // missing parent parameter is rejected clearly
  let missing = "";
  try {
    await call("upload", { server: serverId, localPath: join(work, "single.txt") });
  } catch (error) {
    missing = String(error.message);
  }
  check("missing remoteDir is rejected", /remoteDir/.test(missing), missing.slice(0, 60));
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
