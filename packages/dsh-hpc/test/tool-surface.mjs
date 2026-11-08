#!/usr/bin/env node
/**
 * Tool-surface contract.
 *
 * The agent's routing rules are the tool descriptions: a submission must be
 * non-blocking, a quick login-node command must not be mistaken for a job, and
 * a pipeline must be one job. This pins that surface without touching SSH.
 */
import assert from "node:assert/strict";
import * as plugin from "../lib/index.js";

const registered = new Map();
const ctx = {
  tools: { register: (definition) => (registered.set(definition.name, definition), () => registered.delete(definition.name)) },
  credentials: {
    resolve: async () => undefined,
    describe: async () => ({ configured: false }),
    set: async () => undefined,
    unset: async () => undefined,
  },
  get: () => undefined,
  inject: (_names, callback) => callback({}),
  effect(fn) {
    return fn();
  },
};

plugin.apply(ctx, {
  servers: [],
  connectTimeoutMs: 20_000,
  commandTimeoutMs: 120_000,
  keepaliveIntervalMs: 30_000,
  idleTimeoutMs: 600_000,
  maxSessionsPerServer: 4,
  sessionIdleTimeoutMs: 1_800_000,
});

const names = [...registered.keys()].sort();
const description = (name) => {
  const tool = registered.get(name);
  assert.ok(tool, `${name} is missing`);
  return tool.description ?? "";
};

let failures = 0;
function check(name, run) {
  try {
    run();
    console.log(`ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${error?.message ?? error}`);
  }
}

check("the surface is 16 tools", () => {
  assert.equal(names.length, 16, `got ${names.length}: ${names.join(", ")}`);
});

check("job_wait is gone", () => {
  assert.ok(!registered.has("job_wait"), "job_wait would make the agent block the session");
});

check("job_submit is non-blocking by default", () => {
  const submit = registered.get("job_submit");
  assert.ok(submit, "job_submit is missing");
  assert.ok(submit.parameters.properties.waitMs, "job_submit must expose the bounded waitMs");
  assert.match(submit.description, /never poll or block/i);
  assert.match(submit.description, /watchdog/i);
});

check("job_submit asks for one job per pipeline", () => {
  const text = description("job_submit");
  assert.match(text, /pipeline/i);
  assert.match(text, /one job/i);
});

check("job_submit caps the inline wait", () => {
  assert.match(registered.get("job_submit").parameters.properties.waitMs.description, /60000/);
});

check("job_status is a snapshot, not a wait loop", () => {
  const text = description("job_status");
  assert.match(text, /snapshot/i);
  assert.match(text, /do not call it in a loop/i);
});

check("shell_run routes long work to job_submit", () => {
  const text = description("shell_run");
  assert.match(text, /login node/i);
  assert.match(text, /job_submit/);
});

check("job_logs and job_cancel know about the watchdog", () => {
  assert.match(description("job_logs"), /watchdog/i);
  assert.match(description("job_cancel"), /watchdog/i);
});

console.log(failures === 0 ? "\nall tool surface checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
