#!/usr/bin/env node
/**
 * Transfer integration test: single file, directory tree, multiple files,
 * binary content, resume (.part) upload/download, overwrite guard.
 *
 * Env: MSS_TEST_SERVERS="wxj-94,jz" to override the server list.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as plugin from "../lib/index.js";

const serversToTest = (process.env.MSS_TEST_SERVERS ?? "wxj-94,jz").split(",").map((value) => value.trim()).filter(Boolean);

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

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

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

const config = {
  servers: serversToTest.map((id) => ({
    id,
    host: id === "jz" ? "114.214.255.60" : "114.214.255.94",
    port: 22,
    username: "taoshijie",
    auth: "password",
    passwordRef: id === "jz" ? "MSS_JZ_PASSWORD" : "MSS_WXJ_94_PASSWORD",
    kind: id === "jz" ? "slurm" : "bare",
  })),
  connectTimeoutMs: 20000,
  commandTimeoutMs: 120000,
  keepaliveIntervalMs: 30000,
  idleTimeoutMs: 600000,
  maxSessionsPerServer: 4,
  sessionIdleTimeoutMs: 1800000,
};
plugin.apply(ctx, config);
const call = (name, args) => registered.get(name).execute(args, { signal: new AbortController().signal });

const work = mkdtempSync(join(tmpdir(), "mss-xfer-"));
const runId = `${Date.now().toString(36)}-${process.pid}`;
const local = (name) => join(work, name);

// ---- local fixtures ----
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
    const base = `${home}/.mss-xfer-${runId}-${server}`;
    cleanup.push({ server, base });
    await call("shell_run", { server, command: `mkdir -p ${base}` });

    // 1) single text file upload
    const single = await call("upload", { server, localPath: local("single.txt"), remotePath: `${base}/single.txt` });
    check(`[${server}] single text upload`, single.verified === true && single.files === 1, `bytes=${single.bytes}`);
    const roundTrip = await call("download", { server, remotePath: `${base}/single.txt`, localPath: local(`down-${server}.txt`) });
    check(`[${server}] single text download`, roundTrip.verified === true && readFileSync(local(`down-${server}.txt`), "utf8") === textPayload);

    // 2) binary file
    const binary = await call("upload", { server, localPath: local("binary.bin"), remotePath: `${base}/binary.bin` });
    check(`[${server}] binary upload`, binary.verified === true && binary.bytes === binaryPayload.length);
    await call("download", { server, remotePath: `${base}/binary.bin`, localPath: local(`down-${server}.bin`) });
    check(`[${server}] binary download`, readFileSync(local(`down-${server}.bin`)).equals(binaryPayload));

    // 3) identical re-upload skipped
    const again = await call("upload", { server, localPath: local("single.txt"), remotePath: `${base}/single.txt` });
    check(`[${server}] identical upload skipped`, again.skipped === true && again.bytes === 0);

    // 4) multiple files: directory tree upload + download
    const dirUp = await call("upload", { server, localPath: treeRoot, remotePath: `${base}/tree` });
    check(`[${server}] directory upload`, dirUp.files === 4 && dirUp.verified === true, `files=${dirUp.files}`);
    const remoteCount = await call("shell_run", { server, command: `find ${base}/tree -type f | wc -l` });
    check(`[${server}] remote tree file count`, Number(remoteCount.stdout.trim()) === 4);
    const localTreeDown = local(`tree-down-${server}`);
    const dirDown = await call("download", { server, remotePath: `${base}/tree`, localPath: localTreeDown });
    const downloaded = readdirSync(localTreeDown, { recursive: true }).filter((entry) => statSync(join(localTreeDown, entry)).isFile());
    check(`[${server}] directory download`, dirDown.files === 4 && downloaded.length === 4, `local=${downloaded.length}`);
    check(
      `[${server}] nested content matches`,
      readFileSync(join(localTreeDown, "sub", "deep", "d.bin")).equals(readFileSync(join(treeRoot, "sub", "deep", "d.bin"))),
    );

    // 5) several individual files into one remote directory
    await call("shell_run", { server, command: `mkdir -p ${base}/many` });
    for (const name of ["one.txt", "two.txt", "three.txt"]) {
      writeFileSync(local(name), `${name} ${runId}\n`, "utf8");
    }
    const many = [];
    for (const name of ["one.txt", "two.txt", "three.txt"]) {
      many.push(await call("upload", { server, localPath: local(name), remotePath: `${base}/many/${name}` }));
    }
    check(`[${server}] three separate uploads`, many.every((entry) => entry.verified === true));
    const manyDown = await call("download", { server, remotePath: `${base}/many`, localPath: local(`many-down-${server}`) });
    check(`[${server}] multi-file download`, manyDown.files === 3, `files=${manyDown.files}`);

    // 6) overwrite guard
    const collision = Buffer.from(readFileSync(local("single.txt")));
    collision[0] = collision[0] === 65 ? 66 : 65;
    writeFileSync(local("collision.txt"), collision);
    let guarded = false;
    try {
      await call("upload", { server, localPath: local("collision.txt"), remotePath: `${base}/single.txt` });
    } catch (error) {
      guarded = /overwrite/i.test(String(error.message));
    }
    check(`[${server}] overwrite guard`, guarded);
    const forced = await call("upload", { server, localPath: local("collision.txt"), remotePath: `${base}/single.txt`, overwrite: true });
    check(`[${server}] overwrite=true replaces`, forced.verified === true && forced.skipped === false);

    // 7) upload resume from a .part file
    const prefix = bigPayload.subarray(0, 512 * 1024);
    writeFileSync(local("prefix.bin"), prefix);
    await call("upload", { server, localPath: local("prefix.bin"), remotePath: `${base}/big.bin.part` });
    const resumed = await call("upload", { server, localPath: local("big.bin"), remotePath: `${base}/big.bin` });
    check(`[${server}] upload resumes from .part`, resumed.resumed === true, `bytes=${resumed.bytes}`);
    await call("download", { server, remotePath: `${base}/big.bin`, localPath: local(`big-down-${server}.bin`) });
    check(`[${server}] resumed upload content intact`, readFileSync(local(`big-down-${server}.bin`)).equals(bigPayload));

    // 8) download resume from a local .part
    writeFileSync(local(`big2-${server}.bin.part`), prefix);
    const downResumed = await call("download", { server, remotePath: `${base}/big.bin`, localPath: local(`big2-${server}.bin`) });
    check(`[${server}] download resumes from local .part`, downResumed.resumed === true, `bytes=${downResumed.bytes}`);
    check(`[${server}] resumed download content intact`, readFileSync(local(`big2-${server}.bin`)).equals(bigPayload));

    // 9) no .part leftovers on the remote side
    const leftovers = await call("shell_run", { server, command: `find ${base} -name '*.part' | wc -l` });
    check(`[${server}] no remote .part leftovers`, Number(leftovers.stdout.trim()) === 0);

    // 10) missing remote file is a clear error
    let missing = "";
    try {
      await call("download", { server, remotePath: `${base}/does-not-exist.bin`, localPath: local("nope.bin") });
    } catch (error) {
      missing = String(error.message);
    }
    check(`[${server}] missing download errors clearly`, /not found/i.test(missing), missing.slice(0, 60));
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
