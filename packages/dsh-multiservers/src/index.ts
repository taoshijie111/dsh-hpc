import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { registerTools } from "./tools.js";
import type { Config as ConfigShape } from "./core/types.js";

/**
 * dsh-multiservers — remote server management for DeepSeek Harness.
 *
 * Host half: configuration, credentials, and tools. The browser half adds the
 * "Servers" settings page.
 *
 * Fields are `.volatile()` because the settings page edits them while the
 * plugin keeps running; every tool call reads the live section instead of the
 * apply-time snapshot (see `liveConfig`).
 */
export const name = "dsh-multiservers";

/** Services that must be ready before this plugin registers its tools. */
export const inject = ["tools", "credentials"];

export type { ServerSpec } from "./core/types.js";

// Schemastery's Volatile<> wrapper changes the static type of an array field;
// the runtime schema is what the Loader validates, so narrow it back here.
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
  commandTimeoutMs: Schema.number().default(120000).description("Default remote command timeout in milliseconds.").volatile(),
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
    if (value && Array.isArray(value.servers)) return value;
  } catch {
    /* fall back to the apply-time configuration */
  }
  return fallback;
}

export function apply(ctx: Context, config: ConfigShape): void {
  registerTools(ctx, () => liveConfig(ctx, config));
}
