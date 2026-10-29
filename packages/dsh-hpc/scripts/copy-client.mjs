#!/usr/bin/env node
/**
 * Copy the hand-written browser half into the package's build output.
 *
 * The DSH client module loader expects a lazy-CJS factory file; we keep the
 * source as plain CJS (no JSX build step) and ship it verbatim.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = join(root, "src", "client", "index.cjs");
const output = join(root, "lib", "client.cjs");

// A syntax error here would make the whole client plugin fail to import at boot;
// check before shipping rather than after a manual reload.
const syntax = spawnSync(process.execPath, ["--check", source], { encoding: "utf8" });
if (syntax.status !== 0) {
  console.error(syntax.stderr || syntax.stdout);
  process.exit(syntax.status ?? 1);
}

mkdirSync(join(root, "lib"), { recursive: true });
copyFileSync(source, output);
console.log(`client half -> ${output} (syntax ok)`);
