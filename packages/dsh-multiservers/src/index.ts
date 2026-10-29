import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { ConnectionPool } from "./core/pool.js";
import { SessionRegistry } from "./core/session.js";
import { registerApi, setApiContext } from "./api.js";
import { registerTools } from "./tools.js";
import type { Config as ConfigShape } from "./core/types.js";

/**
 * dsh-multiservers — remote server management for DeepSeek Harness.
 *
 * Host half: connections, named shell sessions, transfers, tools. The browser
 * half adds the "服务器" settings page.
 *
 * Every field is `.volatile()` so the settings page can edit it while the plugin
 * keeps running; tools read the live section instead of the apply-time snapshot.
 */
export const name = "dsh-multiservers";

/** Services that must be ready before this plugin registers its tools. */
export const inject = ["tools", "credentials"];

export type { ServerSpec } from "./core/types.js";

export const Config = Schema.object({
  servers: Schema.array(
    Schema.object({
      id: Schema.string().required().description("Stable id used by tools, e.g. hpc1."),
      label: Schema.string().description("Human-readable label."),
      host: Schema.string().required().description("Hostname or IP address."),
      port: Schema.number().default(22).description("SSH port."),
      username: Schema.string().required().description("Login user."),
      auth: Schema.union(["password", "key"]).default("password").description("Authentication mode."),
      passwordRef: Schema.string().description(
        "Credential reference holding the password (POSIX identifier). Defaults to MSS_<ID>_PASSWORD.",
      ),
      keyPath: Schema.string().description("Absolute local private key path for key auth."),
      hostKey: Schema.string().description("Pinned host key fingerprint, e.g. SHA256:...; empty pins on first test."),
    }),
  )
    .default([])
    .description("Remote servers this workspace can operate.")
    .volatile(),
  connectTimeoutMs: Schema.number().default(15000).description("SSH connect timeout in milliseconds.").volatile(),
  commandTimeoutMs: Schema.number()
    .default(120000)
    .description("Default shell command timeout in milliseconds.")
    .volatile(),
  keepaliveIntervalMs: Schema.number()
    .default(30000)
    .description("TCP keepalive probe interval in milliseconds; 0 disables.")
    .volatile(),
  idleTimeoutMs: Schema.number()
    .default(600000)
    .description("Close idle connections after this many milliseconds; 0 disables.")
    .volatile(),
  maxSessionsPerServer: Schema.number().default(4).description("Named shell sessions allowed per server.").volatile(),
  sessionIdleTimeoutMs: Schema.number()
    .default(1800000)
    .description("Close idle shell sessions after this many milliseconds; 0 disables.")
    .volatile(),
});

/** Live section while the settings service is mounted; apply-time config otherwise. */
export function liveConfig(ctx: Context, fallback: ConfigShape): ConfigShape {
  const settings = ctx.get("settings") as
    | { describe(options?: { redactSecrets?: boolean }): Array<{ ns: string; value?: unknown }> }
    | undefined;
  if (!settings) return fallback;
  try {
    const own = settings.describe().find((entry) => entry.ns === "multiservers");
    const value = own?.value as ConfigShape | undefined;
    if (value && Array.isArray(value.servers)) return { ...fallback, ...value };
  } catch {
    /* fall back to the apply-time configuration */
  }
  return fallback;
}

export function apply(ctx: Context, config: ConfigShape): void {
  const live = () => liveConfig(ctx, config);
  const pool = new ConnectionPool({
    connectTimeoutMs: () => live().connectTimeoutMs ?? 15000,
    keepaliveIntervalMs: () => live().keepaliveIntervalMs ?? 30000,
    idleTimeoutMs: () => live().idleTimeoutMs ?? 600000,
  });
  const sessions = new SessionRegistry(pool, {
    maxPerServer: () => live().maxSessionsPerServer ?? 4,
    idleTimeoutMs: () => live().sessionIdleTimeoutMs ?? 1_800_000,
  });
  registerTools(ctx, live, pool, sessions);
  setApiContext(ctx);
  ctx.inject(["webServer"], (injected) => {
    const webServer = (injected as unknown as { webServer?: { register(route: never): () => void } }).webServer;
    if (webServer?.register) registerApi(webServer as never, live, pool, sessions);
  });
  ctx.effect(
    () => () => {
      void sessions
        .closeAll()
        .catch(() => undefined)
        .then(() => pool.closeAll())
        .catch(() => undefined);
    },
    "dsh-multiservers: close connections on unload",
  );
}
