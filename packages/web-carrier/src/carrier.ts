import { createHash, randomBytes } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { CARRIER_ENTRY_PATH, type CarrierMessage, type CarrierTarget } from "@multiservers/carrier-protocol";

/**
 * The carrier: one listening origin per target, each translating requests
 * from a person's browser into the loopback requests its upstream accepts.
 * It knows targets and generic entry credentials only. It never starts a
 * program, reads a body, injects a script, or names an application.
 */

const PASS_LIFETIME_MS = 12 * 60 * 60 * 1000;
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

type Pass = { target: string; expiresAt: number };
type Ticket = { target: string; expiresAt: number };
type Running = {
  target: CarrierTarget;
  server: Server;
  jar: Map<string, string>;
  /** The entry exchange for the current generation, run once. */
  entered: Promise<void> | null;
  reachable: boolean | null;
};

export class Carrier {
  private readonly running = new Map<string, Running>();
  private readonly tickets = new Map<string, Ticket>();
  private readonly passes = new Map<string, Pass>();

  constructor(private readonly send: (message: CarrierMessage) => void) {}

  /** Starts or updates a target; an unchanged listener is kept, a changed run re-enters with an empty jar. */
  async setTarget(target: CarrierTarget): Promise<void> {
    const current = this.running.get(target.id);
    if (current && current.target.bind === target.bind && current.target.port === target.port) {
      const rerun = current.target.generation !== target.generation;
      current.target = target;
      if (rerun) {
        current.jar.clear();
        current.entered = null;
      }
      this.send({ type: "listening", id: target.id, port: target.port });
      return;
    }
    if (current) await this.removeTarget(target.id);
    const running: Running = {
      target,
      server: createServer(),
      jar: new Map(),
      entered: null,
      reachable: null,
    };
    running.server.on("request", (req, res) => void this.handle(running, req, res));
    running.server.on("upgrade", (req, socket, head) => void this.upgrade(running, req, socket, head));
    running.server.on("clientError", (_error, socket) => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        running.server.once("error", reject);
        running.server.listen(target.port, target.bind, () => {
          running.server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      this.send({
        type: "failed",
        id: target.id,
        reason:
          (error as NodeJS.ErrnoException).code === "EADDRINUSE"
            ? `Port ${target.port} is already in use on this machine.`
            : "The page's port could not be opened.",
      });
      return;
    }
    this.running.set(target.id, running);
    this.send({ type: "listening", id: target.id, port: target.port });
  }

  async removeTarget(id: string): Promise<void> {
    const running = this.running.get(id);
    if (!running) return;
    this.running.delete(id);
    for (const [key, pass] of this.passes) if (pass.target === id) this.passes.delete(key);
    running.server.closeAllConnections();
    await new Promise<void>((resolve) => running.server.close(() => resolve()));
  }

  addTicket(target: string, ticket: string, expiresAt: number) {
    this.tickets.set(digest(ticket), { target, expiresAt });
  }

  revokePasses() {
    this.passes.clear();
  }

  async close() {
    await Promise.all([...this.running.keys()].map((id) => this.removeTarget(id)));
  }

  // ------------------------------------------------------------ Admission ----

  private cookieName(id: string) {
    return `multiservers_page_${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
  }

  /** The request carries this target's pass, and any browser markers agree with its own origin. */
  private admitted(running: Running, req: IncomingMessage): "ok" | "origin" | "pass" {
    const host = req.headers.host;
    const origin = req.headers.origin;
    if (origin !== undefined) {
      try {
        if (!host || new URL(origin).host !== host.toLowerCase()) return "origin";
      } catch {
        return "origin";
      }
    }
    if (req.headers["sec-fetch-site"] === "cross-site") return "origin";
    const now = Date.now();
    for (const value of cookieValues(req.headers.cookie, this.cookieName(running.target.id))) {
      const pass = this.passes.get(digest(value));
      if (pass && pass.target === running.target.id && pass.expiresAt > now) return "ok";
    }
    return "pass";
  }

  private enter(running: Running, req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://carrier.invalid");
    const presented = url.searchParams.get("ticket") ?? "";
    const key = digest(presented);
    const ticket = this.tickets.get(key);
    this.tickets.delete(key);
    if (
      req.method !== "GET" ||
      !ticket ||
      ticket.target !== running.target.id ||
      ticket.expiresAt <= Date.now()
    ) {
      page(res, 401, "This pass has expired", "Open the page again from Multiservers.");
      return;
    }
    const value = randomBytes(32).toString("base64url");
    this.passes.set(digest(value), { target: running.target.id, expiresAt: Date.now() + PASS_LIFETIME_MS });
    res.writeHead(303, {
      location: "/",
      "set-cookie": `${this.cookieName(running.target.id)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${PASS_LIFETIME_MS / 1000}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    res.end();
  }

  // ---------------------------------------------------------- Translation ----

  /** The upstream's own entry: exchanged once per run, by the carrier rather than the browser. */
  private ensureEntered(running: Running): Promise<void> {
    const credential = running.target.credential;
    if (credential.kind !== "query-token") return Promise.resolve();
    return (running.entered ??= new Promise<void>((resolve, reject) => {
      const path = `${credential.path}?${new URLSearchParams({ [credential.parameter]: credential.token })}`;
      const upstream = httpRequest(
        {
          socketPath: running.target.upstream,
          path,
          method: "GET",
          headers: { host: running.target.authority },
        },
        (response) => {
          storeCookies(running.jar, response.headers["set-cookie"]);
          response.resume();
          response.on("end", () => (response.statusCode && response.statusCode < 400 ? resolve() : reject()));
        },
      );
      upstream.on("error", reject);
      upstream.end();
    }).catch((error: unknown) => {
      running.entered = null;
      throw error;
    }));
  }

  private upstreamHeaders(
    running: Running,
    headers: IncomingHttpHeaders,
    websocket: boolean,
  ): OutgoingHttpHeaders {
    const out: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined || HOP_BY_HOP.includes(name)) continue;
      if (["host", "origin", "cookie", "sec-fetch-site", "referer", "forwarded"].includes(name)) continue;
      if (name.startsWith("x-forwarded-")) continue;
      out[name] = value;
    }
    const authority = running.target.authority;
    out.host = authority;
    if (headers.origin !== undefined) out.origin = `http://${authority}`;
    // A referrer names the page within the upstream's own origin, as if the browser were local.
    const referer = typeof headers.referer === "string" ? headers.referer : undefined;
    if (referer) {
      try {
        const url = new URL(referer);
        if (url.host === headers.host?.toLowerCase())
          out.referer = `http://${authority}${url.pathname}${url.search}`;
      } catch {
        /* An unreadable referrer is simply not passed on. */
      }
    }
    // Browser cookies never reach the upstream, Multiservers' included; only the carrier's jar does.
    if (running.jar.size) out.cookie = [...running.jar].map(([name, value]) => `${name}=${value}`).join("; ");
    if (running.target.credential.kind === "header")
      out[running.target.credential.name.toLowerCase()] = running.target.credential.value;
    if (websocket) {
      out.connection = "Upgrade";
      out.upgrade = headers.upgrade;
    }
    return out;
  }

  private async handle(running: Running, req: IncomingMessage, res: ServerResponse) {
    if ((req.url ?? "").split("?")[0] === CARRIER_ENTRY_PATH) return this.enter(running, req, res);
    const admission = this.admitted(running, req);
    if (admission === "origin") return page(res, 403, "Refused", "This request didn't come from this page.");
    if (admission === "pass")
      return page(res, 401, "Open this page from Multiservers", "This browser has no pass for it.");
    try {
      await this.ensureEntered(running);
    } catch {
      this.observe(running, false);
      return page(res, 502, "The application isn't answering", "Multiservers keeps trying; reload in a moment.");
    }
    const upstream = httpRequest(
      {
        socketPath: running.target.upstream,
        path: req.url,
        method: req.method,
        headers: this.upstreamHeaders(running, req.headers, false),
      },
      (response) => {
        this.observe(running, true);
        storeCookies(running.jar, response.headers["set-cookie"]);
        res.writeHead(response.statusCode ?? 502, response.statusMessage, responseHeaders(response.headers));
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      this.observe(running, false);
      if (!res.headersSent)
        page(res, 502, "The application isn't answering", "Multiservers keeps trying; reload in a moment.");
      else res.destroy();
    });
    req.on("aborted", () => upstream.destroy());
    req.pipe(upstream);
  }

  private async upgrade(running: Running, req: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on("error", () => socket.destroy());
    const admission = this.admitted(running, req);
    if (admission !== "ok" || (req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
      socket.end(
        `HTTP/1.1 ${admission === "pass" ? "401 Unauthorized" : "403 Forbidden"}\r\nconnection: close\r\n\r\n`,
      );
      return;
    }
    try {
      await this.ensureEntered(running);
    } catch {
      this.observe(running, false);
      socket.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n");
      return;
    }
    const upstream = connect(running.target.upstream);
    upstream.on("error", () => {
      this.observe(running, false);
      socket.destroy();
    });
    upstream.on("connect", () => {
      this.observe(running, true);
      const headers = this.upstreamHeaders(running, req.headers, true);
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [name, value] of Object.entries(headers))
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${String(item)}`);
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  }

  private observe(running: Running, reachable: boolean) {
    if (running.reachable === reachable) return;
    running.reachable = reachable;
    this.send({ type: "upstream", id: running.target.id, reachable });
  }
}

// --------------------------------------------------------------- Helpers ----

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/** Every value of one cookie name; a page on the same host may have set a decoy of the same name. */
export function cookieValues(header: string | undefined, name: string): string[] {
  if (!header) return [];
  const values: string[] = [];
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) values.push(part.slice(index + 1).trim());
  }
  return values;
}

/** Keeps an upstream's cookies by name; an expiring cookie is removed. */
export function storeCookies(jar: Map<string, string>, header: string[] | undefined) {
  for (const line of header ?? []) {
    const [pair, ...attributes] = line.split(";");
    const index = pair?.indexOf("=") ?? -1;
    if (!pair || index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    const expired = attributes.some((attribute) => {
      const [key, raw] = attribute.split("=").map((item) => item.trim());
      if (key?.toLowerCase() === "max-age") return Number(raw) <= 0;
      if (key?.toLowerCase() === "expires") return Date.parse(raw ?? "") <= Date.now();
      return false;
    });
    if (expired || !value) jar.delete(name);
    else jar.set(name, value);
  }
}

/** The upstream's response headers, minus its cookies and the framing refusals the Multiservers window would hit. */
export function responseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (
      value === undefined ||
      HOP_BY_HOP.includes(name) ||
      name === "set-cookie" ||
      name === "x-frame-options"
    )
      continue;
    if (name === "content-security-policy" && typeof value === "string") {
      const kept = value
        .split(";")
        .filter((directive) => directive.trim().split(/\s+/)[0]?.toLowerCase() !== "frame-ancestors")
        .join(";")
        .trim();
      if (kept) out[name] = kept;
      continue;
    }
    out[name] = value;
  }
  return out;
}

function page(res: ServerResponse, status: number, title: string, detail: string) {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;color:#1e272e;background:#f5f3ee}main{max-width:420px;padding:24px}h1{font-size:18px}</style></head><body><main><h1>${title}</h1><p>${detail}</p></main></body></html>`;
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}
