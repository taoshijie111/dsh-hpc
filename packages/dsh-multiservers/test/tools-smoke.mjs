#!/usr/bin/env node
/** v3 tool-surface integration test against a real host. */
import { homedir, tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect as netConnect } from "node:net";
import * as plugin from "../lib/index.js";

const host = process.env.MSS_TEST_HOST ?? "114.214.255.60";
const user = process.env.MSS_TEST_USER ?? "taoshijie";
const home = `/public/home/${user}`;
const keyPath = process.env.MSS_TEST_KEY ?? join(homedir(), ".ssh", "id_ed25519");
const hostKey = process.env.MSS_TEST_HOSTKEY ?? "SHA256:RdHHL8XKm28DrTNlHdu9NhY+o5qzf8Dr5V/9AbardOI";

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const registered = new Map();
const effects = [];
const ctx = {
  tools: { register: (d) => (registered.set(d.name, d), () => registered.delete(d.name)) },
  credentials: {
    resolve: async () => undefined,
    describe: async () => ({ configured: false }),
    set: async () => undefined,
    unset: async () => undefined,
  },
  get: () => undefined,
  inject: (_names, cb) => cb({}),
  effect(fn) {
    const dispose = fn();
    if (typeof dispose === "function") effects.push(dispose);
    return dispose;
  },
};
const config = {
  servers: [{ id: "hpc1", label: "Test HPC", host, port: 22, username: user, auth: "key", keyPath, hostKey }],
  connectTimeoutMs: 20000,
  commandTimeoutMs: 60000,
  keepaliveIntervalMs: 30000,
  idleTimeoutMs: 600000,
  maxSessionsPerServer: 4,
  sessionIdleTimeoutMs: 1800000,
};
plugin.apply(ctx, config);
const call = (name, args) => {
  const d = registered.get(name);
  if (!d) throw new Error(`tool ${name} missing`);
  return d.execute(args, { signal: new AbortController().signal });
};

const work = mkdtempSync(join(tmpdir(), "mss-v3-"));
const localUp = join(work, "up.txt");
const localDown = join(work, "down.txt");
const dirUp = join(work, "tree");
mkdirSync(join(dirUp, "sub"), { recursive: true });
writeFileSync(join(dirUp, "a.txt"), "alpha\n", "utf8");
writeFileSync(join(dirUp, "sub", "b.txt"), "beta\n", "utf8");
const payload = `v3 ${new Date().toISOString()}\n`.repeat(3);
writeFileSync(localUp, payload, "utf8");
const remoteFile = `${home}/.mss-v3-${process.pid}.txt`;
const remoteDir = `${home}/.mss-v3-tree-${process.pid}`;
const localDirDown = join(work, "tree-down");

try {
  check("10 tools registered", registered.size === 10, `count=${registered.size}`);
  check("merged tools are gone", ["server_status", "session_list", "shell_open", "server_probe", "server_connect"].every((n) => !registered.has(n)));
  check("command wrappers are gone", ["run", "ls", "stat", "mkdir", "rm"].every((n) => !registered.has(n)));

  const before = await call("server_list", {});
  check("server_list reports disconnected state", before.servers[0].connected === false);

  const test = await call("server_test", { server: "hpc1", profile: true });
  check("server_test connects and profiles", test.reachable === true && test.profile?.schedulers?.includes("sbatch"), `${test.latencyMs}ms`);
  const after = await call("server_list", {});
  check("server_list merges runtime state", after.servers[0].connected === true);

  await call("shell_run", { server: "hpc1", command: "cd /tmp" });
  const pwd = await call("shell_run", { server: "hpc1", command: "pwd" });
  check("shell_run auto-creates a sticky session", pwd.stdout.trim() === "/tmp", pwd.stdout.trim());

  const buildPwd = await call("shell_run", { server: "hpc1", session: "build", command: "pwd" });
  check("named sessions isolate cwd", buildPwd.stdout.trim() === home);

  const big = await call("shell_run", { server: "hpc1", command: "head -c 300000 /dev/zero | tr '\\0' x", maxBytes: 4096 });
  check("shell_run truncates large output", big.truncated === true && big.stdout.length < 5000, `chars=${big.stdout.length}`);

  const up = await call("upload", { server: "hpc1", localPath: localUp, remotePath: remoteFile });
  check("upload verifies and stages atomically", up.verified === true && up.files === 1, `bytes=${up.bytes}`);
  const part = await call("shell_run", { server: "hpc1", command: `test -e ${remoteFile}.part || echo NOPART` });
  check("no .part file remains after upload", part.stdout.includes("NOPART"));

  const again = await call("upload", { server: "hpc1", localPath: localUp, remotePath: remoteFile });
  check("identical re-upload is skipped", again.skipped === true && again.bytes === 0);

  const dirUpResult = await call("upload", { server: "hpc1", localPath: dirUp, remotePath: remoteDir });
  check("directory upload transfers every file", dirUpResult.files === 2, `files=${dirUpResult.files}`);
  const count = await call("shell_run", { server: "hpc1", command: `find ${remoteDir} -type f | wc -l` });
  check("remote directory matches", Number(count.stdout.trim()) === 2, count.stdout.trim());

  const dirDown = await call("download", { server: "hpc1", remotePath: remoteDir, localPath: localDirDown });
  check("directory download transfers every file", dirDown.files === 2 && readFileSync(join(localDirDown, "sub", "b.txt"), "utf8") === "beta\n");

  const down = await call("download", { server: "hpc1", remotePath: remoteFile, localPath: localDown });
  check("single download verifies", down.verified === true && readFileSync(localDown, "utf8") === payload);

  const forward = await call("forward", { server: "hpc1", remoteHost: "127.0.0.1", remotePort: 22, localPort: 0 });
  const banner = await new Promise((resolve) => {
    const socket = netConnect(forward.localPort, "127.0.0.1");
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      socket.destroy();
      resolve(data);
    });
    socket.on("error", () => resolve(""));
    setTimeout(() => resolve(data), 5000);
  });
  check("forward tunnels a TCP connection", banner.startsWith("SSH-"), JSON.stringify(banner.slice(0, 20)));
  const closed = await call("forward", { server: "hpc1", localPort: forward.localPort, close: true });
  check("forward can be closed", closed.closed === true);

  await call("shell_run", { server: "hpc1", command: `rm -f ${remoteFile}; rm -rf ${remoteDir}` });
  const disconnect = await call("server_disconnect", { server: "hpc1" });
  const finalList = await call("server_list", {});
  check("disconnect clears connection", disconnect.disconnected === true && finalList.servers[0].connected === false);
} catch (error) {
  check("run completed without throwing", false, error?.message ?? String(error));
} finally {
  for (const dispose of effects.reverse()) {
    try {
      dispose();
    } catch {
      /* ignore */
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
