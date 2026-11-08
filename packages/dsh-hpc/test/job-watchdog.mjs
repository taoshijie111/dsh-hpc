#!/usr/bin/env node
/**
 * Unit test: the remote-job watchdog decision table.
 *
 * The watchdog binds a job to a stable handle — a Slurm JOBID, or a bare-metal
 * PID plus its kernel start time — and resolves the state on every poll. These
 * checks pin the behaviour that previously left the watcher spinning or
 * mis-reporting:
 *
 *  - a Slurm job missing from both squeue and accounting must escalate to
 *    scontrol, and fall back to output silence instead of polling forever;
 *  - a bare-metal process must not look alive when its PID was reused;
 *  - a lost bare-metal job reports the tail of its output instead of a bare
 *    "lost";
 *  - a watcher must end its sleep as soon as it is cancelled;
 *  - a held connection must survive idle reaping (2FA hosts).
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  LOST_SILENCE_MS,
  UNKNOWN_LIMIT,
  applySlurmEscalation,
  classifyBare,
  classifySlurmAccounting,
  classifySlurmScontrol,
  mapSlurmState,
  planSlurmPoll,
} from "../lib/core/jobstate.js";
import { ConnectionPool } from "../lib/core/pool.js";
import { sleep } from "../lib/core/watch.js";

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/** A stuck promise would hang the suite; fail the scenario instead. */
function within(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

let failures = 0;
async function check(name, run) {
  try {
    await run();
    console.log(`ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${error?.message ?? error}`);
  }
}

const poll = (overrides) => planSlurmPoll({ unknownPolls: 0, queue: "", accounting: "", ...overrides });

await check("a queued job resolves without asking accounting", () => {
  const plan = poll({ queue: "PENDING\n" });
  assert.equal(plan.verdict.state, "queued");
  assert.equal(plan.unknownPolls, 0);
  assert.equal(plan.escalate, false);
});

await check("a running job resolves without asking accounting", () => {
  const plan = poll({ queue: "RUNNING\n" });
  assert.equal(plan.verdict.state, "running");
  assert.equal(plan.escalate, false);
});

await check("accounting COMPLETED carries the exit code", () => {
  assert.deepEqual(classifySlurmAccounting("COMPLETED|0:0|00:01:00"), { state: "completed", exitCode: 0 });
});

await check("accounting COMPLETED with a non-zero code is a failure", () => {
  assert.deepEqual(classifySlurmAccounting("COMPLETED|1:0|00:01:00"), { state: "failed", exitCode: 1 });
});

await check("accounting CANCELLED maps to cancelled", () => {
  const verdict = classifySlurmAccounting("CANCELLED by 1000|0:15|00:00:02");
  assert.equal(verdict.state, "cancelled");
});

await check("accounting FAILED keeps the node-level exit code", () => {
  assert.deepEqual(classifySlurmAccounting("FAILED|137:0|00:00:10"), { state: "failed", exitCode: 137 });
});

await check("accounting OUT_OF_MEMORY is a failure", () => {
  assert.equal(classifySlurmAccounting("OUT_OF_MEMORY|0:125|00:03:00").state, "failed");
});

await check("unknown states stay unknown until the escalation limit", () => {
  let plan = poll({ unknownPolls: 0 });
  assert.equal(plan.verdict.state, "unknown");
  assert.equal(plan.escalate, false);
  assert.equal(plan.unknownPolls, 1);

  plan = poll({ unknownPolls: UNKNOWN_LIMIT - 2 });
  assert.equal(plan.escalate, false);
  assert.equal(plan.unknownPolls, UNKNOWN_LIMIT - 1);

  // The poll that reaches the limit must not come back as another "unknown":
  // it hands the caller the escalation probes instead.
  plan = poll({ unknownPolls: UNKNOWN_LIMIT - 1 });
  assert.equal(plan.verdict, null);
  assert.equal(plan.escalate, true);
  assert.equal(plan.unknownPolls, UNKNOWN_LIMIT);
});

await check("a resolved poll resets the unknown counter", () => {
  const plan = poll({ unknownPolls: 2, queue: "RUNNING\n" });
  assert.equal(plan.unknownPolls, 0);
});

await check("scontrol recovers a job accounting never recorded", () => {
  const verdict = applySlurmEscalation({
    scontrol: "JobId=123 JobName=x JobState=COMPLETED ExitCode=0:0 Elapsed=00:01:00",
    outputSilentMs: 10_000,
  });
  assert.deepEqual(verdict, { state: "completed", exitCode: 0 });
});

await check("scontrol reports a job that is still running", () => {
  assert.equal(classifySlurmScontrol("JobId=123 JobState=RUNNING ExitCode=0:0").state, "running");
  assert.equal(classifySlurmScontrol("JobId=123 JobState=PENDING").state, "queued");
  assert.equal(classifySlurmScontrol("JobId=123 JobState=CANCELLED by 1").state, "cancelled");
});

const ABSENT = "slurm_load_jobs error: Invalid job id specified";

await check("a job absent everywhere and silent is lost, with an explanation", () => {
  const verdict = applySlurmEscalation({ scontrol: ABSENT, outputSilentMs: LOST_SILENCE_MS + 5_000 });
  assert.equal(verdict.state, "lost");
  assert.match(verdict.note, /静默/);
});

await check("a job absent everywhere with no output files is lost", () => {
  const verdict = applySlurmEscalation({ scontrol: ABSENT, outputSilentMs: undefined });
  assert.equal(verdict.state, "lost");
  assert.match(verdict.note, /退出码未知/);
});

await check("a job absent everywhere but still writing output is not lost yet", () => {
  const verdict = applySlurmEscalation({ scontrol: ABSENT, outputSilentMs: 5_000 });
  assert.equal(verdict.state, "unknown");
});

await check("an unreachable controller never fabricates a lost job", () => {
  const verdict = applySlurmEscalation({
    scontrol: "slurm_load_jobs error: Socket timed out on send/recv operation",
    outputSilentMs: LOST_SILENCE_MS * 100,
  });
  assert.equal(verdict.state, "unknown");
  assert.equal(verdict.note, undefined);
});

await check("bare: an exit file is authoritative", () => {
  assert.deepEqual(classifyBare({ state: "running" }, "EXIT:0"), { state: "completed", exitCode: 0 });
  assert.deepEqual(classifyBare({ state: "running" }, "EXIT:137"), { state: "failed", exitCode: 137 });
  assert.equal(classifyBare({ state: "cancelled" }, "EXIT:143").state, "cancelled");
});

await check("bare: a live PID is running", () => {
  const verdict = classifyBare({ state: "running", pidStart: "12345" }, "ALIVE:12345");
  assert.deepEqual(verdict, { state: "running" });
});

await check("bare: a reused PID is not mistaken for the job", () => {
  const verdict = classifyBare({ state: "running", pidStart: "12345" }, "ALIVE:99999");
  assert.equal(verdict.state, "lost");
  assert.match(verdict.note, /复用/);
});

await check("bare: a vanished process is lost", () => {
  const verdict = classifyBare({ state: "running", pidStart: "12345" }, "GONE");
  assert.equal(verdict.state, "lost");
  assert.match(verdict.note, /退出码未知/);
});

await check("bare: a cancelled job stays cancelled when the process vanishes", () => {
  assert.equal(classifyBare({ state: "cancelled", pidStart: "12345" }, "GONE").state, "cancelled");
});

await check("bare: a failed probe is unknown, not lost", () => {
  assert.equal(classifyBare({ state: "running", pidStart: "12345" }, "").state, "unknown");
});

await check("mapSlurmState covers the scheduler words that matter", () => {
  assert.equal(mapSlurmState("REQUEUED").state, "running");
  assert.equal(mapSlurmState("NODE_FAIL").state, "failed");
  assert.equal(mapSlurmState("whatever"), null);
});

await check("cancelling a watcher ends its sleep immediately", async () => {
  const state = { cancelled: false, wake: null };
  const started = Date.now();
  const waiting = sleep(60_000, state);
  await tick(10);
  state.cancelled = true;
  state.wake?.();
  await within(waiting, 500, "cancelled sleep");
  assert.ok(Date.now() - started < 500, "the sleep must not wait for the full interval");
});

await check("an already-cancelled watcher does not sleep at all", async () => {
  const state = { cancelled: true, wake: null };
  await within(sleep(60_000, state), 100, "pre-cancelled sleep");
});

const SERVER = { id: "srv1", host: "10.0.0.1", username: "tester" };
const DELAY = 30;

function makePool(idleTimeoutMs = DELAY) {
  const connect = () => {
    const client = new EventEmitter();
    client.end = () => client.emit("close");
    return Promise.resolve({ client, fingerprint: "SHA256:test" });
  };
  return new ConnectionPool({
    connectTimeoutMs: () => 1_000,
    keepaliveIntervalMs: () => 0,
    idleTimeoutMs: () => idleTimeoutMs,
    connect,
  });
}

await check("a held connection survives idle reaping", async () => {
  const pool = makePool();
  pool.hold(SERVER.id);
  await pool.ensure({}, SERVER);
  await tick(DELAY * 5);
  assert.ok(pool.get(SERVER.id), "a held connection must not be reaped");
  pool.release(SERVER.id);
  await tick(DELAY * 5);
  assert.equal(pool.get(SERVER.id), undefined, "a released connection must be reaped");
  await pool.closeAll();
});

await check("nested holds keep the connection until the last release", async () => {
  const pool = makePool();
  pool.hold(SERVER.id);
  pool.hold(SERVER.id);
  await pool.ensure({}, SERVER);
  pool.release(SERVER.id);
  await tick(DELAY * 5);
  assert.ok(pool.get(SERVER.id), "one release must not drop the connection");
  pool.release(SERVER.id);
  await tick(DELAY * 5);
  assert.equal(pool.get(SERVER.id), undefined);
  await pool.closeAll();
});

await check("an unheld connection is reaped as before", async () => {
  const pool = makePool();
  await pool.ensure({}, SERVER);
  await tick(DELAY * 5);
  assert.equal(pool.get(SERVER.id), undefined, "the idle reaper must still work");
  await pool.closeAll();
});

await check("closing the pool clears holds", async () => {
  const pool = makePool();
  pool.hold(SERVER.id);
  await pool.closeAll();
  pool.release(SERVER.id); // must not throw or go negative
});

console.log(failures === 0 ? "\nall job watchdog checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
