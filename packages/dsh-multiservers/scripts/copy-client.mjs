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

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = join(root, "src", "client", "index.cjs");
const output = join(root, "lib", "client.cjs");

mkdirSync(join(root, "lib"), { recursive: true });
copyFileSync(source, output);
console.log(`client half -> ${output}`);
