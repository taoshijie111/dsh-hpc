import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import type { CarrierMessage, CarrierTarget } from "@multiservers/carrier-protocol";
import { CarrierProcess } from "./carrier-process.js";
import { HarnessWebProcess } from "./dsh-web.js";
import { createRelay, relayPath, type Relay } from "./relay.js";
import { resolveDshEntry } from "./harnesses.js";

export type WindowView = {
  id: string;
  harness: "dsh";
  label: string;
  createdAt: string;
  url: string;
};

type OpenWindow = {
  view: Omit<WindowView, "url">;
  relay: Relay;
  carrierPort: number;
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("no port available"));
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

/**
 * Owns harness page windows: harness process → private relay → carrier target →
 * one-time ticket → embeddable URL.
 *
 * One window per harness for now; the URL is minted per load because tickets
 * are single-use and short-lived.
 */
export class WindowManager {
  private readonly carrier: CarrierProcess;
  private readonly dsh: HarnessWebProcess | null;
  private readonly windows = new Map<string, OpenWindow>();
  private readonly log: string[] = [];
  private counter = 0;

  constructor(private readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.carrier = new CarrierProcess((message: CarrierMessage) => {
      this.log.push(`carrier: ${JSON.stringify(message)}`);
      if (this.log.length > 200) this.log.shift();
    });
    const entry = resolveDshEntry();
    this.dsh = entry
      ? new HarnessWebProcess(
          { command: process.execPath, args: [entry, "--profile", "web", "--no-open", "--port", "0"] },
          "DeepSeek Harness",
        )
      : null;
  }

  recentLog(lines = 40): string[] {
    return this.log.slice(-lines);
  }

  carrierRunning(): boolean {
    return this.carrier.running;
  }

  list(): WindowView[] {
    return [...this.windows.values()].map((open) => ({ ...open.view, url: "" }));
  }

  /** Opens the dsh window (or reuses it) and returns a fresh embeddable URL. */
  async openDsh(): Promise<WindowView> {
    if (!this.dsh) throw new Error("dsh is not installed in a known npm global location");
    const existing = [...this.windows.values()].find((open) => open.view.harness === "dsh");
    if (existing) return this.viewWithTicket(existing);

    const endpoint = await this.dsh.ensure();
    this.log.push(`dsh web published 127.0.0.1:${endpoint.port}`);

    const id = `win-${++this.counter}`;
    const relay = await createRelay(endpoint.port, relayPath(this.dataDir, id));
    const carrierPort = await freePort();
    const target: CarrierTarget = {
      id,
      bind: "127.0.0.1",
      port: carrierPort,
      upstream: relay.path,
      authority: `127.0.0.1:${endpoint.port}`,
      credential: { kind: "query-token", path: "/", parameter: "token", token: endpoint.token },
      generation: "1",
    };
    const answer = await this.carrier.setTarget(target);
    if (answer.type !== "listening") {
      await relay.close();
      throw new Error(answer.type === "failed" ? answer.reason : "carrier did not confirm the target");
    }
    const open: OpenWindow = {
      view: {
        id,
        harness: "dsh",
        label: "DeepSeek Harness",
        createdAt: new Date().toISOString(),
      },
      relay,
      carrierPort,
    };
    this.windows.set(id, open);
    return this.viewWithTicket(open);
  }

  /** Mints a single-use ticket for a window and returns the carrier entry URL. */
  ticket(id: string): WindowView | null {
    const open = this.windows.get(id);
    return open ? this.viewWithTicket(open) : null;
  }

  async close(id: string): Promise<boolean> {
    const open = this.windows.get(id);
    if (!open) return false;
    this.windows.delete(id);
    this.carrier.removeTarget(id);
    await open.relay.close();
    if (this.windows.size === 0) this.dsh?.stop();
    return true;
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.windows.keys()]) await this.close(id);
    this.dsh?.stop();
    this.carrier.close();
  }

  private viewWithTicket(open: OpenWindow): WindowView {
    const ticket = randomBytes(24).toString("base64url");
    const issued = this.carrier.addTicket(open.view.id, ticket, Date.now() + 120_000);
    if (!issued) throw new Error("the carrier is not ready");
    return {
      ...open.view,
      url: `http://127.0.0.1:${open.carrierPort}/__multiservers/enter?ticket=${ticket}`,
    };
  }
}
