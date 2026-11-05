#!/usr/bin/env node
/**
 * Unit test: a failed shell start must never escape as an unhandled rejection.
 *
 * The DeepSeek Harness host treats process-level unhandled rejections as fatal
 * ("dsh: fatal load failure") and exits, which the desktop app surfaces as a
 * crash. This test drives ShellSession with a fake SSH client that fails on
 * purpose (channel failure, readiness timeout, close before ready) and asserts
 * that every failure is delivered to the caller instead.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ShellSession } from "../lib/core/session.js";

const MARKER = "\x1eMSS";
const rejections = [];
process.on("unhandledRejection", (reason) => rejections.push(reason));

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/** A regression here would hang the command promise; fail the scenario instead. */
function within(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
    this.writes = [];
    this.closed = false;
  }

  write(chunk) {
    this.writes.push(String(chunk));
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.execCalls = 0;
    this.failNext = 0;
    this.last = null;
  }

  exec(command, callback) {
    this.execCalls += 1;
    assert.equal(command, "bash -l");
    const stream = new FakeStream();
    this.last = stream;
    setImmediate(() => {
      if (this.failNext > 0) {
        this.failNext -= 1;
        callback(new Error("(SSH) Channel open failure: open failed"));
        return;
      }
      callback(null, stream);
    });
    return this;
  }
}

/** Feed back the readiness marker the session printed when `bash -l` started. */
async function becomeReady(stream) {
  await tick(10);
  const match = /MSSREADY:([0-9a-f]+)/.exec(stream.writes.join(""));
  assert.ok(match, "the session writes a readiness marker");
  stream.emit("data", Buffer.from(`${MARKER}READY:${match[1]}${MARKER}\n`));
  await tick(5);
}

/** Complete the running command by echoing its sentinel back. */
async function complete(stream, code = 0, cwd = "/home/test") {
  await tick(5);
  const payload = stream.writes[stream.writes.length - 1] ?? "";
  const match = new RegExp(`MSS([0-9a-f]{20}):`).exec(payload);
  assert.ok(match, "the session writes a command marker");
  stream.emit("data", Buffer.from(`${MARKER}${match[1]}:${code}:${cwd}${MARKER}\n`));
  await tick(5);
}

let failures = 0;
async function check(name, run) {
  rejections.length = 0;
  // The session's own timers are unref'd, so keep the event loop alive while a
  // timeout-based scenario is in flight.
  const keepAlive = setInterval(() => {}, 50);
  try {
    await within(run(), 5_000, name);
    await tick(40);
    if (rejections.length > 0) {
      throw new Error(`unhandled rejection escaped: ${rejections.map(String).join(" | ")}`);
    }
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name} — ${error.message}`);
  } finally {
    clearInterval(keepAlive);
  }
}

await check("start failure rejects the command call instead of killing the process", async () => {
  const client = new FakeClient();
  client.failNext = 2;
  const session = new ShellSession(client, "srv", "main", 300);

  await assert.rejects(session.run("echo hi", 500), /Could not start a shell session/);
  await assert.rejects(session.run("echo again", 500), /Could not start a shell session/);
  assert.equal(client.execCalls, 2, "a failed start is retried instead of cached forever");
  await session.close();
});

await check("readiness timeout rejects the command call", async () => {
  const client = new FakeClient();
  const session = new ShellSession(client, "srv", "main", 120);

  await assert.rejects(session.run("echo hi", 500), /did not become ready/);
  assert.ok(client.last.closed, "the half-open shell stream is closed after the timeout");
  await session.close();
});

await check("close before ready rejects the command call immediately", async () => {
  const client = new FakeClient();
  const session = new ShellSession(client, "srv", "main", 5_000);

  const pending = session.run("echo hi", 500);
  await tick(10);
  client.last.close();

  await assert.rejects(pending, /closed before it became ready/);
  await session.close();
});

await check("start() rejection is handled even when nobody awaits it", async () => {
  const client = new FakeClient();
  client.failNext = 1;
  const session = new ShellSession(client, "srv", "main", 300);

  void session.start(); // deliberately not awaited
  await tick(60);
  await session.close();
});

await check("a healthy session runs commands and survives a reconnect", async () => {
  const client = new FakeClient();
  const session = new ShellSession(client, "srv", "main", 300);

  const first = session.run("echo hi", 500);
  await becomeReady(client.last);
  await complete(client.last);
  const result = await first;
  assert.equal(result.code, 0);
  assert.equal(result.cwd, "/home/test");

  // The connection drops; the next command must reconnect, and a failed
  // reconnect must reject that command rather than crash the host.
  client.last.close();
  await tick(10);
  client.failNext = 1;
  await assert.rejects(session.run("echo after", 500), /Could not start a shell session/);
  await session.close();
});

await check("pump() never rejects: queued commands receive the error", async () => {
  const client = new FakeClient();
  client.failNext = 1;
  const session = new ShellSession(client, "srv", "main", 300);

  let rejectedWith = null;
  session.queue.push({
    command: "echo hi",
    timeoutMs: 500,
    resolve: () => {
      throw new Error("a queued command must not resolve when the shell cannot start");
    },
    reject: (error) => {
      rejectedWith = error;
    },
  });

  await session.pump();
  assert.ok(rejectedWith instanceof Error);
  assert.match(rejectedWith.message, /Could not start a shell session/);
  await session.close();
});

await check("a closed session rejects new commands", async () => {
  const client = new FakeClient();
  const session = new ShellSession(client, "srv", "main", 300);
  await session.close();
  await assert.rejects(session.run("echo hi", 500), /is closed/);
});

await tick(50);
if (rejections.length > 0) {
  failures += 1;
  console.log(`FAIL  unhandled rejections after the suite — ${rejections.map(String).join(" | ")}`);
}

console.log(failures === 0 ? "\nall session resilience checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
