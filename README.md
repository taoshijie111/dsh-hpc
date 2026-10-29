# dsh-hpc

Repository: https://github.com/taoshijie111/dsh-hpc

A DeepSeek Harness plugin for HPC and remote server work: pooled SSH connections, sticky
shell sessions, Slurm and bare-metal background jobs with completion notices, resumable
single-file/directory/queue transfers, and a settings panel with live resource sampling.

The model gets a small, explicit tool surface — probe a host, run a command, list a directory,
upload or download a file — while servers and credentials are configured once and checked
(host keys pinned) before use.

> Previous direction (a standalone local workbench that embedded harness UIs) was archived under
> [docs/archive/](docs/archive/). The product is now a DSH bundle: see
> [docs/requirements.md](docs/requirements.md).

## Repository layout

```
packages/dsh-hpc/   the plugin bundle (host half; settings card is the next slice)
scripts/dev/ssh-probe.mjs    standalone read-only endpoint probe used during development
docs/requirements.md         requirements v1.0 and verification record
docs/archive/                superseded designs
```

## Quick start

```bash
npm install
npm run build
npm test                              # 16 integration checks against a real SSH host

dsh --profile mss --from-default-profile web --dump-config
dsh plugin --profile mss add ./packages/dsh-hpc
dsh --profile mss --port 4400
```

Then open the printed URL, choose a workspace, and ask the agent to run `server_probe` on a
configured server.

## Contract baseline

DSH `>= 0.2.1-rc.2 < 0.3.0`. Built against `@deepseek-ai/dsh-tools`, `dsh-credentials`,
`dsh-settings`, `cordis` and `schemastery` peer packages resolved from the host.
