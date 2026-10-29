import { spawn, type ChildProcess } from "node:child_process";

export type WebEndpoint = { port: number; token: string; url: string };

const ADDRESS_LINE = /dsh web: http:\/\/127\.0\.0\.1:(\d{1,5})\/\?token=([A-Za-z0-9_-]{16,256})/g;

/**
 * Owns one harness web server process and discovers its address from the
 * process's own startup output.
 *
 * The harness is started from its real entry with node directly: no shell, no
 * tmux, and no dependency on the harness's internal protocol — only on the
 * address line it publishes. A changed line is reported as a clear failure
 * instead of guessing.
 */
export class HarnessWebProcess {
  private child: ChildProcess | null = null;
  private endpoint: WebEndpoint | null = null;
  private starting: Promise<WebEndpoint> | null = null;
  private readonly log: string[] = [];

  constructor(
    private readonly spec: { command: string; args: string[] },
    private readonly label: string,
    private readonly timeoutMs = 90_000,
  ) {}

  get running(): boolean {
    return this.endpoint !== null && this.child !== null;
  }

  recentLog(lines = 20): string[] {
    return this.log.slice(-lines);
  }

  /** Starts the process once and resolves with the published address. */
  ensure(): Promise<WebEndpoint> {
    if (this.endpoint) return Promise.resolve(this.endpoint);
    this.starting ??= this.start();
    return this.starting;
  }

  private start(): Promise<WebEndpoint> {
    return new Promise<WebEndpoint>((resolve, reject) => {
      const child = spawn(this.spec.command, this.spec.args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      });
      this.child = child;

      let settled = false;
      const finish = (error: Error | null, endpoint?: WebEndpoint) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          this.starting = null;
          reject(error);
          return;
        }
        this.endpoint = endpoint ?? null;
        resolve(endpoint!);
      };

      const timer = setTimeout(() => {
        this.stop();
        finish(new Error(`${this.label} did not publish its address within ${this.timeoutMs} ms`));
      }, this.timeoutMs);

      const onData = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) this.log.push(line.trim());
          if (this.log.length > 200) this.log.shift();
        }
        for (const match of text.matchAll(ADDRESS_LINE)) {
          const port = Number(match[1]);
          const token = match[2]!;
          if (port >= 1 && port <= 65535) {
            finish(null, { port, token, url: `http://127.0.0.1:${port}/?token=${token}` });
          }
        }
      };

      child.stdout?.on("data", onData);
      child.stderr?.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split(/\r?\n/)) if (line.trim()) this.log.push(line.trim());
        if (this.log.length > 200) this.log.shift();
      });

      child.once("error", (error) => finish(new Error(`${this.label} failed to start: ${error.message}`)));
      child.once("exit", (code, signal) => {
        this.child = null;
        this.endpoint = null;
        this.starting = null;
        if (!settled) {
          finish(
            new Error(
              `${this.label} exited before publishing its address (code=${code ?? "null"} signal=${signal ?? "none"})`,
            ),
          );
        }
      });
    });
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.endpoint = null;
    this.starting = null;
    if (!child) return;
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }, 3000).unref();
  }
}
