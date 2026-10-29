#!/usr/bin/env node
/**
 * Tool-surface integration test (real host) for dsh-multiservers v2.
 *
 * Covers the v1.3 contract: pooled connection, named sticky sessions, server
 * management, and SFTP transfer with resume/skip + sha256 verification.
 *
 * Env overrides: MSS_TEST_HOST, MSS_TEST_USER, MSS_TEST_KEY, MSS_TEST_HOSTKEY.
 */
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  tools: {
    register(definition) {
      registered.set(definition.name, definition);
      return () => registered.delete(definition.name);
    },
  },
  credentials: {
    resolve: async () => undefined,
    describe: async () => ({ configured: false }),
    set: async () => undefined,
    unset: async () => undefined,
  },
  get: () => undefined,
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
};

plugin.apply(ctx, config);
const call = (name, args) => {
  const definition = registered.get(name);
  if (!definition) throw new Error(`tool ${name} was not registered`);
  return definition.execute(args, { signal: new AbortController().signal });
};

const work = mkdtempSync(join(tmpdir(), "mss-tools-"));
const localUp = join(work, "up.txt");
const localDown = join(work, "down.txt");
const remotePath = `${home}/.mss-tools-${process.pid}.txt`;
const payload = `multiservers v2 ${new Date().toISOString()}\n`.repeat(4);
writeFileSync(localUp, payload, "utf8");

try {
  check("registers the v2 tool surface (14 tools)", registered.size === 14, `registered=${registered.size}`);

  const list = await call("server_list", {});
  check("server_list returns the configured host", list.servers.length === 1 && list.servers[0].host === host);

  const test = await call("server_test", { server: "hpc1" });
  check("server_test reaches the host", test.reachable === true, `latency=${test.latencyMs}ms`);
  check("pinned host key matches", test.hostKeyMatches === true, test.hostKeyFingerprint);

  const connect = await call("server_connect", { server: "hpc1" });
  check("server_connect reuses the pooled connection", connect.connected === true && connect.latencyMs < 1000, `${connect.latencyMs}ms`);

  const probe = await call("server_probe", { server: "hpc1" });
  check(
    "server_probe detects Linux + Slurm + rsync",
    String(probe.platform ?? "").includes("Linux") &&
      (probe.schedulers ?? []).includes("sbatch") &&
      Boolean(probe.tools?.rsync),
    `${probe.platform} | ${JSON.stringify(probe.schedulers)}`,
  );

  const status = await call("server_status", {});
  check("server_status reports one connection", status.connections.length === 1);
  check("removed fs tools are gone", ["run", "ls", "stat", "mkdir", "rm"].every((name) => !registered.has(name)));

  await call("shell_open", { server: "hpc1" });
  const cd = await call("shell_run", { server: "hpc1", command: "cd /tmp" });
  const pwd = await call("shell_run", { server: "hpc1", command: "pwd" });
  check("sticky session keeps cwd", cd.code === 0 && pwd.stdout.trim() === "/tmp", JSON.stringify(pwd.stdout.trim()));

  await call("shell_open", { server: "hpc1", name: "build" });
  const buildPwd = await call("shell_run", { server: "hpc1", session: "build", command: "pwd" });
  check("named session has independent cwd", buildPwd.stdout.trim() === home, JSON.stringify(buildPwd.stdout.trim()));

  const sessions = await call("session_list", {});
  check("session_list shows both sessions", sessions.sessions.length === 2);
  await call("shell_close", { server: "hpc1", session: "build" });
  const afterClose = await call("session_list", {});
  check("shell_close closes only that session", afterClose.sessions.length === 1);

  const up = await call("upload", { server: "hpc1", localPath: localUp, remotePath });
  check("upload verifies sha256", up.verified === true && up.bytes === Buffer.byteLength(payload), `bytes=${up.bytes}`);

  const again = await call("upload", { server: "hpc1", localPath: localUp, remotePath });
  check("re-upload of an identical file is skipped", again.skipped === true && again.bytes === 0);

  const mid = await call("shell_run", { server: "hpc1", command: `wc -c < ${remotePath}` });
  check(
    "agent can inspect files with shell commands",
    Number(mid.stdout.trim()) === Buffer.byteLength(payload),
    JSON.stringify(mid.stdout.trim()),
  );

  const down = await call("download", { server: "hpc1", remotePath, localPath: localDown });
  check("download verifies sha256", down.verified === true, `bytes=${down.bytes}`);
  check("download round-trips content", readFileSync(localDown, "utf8") === payload);

  await call("shell_run", { server: "hpc1", command: `rm -f ${remotePath}` });
  const removed = await call("shell_run", { server: "hpc1", command: `test -e ${remotePath} || echo GONE` });
  check("agent removes remote files via shell", removed.stdout.includes("GONE"));

  const disconnected = await call("server_disconnect", { server: "hpc1" });
  const finalStatus = await call("server_status", {});
  check(
    "server_disconnect closes connection and sessions",
    disconnected.disconnected === true && finalStatus.connections.length === 0 && finalStatus.sessions.length === 0,
  );
} catch (error) {
  check("smoke run completed without throwing", false, error?.message ?? String(error));
} finally {
  for (const dispose of effects.reverse()) {
    try {
      dispose();
    } catch {
      /* ignore */
    }
  }
  const failed = results.filter((entry) => !entry.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
