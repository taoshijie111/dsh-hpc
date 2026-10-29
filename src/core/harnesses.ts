import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Harness discovery. A harness is a separately installed coding agent CLI; the
 * window layer shows its own interface and never reimplements it.
 *
 * `web` harnesses expose a local HTTP UI (we embed it through the carrier);
 * `tui` harnesses only have a terminal interface (later: PTY window).
 */
export type HarnessKind = "web" | "tui";
export type Harness = {
  id: string;
  label: string;
  kind: HarnessKind;
  available: boolean;
  version: string | null;
  /** How to start the web UI, when kind is "web". */
  launch: { command: string; args: string[] } | null;
  reason: string | null;
};

/** npm global root candidates for a Node-installed CLI. */
function npmGlobalRoots(): string[] {
  const roots: string[] = [];
  if (process.env.APPDATA) roots.push(join(process.env.APPDATA, "npm", "node_modules"));
  roots.push(join(homedir(), ".npm-global", "lib", "node_modules"));
  roots.push("/usr/local/lib/node_modules");
  roots.push("/usr/lib/node_modules");
  return roots;
}

function findNodeCli(packageName: string, entry: string): string | null {
  for (const root of npmGlobalRoots()) {
    const candidate = join(root, ...packageName.split("/"), entry);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** The dsh package's real entry, so we can spawn node directly (no shell, no .cmd shim). */
export function resolveDshEntry(): string | null {
  const override = process.env.MULTISERVERS_DSH_BIN;
  if (override && existsSync(override)) return override;
  return findNodeCli("@deepseek-ai/dsh", join("lib", "bin.js"));
}

function packageVersionOf(entry: string): string | null {
  // <root>/@scope/name/lib/bin.js → <root>/@scope/name/package.json
  const packageJson = join(entry, "..", "..", "package.json");
  try {
    const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export function discoverHarnesses(): Harness[] {
  const dshEntry = resolveDshEntry();
  return [
    {
      id: "dsh",
      label: "DeepSeek Harness",
      kind: "web",
      available: Boolean(dshEntry),
      version: dshEntry ? packageVersionOf(dshEntry) : null,
      launch: dshEntry
        ? { command: process.execPath, args: [dshEntry, "--profile", "web", "--no-open", "--port", "0"] }
        : null,
      reason: dshEntry ? null : "dsh CLI not found in a known npm global location",
    },
    {
      id: "kimi",
      label: "Kimi Code",
      kind: "web",
      // Present but not wired yet; the window layer reports this honestly instead of failing later.
      available: false,
      version: null,
      launch: null,
      reason: "Kimi web hosting is not wired yet (S1-b scope is dsh)",
    },
    {
      id: "codex",
      label: "Codex CLI",
      kind: "tui",
      available: false,
      version: null,
      launch: null,
      reason: "TUI window (PTY) is the next slice",
    },
  ];
}
