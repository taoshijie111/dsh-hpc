import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { discoverHarnesses } from "../core/harnesses.js";
import { WindowManager } from "../core/window-manager.js";
import type { Config } from "../config.js";

export type App = {
  app: FastifyInstance;
  windows: WindowManager;
  close(): Promise<void>;
};

export async function createApp(config: Config, options: { logger?: boolean } = {}): Promise<App> {
  const windows = new WindowManager(config.dataDir);
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: 64 * 1024 });

  app.get("/health", async () => ({
    ok: true,
    service: "multiservers",
    version: "0.1.0",
    uptimeSeconds: Math.floor(process.uptime()),
    carrierRunning: windows.carrierRunning(),
    windows: windows.list().length,
  }));

  app.get("/api/status", async () => ({
    harnesses: discoverHarnesses(),
    windows: windows.list(),
    log: windows.recentLog(30),
  }));

  app.post<{ Body: { harness?: string } }>("/api/windows", async (request, reply) => {
    const harness = request.body?.harness ?? "dsh";
    if (harness !== "dsh") {
      return reply.code(400).send({ error: `harness "${harness}" is not wired for windows yet` });
    }
    try {
      return await windows.openDsh();
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { id: string } }>("/api/windows/:id/ticket", async (request, reply) => {
    const view = windows.ticket(request.params.id);
    if (!view) return reply.code(404).send({ error: "unknown window" });
    return view;
  });

  app.delete<{ Params: { id: string } }>("/api/windows/:id", async (request) => ({
    closed: await windows.close(request.params.id),
  }));

  app.get("/api/log", async () => ({ log: windows.recentLog(100) }));

  const webRoot = [resolve("src/web"), resolve("dist/web")].find((dir) => existsSync(join(dir, "index.html")));
  if (webRoot) {
    await app.register(fastifyStatic, { root: webRoot, prefix: "/" });
  }

  return {
    app,
    windows,
    async close() {
      await windows.closeAll();
      await app.close();
    },
  };
}
