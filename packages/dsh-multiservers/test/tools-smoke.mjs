#!/usr/bin/env node
/**
 * Integration smoke test for the dsh-multiservers host half.
 *
 * Registers the plugin against a fake Cordis context, then calls the real tool
 * definitions against a real SSH host. No DSH process is involved, so this
 * isolates "does the tool surface actually work" from "does DSH load us".
 *
 * Env overrides: MSS_TEST_HOST, MSS_TEST_USER, MSS_TEST_KEY, MSS_TEST_HOSTKEY.
 */
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as plugin from "../lib/index.js";

const host = process.env.MSS_TEST_HOST ?? "114.214.255.60";
const user = process.env.MSS_TEST_USER ?? "taoshijie";
const keyPath = process.env.MSS_TEST_KEY ?? join(homedir(), ".ssh", "id_ed25519");
const hostKey = process.env.MSS_TEST_HOSTKEY ?? "SHA256:RdHHL8XKm28DrTNlHdu9NhY+o5qzf8Dr5V/9AbardOI";

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const registered = new Map();
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
};

const config = {
  servers: [{ id: "hpc1", label: "Test HPC", host, port: 22, username: user, auth: "key", keyPath, hostKey }],
  connectTimeoutMs: 20000,
  commandTimeoutMs: 60000,
};

plugin.apply(ctx, config);
const tool = (name) => {
  const definition = registered.get(name);
  if (!definition) throw new Error(`tool ${name} was not registered`);
  return definition;
};
const call = (name, args) => tool(name).execute(args, { signal: new AbortController().signal });

const work = mkdtempSync(join(tmpdir(), "mss-smoke-"));
const localUp = join(work, "up.txt");
const localDown = join(work, "down.txt");
const remotePath = `/public/home/${user}/.mss-smoke-${process.pid}.txt`;
const payload = `multiservers smoke ${new Date().toISOString()}\n`;
writeFileSync(localUp, payload, "utf8");

try {
  check("plugin registers 12 tools", registered.size === 12, `registered=${registered.size}`);

  const list = await call("server_list", {});
  check("server_list returns the configured host", list.servers.length === 1 && list.servers[0].host === host);

  const test = await call("server_test", { server: "hpc1" });
  check("server_test reaches the host", test.reachable === true, `latency=${test.latencyMs}ms`);
  check("host key exists", typeof test.hostKeyFingerprint === "string" && test.hostKeyFingerprint.startsWith("SHA256:"));
  check("pinned host key matches", test.hostKeyMatches === true, test.hostKeyFingerprint);

  const probe = await call("server_probe", { server: "hpc1" });
  check("server_probe detects a Linux platform", String(probe.platform ?? "").includes("Linux"), probe.platform);
  check("server_probe detects the Slurm client", (probe.schedulers ?? []).includes("sbatch"), JSON.stringify(probe.schedulers));
  check("server_probe detects rsync", Boolean(probe.tools?.rsync), String(probe.tools?.rsync));

  const run = await call("run", { server: "hpc1", command: "hostname; id -un" });
  check("run executes through the login shell", run.code === 0 && run.stdout.includes("login01"), JSON.stringify(run.stdout.trim()));
  check("run reports stderr separately", typeof run.stderr === "string");

  const ls = await call("ls", { server: "hpc1", path: `/public/home/${user}` });
  check("ls lists the home directory", ls.entries.length > 0, `entries=${ls.entries.length}`);

  const up = await call("upload", { server: "hpc1", localPath: localUp, remotePath });
  check("upload writes the file", up.bytes === Buffer.byteLength(payload), `bytes=${up.bytes}`);

  await call("download", { server: "hpc1", remotePath, localPath: localDown });
  check("download round-trips the content", readFileSync(localDown, "utf8") === payload);

  const stat = await call("stat", { server: "hpc1", path: remotePath });
  check("stat reports a regular file", stat.entry.type === "file", `size=${stat.entry.size}`);

  const rm = await call("rm", { server: "hpc1", path: remotePath });
  check("rm removes the remote file", rm.removed === true);

  const cwd = await call("run", { server: "hpc1", command: "pwd", cwd: `/public/home/${user}` });
  check("run honours cwd", cwd.code === 0 && cwd.stdout.trim() === `/public/home/${user}`, JSON.stringify(cwd.stdout.trim()));
} catch (error) {
  check("smoke run completed without throwing", false, error?.message ?? String(error));
} finally {
  try {
    await call("rm", { server: "hpc1", path: remotePath });
  } catch {
    /* best-effort cleanup */
  }
  const failed = results.filter((entry) => !entry.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
