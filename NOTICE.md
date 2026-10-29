# Third-party provenance

## Project Citadel (own project, reused code)

The following source files were ported from `project-citadel-dev-main` (the author's own
project, reused with the author's explicit permission):

| This repository | Origin | Notes |
| --- | --- | --- |
| `packages/carrier-protocol/src/index.ts` | `packages/carrier-protocol/src/index.ts` | package renamed `@citadel/*` → `@hpc/*`; entry path `/__citadel/enter` → `/__hpc/enter` |
| `packages/web-carrier/src/carrier.ts` | `packages/web-carrier/src/carrier.ts` | cookie prefix `citadel_page_` → `hpc_page_`; user-facing strings renamed |
| `packages/web-carrier/src/main.ts` | `packages/web-carrier/src/main.ts` | import renamed |
| `scripts/dev/carrier-smoke.mjs` | new (inspired by Citadel's carrier design) | integration smoke test for this repository |

The carrier's security model is preserved unchanged: one listening origin per target,
one-time ticket exchanged for an HttpOnly `SameSite=Strict` pass, browser cookies never
forwarded upstream, hop-by-hop headers filtered, `X-Frame-Options`/`frame-ancestors`
removed so the page can be embedded, WebSocket upgrades proxied.

## Runtime dependencies

| Package | License | Use |
| --- | --- | --- |
| `zod` | MIT | contract validation |
| `ssh2` | MIT | SSH transport (endpoint connect/exec/transfer) |
| `typescript`, `tsx`, `@types/*` | Apache-2.0 / MIT | development only |
