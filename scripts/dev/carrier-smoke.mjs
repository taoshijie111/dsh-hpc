#!/usr/bin/env node
/**
 * Smoke test for the ported carrier (@multiservers/web-carrier).
 *
 * Proves the whole page-carrier path on this machine (Windows included):
 *   fake upstream HTTP server  →  relay socket  →  carrier  →  browser-facing origin
 *
 * Flow: fork carrier → send target + ticket → GET /__multiservers/enter?ticket=…
 * (expect 303 + pass cookie) → GET / with the cookie (expect upstream body).
 *
 * Loopback only; nothing outside the repository is touched.
 */
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer as createHttpServer, request } from "node:http";
import { connect as netConnect, createServer as createNetServer } from "node:net";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const carrierEntry = join(root, "packages", "web-carrier", "dist", "main.js");

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function httpGet({ port, path, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function waitForMessage(child, predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for carrier message")), timeoutMs);
    const onMessage = (raw) => {
      if (!predicate(raw)) return;
      clearTimeout(timer);
      child.off("message", onMessage);
      resolve(raw);
    };
    child.on("message", onMessage);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`carrier exited early with code ${code}`));
    });
  });
}

const upstream = createHttpServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain", "x-upstream": "yes" });
  res.end(`UPSTREAM_OK ${req.url}`);
});

const cleanup = [];
let child;
try {
  const upstreamPort = await new Promise((resolve, reject) => {
    upstream.listen(0, "127.0.0.1", () => resolve(upstream.address().port));
    upstream.once("error", reject);
  });

  // The relay stands in for the service side: carrier → socket → real upstream.
  mkdirSync(join(root, ".tmp"), { recursive: true });
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\multiservers-smoke-${process.pid}`
      : join(root, ".tmp", `carrier-smoke-${process.pid}.sock`);

  const relay = createNetServer((socket) => {
    const up = netConnect(upstreamPort, "127.0.0.1");
    socket.pipe(up);
    up.pipe(socket);
    socket.on("error", () => up.destroy());
    up.on("error", () => socket.destroy());
  });
  await new Promise((resolve, reject) => {
    relay.listen(socketPath, () => resolve());
    relay.once("error", reject);
  });
  cleanup.push(() => new Promise((resolve) => relay.close(() => resolve())));

  const carrierPort = await freePort();
  child = fork(carrierEntry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  cleanup.push(
    () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill();
      }),
  );
  child.stderr.on("data", (d) => process.stderr.write(`[carrier] ${d}`));

  await waitForMessage(child, (m) => m?.type === "ready");
  record("carrier boots and reports ready", true);

  const target = {
    id: "smoke-target",
    bind: "127.0.0.1",
    port: carrierPort,
    upstream: socketPath,
    authority: `127.0.0.1:${upstreamPort}`,
    credential: { kind: "none" },
    generation: "g1",
  };
  child.send({ type: "target", target });
  const listening = await waitForMessage(child, (m) => m?.type === "listening" || m?.type === "failed");
  record("carrier listens for the target", listening.type === "listening", JSON.stringify(listening));

  const ticket = randomBytes(24).toString("base64url");
  child.send({ type: "ticket", target: target.id, ticket, expiresAt: Date.now() + 60_000 });

  const entered = await httpGet({ port: carrierPort, path: `/__multiservers/enter?ticket=${ticket}` });
  record("ticket exchanges for a pass", entered.status === 303, `status=${entered.status}`);

  const setCookie = entered.headers["set-cookie"]?.[0] ?? "";
  record(
    "pass cookie is HttpOnly + SameSite=Strict",
    /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie),
    setCookie.slice(0, 60),
  );

  const page = await httpGet({
    port: carrierPort,
    path: "/",
    headers: { cookie: setCookie.split(";")[0] },
  });
  record(
    "authorized page reaches the upstream",
    page.status === 200 && page.body.includes("UPSTREAM_OK"),
    `status=${page.status} body=${JSON.stringify(page.body.slice(0, 40))}`,
  );

  const anonymous = await httpGet({ port: carrierPort, path: "/" });
  record("page without a pass is refused", anonymous.status === 401, `status=${anonymous.status}`);

  child.send({ type: "revoke-passes" });
  await new Promise((r) => setTimeout(r, 50));
  const revoked = await httpGet({ port: carrierPort, path: "/", headers: { cookie: setCookie.split(";")[0] } });
  record("revoked pass is refused", revoked.status === 401, `status=${revoked.status}`);
} catch (error) {
  record("smoke run", false, error.message);
} finally {
  for (const fn of cleanup.reverse()) {
    try {
      await fn();
    } catch {
      /* ignore cleanup errors */
    }
  }
  upstream.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
