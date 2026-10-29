import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { registerTools } from "./tools.js";
import type { Config as ConfigShape } from "./core/types.js";

/**
 * dsh-multiservers — remote server management for DeepSeek Harness.
 *
 * Host half only: configuration + tools. The web settings card is a later
 * slice; servers can be added with the `server_add` tool today.
 */
export const name = "dsh-multiservers";

/** Services that must be ready before this plugin registers its tools. */
export const inject = ["tools", "credentials"];

export type { ServerSpec } from "./core/types.js";

export const Config: Schema<ConfigShape> = Schema.object({
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
    .description("Remote servers this workspace can operate."),
  connectTimeoutMs: Schema.number().default(15000).description("SSH connect timeout in milliseconds."),
  commandTimeoutMs: Schema.number().default(120000).description("Default remote command timeout in milliseconds."),
});

export function apply(ctx: Context, config: ConfigShape): void {
  registerTools(ctx, () => config);
}
