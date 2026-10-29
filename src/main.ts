import { loadConfig } from "./config.js";
import { createApp } from "./server/app.js";

const config = loadConfig();
const { app, close } = await createApp(config);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  try {
    await close();
  } finally {
    process.exit(0);
  }
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

await app.listen({ host: config.bind, port: config.port });
console.log(`[multiservers] listening on http://${config.bind}:${config.port}/`);
