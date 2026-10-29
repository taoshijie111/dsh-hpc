import { resolve } from "node:path";

export type Config = {
  /** Local runtime state (window registry, logs). Never holds credentials in the demo. */
  dataDir: string;
  bind: string;
  port: number;
};

export function loadConfig(): Config {
  const dataDir = resolve(process.env.MULTISERVERS_DATA_DIR ?? ".multiservers");
  const bind = process.env.MULTISERVERS_BIND ?? "127.0.0.1";
  const rawPort = process.env.MULTISERVERS_PORT ?? "4390";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`MULTISERVERS_PORT must be a port number, received "${rawPort}"`);
  }
  return { dataDir, bind, port };
}
