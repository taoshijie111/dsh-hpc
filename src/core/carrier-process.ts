import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CARRIER_PROTOCOL,
  carrierMessageSchema,
  type CarrierMessage,
  type CarrierTarget,
} from "@multiservers/carrier-protocol";

/**
 * Starts and supervises the page carrier beside the daemon. The carrier is a
 * child process with a Node IPC channel and no control port; it holds upstream
 * entry tokens and serves page traffic, so it gets no access to daemon state.
 *
 * Ported from Project Citadel (see NOTICE.md); behavior is unchanged apart from
 * package names and the artifact location.
 */
export class CarrierProcess {
  private child: ChildProcess | null = null;
  private ready = false;
  private closed = false;
  private restarts = 0;
  private readonly targets = new Map<string, CarrierTarget>();
  private readonly waiting = new Map<string, ((message: CarrierMessage) => void)[]>();

  constructor(
    private readonly onMessage: (message: CarrierMessage) => void,
    private readonly artifact = carrierArtifact(),
  ) {}

  start() {
    if (this.closed || this.child) return;
    if (!this.artifact) throw new Error("The carrier is not built. Run npm run build:carrier.");
    const child = fork(this.artifact, [], {
      execArgv: [],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      // The carrier needs no credentials, proxies or daemon settings from the environment.
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", NODE_ENV: process.env.NODE_ENV ?? "production" },
    });
    this.child = child;
    child.on("message", (raw) => {
      const parsed = carrierMessageSchema.safeParse(raw);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === "ready") {
        this.ready = message.protocol === CARRIER_PROTOCOL;
        if (this.ready) this.restarts = 0;
        if (this.ready) for (const target of this.targets.values()) this.post({ type: "target", target });
        return;
      }
      if (message.type === "listening" || message.type === "failed") {
        const waiters = this.waiting.get(message.id) ?? [];
        this.waiting.delete(message.id);
        for (const resolve of waiters) resolve(message);
      }
      this.onMessage(message);
    });
    child.on("exit", () => {
      this.child = null;
      this.ready = false;
      for (const [id, waiters] of this.waiting)
        for (const resolve of waiters) resolve({ type: "failed", id, reason: "The carrier stopped." });
      this.waiting.clear();
      if (this.closed) return;
      const delay = Math.min(30_000, 500 * 2 ** this.restarts++);
      setTimeout(() => this.start(), delay).unref();
    });
  }

  /** Opens or updates a target and resolves once the carrier is listening, or says why it isn't. */
  setTarget(target: CarrierTarget): Promise<CarrierMessage> {
    this.targets.set(target.id, target);
    const answer = new Promise<CarrierMessage>((resolve) => {
      const waiters = this.waiting.get(target.id) ?? [];
      waiters.push(resolve);
      this.waiting.set(target.id, waiters);
      setTimeout(() => resolve({ type: "failed", id: target.id, reason: "The carrier didn't answer." }), 10_000).unref();
    });
    if (this.ready) this.post({ type: "target", target });
    else this.start();
    return answer;
  }

  removeTarget(id: string) {
    this.targets.delete(id);
    if (this.ready) this.post({ type: "remove", id });
  }

  addTicket(target: string, ticket: string, expiresAt: number) {
    if (!this.ready) return false;
    this.post({ type: "ticket", target, ticket, expiresAt });
    return true;
  }

  revokePasses() {
    if (this.ready) this.post({ type: "revoke-passes" });
  }

  get running() {
    return this.ready;
  }

  close() {
    this.closed = true;
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.disconnect?.();
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGTERM");
    }, 2000).unref();
  }

  private post(message: object) {
    try {
      this.child?.send(message);
    } catch {
      /* The exit handler restarts the carrier. */
    }
  }
}

/** The built carrier, from both the tsx source layout and the compiled dist layout. */
export function carrierArtifact(): string | null {
  const relative = fileURLToPath(new URL("../../packages/web-carrier/dist/main.js", import.meta.url));
  if (existsSync(relative)) return relative;
  return null;
}
