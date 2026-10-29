#!/usr/bin/env node
/**
 * Transfer integration test with explicit parent directories:
 * single file, binary, directory tree, multiple files, overwrite guard,
 * .part resume both directions, leftovers and missing files.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as plugin from "../lib/index.js";
const __need = ["HPC_TEST_HOST_A", "HPC_TEST_USER", "HPC_TEST_PASSWORD_A", "HPC_TEST_HOST_B", "HPC_TEST_PASSWORD_B"];
if (__need.some((key) => !process.env[key])) {
  console.log(`SKIP: set ${__need.join(", ")} to run integration tests`);
  process.exit(0);
}


const serversToTest = (process.env.HPC_TEST_SERVERS ?? "wxj-94,jz").split(",").map((value) => value.trim()).filter(Boolean);

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
  servers: serversToTest.map((id) => ({
    id,
    host: id === "jz" ? (process.env.HPC_TEST_HOST_A ?? "") : (process.env.HPC_TEST_HOST_B ?? ""),
    port: 22,
    username: (process.env.HPC_TEST_USER ?? ""),
    auth: "password",
    passwordRef: id === "jz" ? "HPC_TEST_PASSWORD_A" : "HPC_TEST_PASSWORD_B",
    kind: id === "jz" ? "slurm" : "bare",
  })),
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

const work = mkdtempSync(join(tmpdir(), "hpc-xfer2-"));
const runId = `${Date.now().toString(36)}-${process.pid}`;
const local = (name) => join(work, name);

const textPayload = `single file ${runId}\n`.repeat(40);
writeFileSync(local("single.txt"), textPayload, "utf8");
const binaryPayload = randomBytes(4096);
writeFileSync(local("binary.bin"), binaryPayload);
const bigPayload = randomBytes(2 * 1024 * 1024);
writeFileSync(local("big.bin"), bigPayload);

const treeRoot = local("tree");
mkdirSync(join(treeRoot, "sub", "deep"), { recursive: true });
writeFileSync(join(treeRoot, "a.txt"), "alpha\n", "utf8");
writeFileSync(join(treeRoot, "b.txt"), "beta\n", "utf8");
writeFileSync(join(treeRoot, "sub", "c.txt"), "gamma\n", "utf8");
writeFileSync(join(treeRoot, "sub", "deep", "d.bin"), randomBytes(1024));

const cleanup = [];

try {
  for (const server of serversToTest) {
    const home = (await call("shell_run", { server, command: 'printf %s "$HOME"' })).stdout.trim();
    const base = `${home}/.hpc-xfer2-${runId}-${server}`;
    cleanup.push({ server, base });
    await call("shell_run", { server, command: `mkdir -p ${base}` });

    // single text file
    const single = await call("upload", { server, localPath: local("single.txt"), remoteDir: base });
    check(`[${server}] single text upload`, single.verified === true && single.path === `${base}/single.txt`, `bytes=${single.bytes}`);
    const singleDown = local(`single-down-${server}`);
    mkdirSync(singleDown, { recursive: true });
    await call("download", { server, remotePath: `${base}/single.txt`, localDir: singleDown });
    check(`[${server}] single text download`, readFileSync(join(singleDown, "single.txt"), "utf8") === textPayload);

    // binary
    await call("upload", { server, localPath: local("binary.bin"), remoteDir: base });
    const binaryDown = local(`binary-down-${server}`);
    mkdirSync(binaryDown, { recursive: true });
    await call("download", { server, remotePath: `${base}/binary.bin`, localDir: binaryDown });
    check(`[${server}] binary round-trip`, readFileSync(join(binaryDown, "binary.bin")).equals(binaryPayload));

    // identical re-upload skipped
    const again = await call("upload", { server, localPath: local("single.txt"), remoteDir: base });
    check(`[${server}] identical upload skipped`, again.skipped === true && again.bytes === 0);

    // directory tree into explicit parent
    const dirUp = await call("upload", { server, localPath: treeRoot, remoteDir: base });
    check(`[${server}] directory upload`, dirUp.files === 4 && dirUp.path === `${base}/tree`);
    const remoteCount = await call("shell_run", { server, command: `find ${base}/tree -type f | wc -l` });
    check(`[${server}] remote tree file count`, Number(remoteCount.stdout.trim()) === 4);
    const treeDown = local(`tree-down-${server}`);
    mkdirSync(treeDown, { recursive: true });
    const dirDown = await call("download", { server, remotePath: `${base}/tree`, localDir: treeDown });
    const downloaded = readdirSync(join(treeDown, "tree"), { recursive: true }).filter((entry) =>
      statSync(join(treeDown, "tree", entry)).isFile(),
    );
    check(`[${server}] directory download`, dirDown.path === join(treeDown, "tree") && downloaded.length === 4);
    check(
      `[${server}] nested content matches`,
      readFileSync(join(treeDown, "tree", "sub", "deep", "d.bin")).equals(readFileSync(join(treeRoot, "sub", "deep", "d.bin"))),
    );

    // several individual files into one explicit parent
    for (const name of ["one.txt", "two.txt", "three.txt"]) writeFileSync(local(name), `${name} ${runId}\n`, "utf8");
    const manyDir = local(`many-${server}`);
    mkdirSync(manyDir, { recursive: true });
    for (const name of ["one.txt", "two.txt", "three.txt"]) {
      await call("upload", { server, localPath: local(name), remoteDir: `${base}/many` });
    }
    const manyDown = await call("download", { server, remotePath: `${base}/many`, localDir: manyDir });
    check(`[${server}] multi-file download`, manyDown.path === join(manyDir, "many") && manyDown.files === 3);

    // overwrite guard using the same basename from another folder
    const altDir = local(`alt-${server}`);
    mkdirSync(altDir, { recursive: true });
    const collision = Buffer.from(readFileSync(local("single.txt")));
    collision[0] = collision[0] === 65 ? 66 : 65;
    writeFileSync(join(altDir, "single.txt"), collision);
    let guarded = false;
    try {
      await call("upload", { server, localPath: join(altDir, "single.txt"), remoteDir: base });
    } catch (error) {
      guarded = /overwrite/i.test(String(error.message));
    }
    check(`[${server}] overwrite guard`, guarded);
    const forced = await call("upload", { server, localPath: join(altDir, "single.txt"), remoteDir: base, overwrite: true });
    check(`[${server}] overwrite=true replaces`, forced.verified === true && forced.skipped === false);

    // upload resume from a remote .part (same basename staged manually)
    writeFileSync(local("big.bin.part"), bigPayload.subarray(0, 512 * 1024));
    await call("upload", { server, localPath: local("big.bin.part"), remoteDir: base });
    const resumed = await call("upload", { server, localPath: local("big.bin"), remoteDir: base });
    check(`[${server}] upload resumes from .part`, resumed.resumed === true, `bytes=${resumed.bytes}`);

    // download resume from a local .part
    const bigDownDir = local(`big-down-${server}`);
    mkdirSync(bigDownDir, { recursive: true });
    writeFileSync(join(bigDownDir, "big.bin.part"), bigPayload.subarray(0, 512 * 1024));
    const downResumed = await call("download", { server, remotePath: `${base}/big.bin`, localDir: bigDownDir });
    check(`[${server}] download resumes from local .part`, downResumed.resumed === true);
    check(`[${server}] resumed content intact`, readFileSync(join(bigDownDir, "big.bin")).equals(bigPayload));

    const leftovers = await call("shell_run", { server, command: `find ${base} -name '*.part' | wc -l` });
    check(`[${server}] no remote .part leftovers`, Number(leftovers.stdout.trim()) === 0);

    let missing = "";
    try {
      await call("download", { server, remotePath: `${base}/does-not-exist.bin`, localDir: local(`missing-${server}`) });
    } catch (error) {
      missing = String(error.message);
    }
    check(`[${server}] missing download errors clearly`, /not found/i.test(missing), missing.slice(0, 60));

    // explicit parent is required
    let missingParent = "";
    try {
      await call("upload", { server, localPath: local("single.txt") });
    } catch (error) {
      missingParent = String(error.message);
    }
    check(`[${server}] upload requires remoteDir`, /remoteDir/i.test(missingParent));
  }
} catch (error) {
  check("run completed without throwing", false, error?.message ?? String(error));
} finally {
  for (const entry of cleanup) {
    try {
      await call("shell_run", { server: entry.server, command: `rm -rf ${entry.base}` });
    } catch {
      /* ignore */
    }
  }
  const failed = results.filter((entry) => !entry.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
