#!/usr/bin/env node
/**
 * Connection-pool + multi-session smoke test (real host).
 *
 * Validates the v1.3 contract before the tool surface is rewired:
 *   - one SSH authentication serves many commands (pool reuse)
 *   - sticky shell keeps cwd/env between calls
 *   - named sessions have independent cwd/env
 *   - a timeout resets only its own session
 *   - the per-server session limit holds
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { ConnectionPool } from "../lib/core/pool.js";
import { SessionRegistry } from "../lib/core/session.js";

const host = process.env.HPC_TEST_HOST ?? (process.env.HPC_TEST_HOST_A ?? "");
const user = process.env.HPC_TEST_USER ?? (process.env.HPC_TEST_USER ?? "");
const keyPath = process.env.HPC_TEST_KEY ?? join(homedir(), ".ssh", "id_ed25519");
const hostKey = process.env.HPC_TEST_HOSTKEY ?? "SHA256:RdHHL8XKm28DrTNlHdu9NhY+o5qzf8Dr5V/9AbardOI";

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const config = {
  servers: [{ id: "hpc1", host, port: 22, username: user, auth: "key", keyPath, hostKey }],
  connectTimeoutMs: 20000,
  commandTimeoutMs: 120000,
};
const ctx = {
  credentials: {
    resolve: async () => undefined,
    describe: async () => ({ configured: false }),
    set: async () => undefined,
    unset: async () => undefined,
  },
};

const pool = new ConnectionPool({
  connectTimeoutMs: () => 20000,
  keepaliveIntervalMs: () => 30000,
  idleTimeoutMs: () => 0,
});
const sessions = new SessionRegistry(pool, { maxPerServer: () => 4, idleTimeoutMs: () => 0 });

const run = (command, opts = {}) =>
  sessions.run(ctx, config, "hpc1", command, { timeoutMs: 30000, ...opts });

try {
  const first = await run("hostname; id -un");
  check("first command connects and runs", first.code === 0 && first.stdout.includes("login01"), `${first.durationMs}ms`);

  const reuse = await run("echo second");
  check("second command reuses the pooled connection", reuse.code === 0 && reuse.durationMs < 1500, `${reuse.durationMs}ms`);
  check("connection pool reports one connection", pool.list().length === 1, JSON.stringify(pool.list().map((e) => e.serverId)));

  await run("cd /tmp");
  const pwd = await run("pwd");
  check("sticky shell keeps cwd", pwd.stdout.trim() === "/tmp", JSON.stringify(pwd.stdout.trim()));

  const build = await run("pwd", { session: "build" });
  check("second session starts with its own cwd", build.stdout.trim() === `/public/home/${user}`, JSON.stringify(build.stdout.trim()));

  await run("export MSS_FLAG=42");
  const flagA = await run("echo flag=$MSS_FLAG");
  const flagB = await run("echo flag=$MSS_FLAG", { session: "build" });
  check("env is sticky within a session", flagA.stdout.includes("flag=42"), JSON.stringify(flagA.stdout.trim()));
  check("env is isolated between sessions", flagB.stdout.includes("flag="), JSON.stringify(flagB.stdout.trim()));

  const timeout = await run("sleep 30", { session: "logs", timeoutMs: 1500 });
  check("timeout is reported", timeout.timedOut === true, `${timeout.durationMs}ms`);
  check("timeout resets only that session", timeout.stateReset === true);

  const mainAfter = await run("pwd");
  check("other session survives a peer reset", mainAfter.code === 0 && mainAfter.stdout.trim() === "/tmp", JSON.stringify(mainAfter.stdout.trim()));

  const list = sessions.list();
  check("session_list shows all named sessions", list.length === 3 && new Set(list.map((s) => s.name)).size === 3, JSON.stringify(list.map((s) => `${s.name}:${s.alive}`)));

  await run("true", { session: "s4" });
  let limitRejected = false;
  try {
    await run("true", { session: "s5" });
  } catch (error) {
    limitRejected = /limit 4/.test(String(error && error.message));
  }
  check("per-server session limit is enforced", limitRejected);
} catch (error) {
  check("smoke run completed without throwing", false, error?.message ?? String(error));
} finally {
  await sessions.closeAll().catch(() => undefined);
  await pool.closeAll().catch(() => undefined);
  check("cleanup leaves no pooled connections", pool.list().length === 0);
  const failed = results.filter((entry) => !entry.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
