# dsh-hpc

**A unified remote-server control plane for DeepSeek Harness agents.**

`dsh-hpc` is a [DeepSeek Harness](https://github.com/deepseek-ai) plugin that gives an agent
one stateful, safe interface to heterogeneous remote machines — HPC clusters behind Slurm,
bare-metal workstations, and plain SSH servers — instead of forcing it to assemble ad-hoc
`ssh`/`scp`/`sbatch` incantations. Connections, shell state, long-running jobs, file
transfers, forwarded ports, and credentials are managed by the plugin; the agent composes
16 narrow tools, and a human manages servers from a DSH settings panel.

## Why this exists

An LLM agent is good at composing commands and poor at owning state. Without a control
plane, remote work degrades into a sequence of fragile one-off shell calls:

| Problem | Consequence | What `dsh-hpc` does |
| --- | --- | --- |
| A login per command | latency, session quota exhaustion | one pooled SSH connection per server, shared by every call |
| Stateless shells | `cd`, `export`, `module load` vanish between calls | named sticky sessions with serialized execution |
| SSH disconnect kills work | multi-day DFT/training runs die with the console | jobs detached through the scheduler or `setsid`; SSH is only a control channel |
| Scheduler heterogeneity | the agent must know Slurm/PBS/LSF/bare-metal dialects | one job model, server `kind` auto-detected, backend adapters |
| Long jobs need polling | wasted turns, fragile "watch logs" loops | host-side watcher settles a DSH background job → event-driven completion notice |
| Fragile transfers | partial files, unverified copies, no resume | `.part` staging, sha256 on both sides, atomic rename, resume in both directions |
| Secrets in prompts/config | credential leakage into logs and transcripts | credentials live only in the DSH credential store; config holds references |

## Architecture

```
                       ┌──────────────────────────────┐
                       │        DSH agent (LLM)       │
                       └──────────────┬───────────────┘
                                      │ tool calls / background-job notices
              ┌───────────────────────▼────────────────────────┐
              │                  dsh-hpc plugin                │
              │  ┌──────────────────────────────────────────┐  │
              │  │ tools: servers · shell · jobs · transfer  │  │
              │  │        · forwarding                       │  │
              │  ├──────────────────────────────────────────┤  │
              │  │ runtime: ConnectionPool · SessionRegistry│  │
              │  │          JobManager + watcher · xfer queue│ │
              │  ├──────────────────────────────────────────┤  │
              │  │ transport: ssh2 (exec/shell/sftp/forward) │ │
              │  ├──────────────────────────────────────────┤  │
              │  │ host: credential store · settings · DSH   │ │
              │  │       background-job registry             │ │
              │  └──────────────────────────────────────────┘  │
              └───────────────────────┬────────────────────────┘
                                      │ SSH
             ┌────────────────────────┼─────────────────────────┐
             ▼                        ▼                         ▼
     ┌───────────────┐        ┌───────────────┐         ┌──────────────┐
     │ Slurm cluster │        │ bare metal    │         │ PBS/LSF host │
     │ sbatch/squeue │        │ setsid/nohup  │         │ detect-only  │
     └───────────────┘        └───────────────┘         └──────────────┘
```

## Design principles

1. **Stateful session abstraction over stateless RPC.** The agent talks to a session, not to
   a fresh shell. Connection, working directory, environment, and job history survive across
   calls; the plugin owns their lifecycle.
2. **Capabilities, not command wrappers.** There is no `ls`/`cat`/`mkdir` tool. Once a session
   exists, the agent uses real shell commands; the tools exist only for what a shell cannot do
   reliably — lifecycle, binaries, schedulers, and event delivery.
3. **Explicit ownership and lifecycle.** Connections are pooled and idle-reaped; sessions are
   named, capped, and reaped; jobs have a durable ledger; transfers stage, verify, and resume;
   every long-running operation can be cancelled and is observable.
4. **Heterogeneity behind one model.** `server.kind` is `auto | bare | slurm | pbs | lsf`.
   `auto` probes the machine once and caches the result; tools route to the right backend
   without the model branching on scheduler dialects.
5. **Event-driven completion instead of polling.** A job’s watcher polls only state (with
   adaptive backoff) and never writes remote logs; when it settles, the session receives a
   DSH background-job completion notice, so the agent can continue and report.
6. **Security by construction.** Passwords and key passphrases live in the DSH credential
   store; plugin configuration stores references only. Host keys are pinned by fingerprint;
   a mismatch refuses the connection. Remote scripts are staged with mode `0700`.

## Capabilities

### Connections and sessions

- One multiplexed SSH connection per server, reused by tools, settings, and background work;
  keepalive probes; idle reaper that never closes a connection with live sessions.
- Password, private key, key passphrase, and keyboard-interactive (MFA) authentication.
- Named sticky shells (`main`, `build`, `logs`, …) with per-session working directory and
  environment, serialized command execution, bounded output capture, and timeout recovery
  that restarts only the affected session.

### Scheduler-aware jobs

- One `job_submit` API for Slurm (`sbatch --parsable`, `squeue` → `sacct` reconciliation,
  accounting-lag tolerated as `unknown`) and bare metal (`setsid` + `nohup`, PID plus
  `/proc` start-time identity check, exit-code file).
- Durable job ledger under the DSH home: survives plugin reloads and is re-conciled against
  the scheduler or process on the next access.
- Host-side watcher with adaptive backoff: completion notifications, not polling loops.
  `job_wait` covers short jobs; `job_logs` reads incrementally with bounded output.
- Per-server `schedulerDefaults` (partition, account, QOS, time, CPUs, memory, GPUs) with
  per-job overrides; job ids are unique so an interrupted submission can be recovered by name.

### Transfers

- Single file, directory tree, and queued batches; every file is staged as `<target>.part`,
  sha256-verified on both sides, then atomically renamed. Interrupted transfers resume from
  the existing partial size, in both directions.
- Explicit destination parent directories (`remoteDir` / `localDir`); directories are created
  only where the caller asked.
- Adaptive chunking (256 KB → 8 MB), pipelined `fastGet` downloads, and measured throughput
  returned with every result (`durationMs`, `throughputMBps`).
- `background: true` runs a transfer as a DSH background job — live progress through
  `job_output`, cancellation through `job_kill`, completion through the same notice channel
  as remote jobs.

### Operations and visibility

- Port forwarding through the pooled connection for compute-node services (Jupyter,
  TensorBoard, databases).
- Settings panel: server inventory, scheduler-type detection, and on-demand resource
  sampling (CPU, memory, per-GPU utilization/VRAM, disks, queue depth). Sampling opens a
  dedicated connection and disconnects immediately afterwards; Slurm servers report compute
  node capacity instead of the login node.

## Tools

| Group | Tools | Purpose |
| --- | --- | --- |
| Servers | `server_list`, `server_add`, `server_remove`, `server_test`, `server_disconnect` | inventory, registration, reachability, fingerprint and scheduler detection |
| Shell | `shell_run`, `shell_close` | named sticky sessions |
| Jobs | `job_submit`, `job_status`, `job_logs`, `job_wait`, `job_cancel` | submit, reconcile, stream logs, wait or cancel |
| Transfer | `upload`, `download`, `transfer_queue` | resumable file/directory/batch transfer |
| Network | `forward` | local TCP tunnels through the pooled connection |

Destinations are explicit: `upload(localPath, remoteDir)` writes
`<remoteDir>/<basename(localPath)>`; `download(remotePath, localDir)` writes
`<localDir>/<basename(remotePath)>`; `transfer_queue` items are
`{"source": "...", "targetDir": "..."}`.

## Install

Requires DeepSeek Harness `>=0.2.1-rc.2 <0.3.0` and Node.js 24.

From npm (once published):

```bash
dsh plugin --profile web add dsh-hpc
```

From source:

```bash
git clone https://github.com/taoshijie111/dsh-hpc && cd dsh-hpc
npm install
npm run build
dsh plugin --profile web add "$PWD/packages/dsh-hpc"
```

Restart DSH and open **Settings → 服务器**.

> `ssh2` declares an optional native extra whose build script pnpm blocks by default. If the
> first `dsh plugin add` prints `pnpm approve-builds` and exits non-zero, re-run the same
> command (the layer is already written), run `pnpm approve-builds` in the profile, or use
> `--ignore-scripts`.

## Quick start

```text
# register a cluster once (password goes to the DSH credential store in the settings page)
server_add(id: "login01", host: "login01.example.org", username: "alice", kind: "auto")

# reachability + scheduler detection + host-key fingerprint
server_test(server: "login01", profile: true)

# a persistent shell on that machine; cd/export/module persist across calls
shell_run(server: "login01", command: "cd ~/project && module load gcc/12")
shell_run(server: "login01", command: "make -j8")

# submit a long job; the session is notified when it finishes
job_submit(server: "login01", command: "python train.py", workdir: "/home/alice/project",
           partition: "gpu", cpusPerTask: 8, gpus: 1)

# transfer a result directory back, explicitly into a local parent directory
download(server: "login01", remotePath: "/home/alice/project/results", localDir: "D:/runs/07")
```

## Configuration

Global options (all editable at runtime in the settings page):

| Field | Default | Meaning |
| --- | --- | --- |
| `connectTimeoutMs` | 15000 | SSH connect timeout |
| `commandTimeoutMs` | 120000 | default shell command timeout |
| `keepaliveIntervalMs` | 30000 | TCP keepalive probe interval |
| `idleTimeoutMs` | 600000 | close idle connections (0 = never) |
| `maxSessionsPerServer` | 4 | named shell sessions per server |
| `sessionIdleTimeoutMs` | 1800000 | reap idle sessions (0 = never) |

Per-server: `id`, `host`, `port`, `username`, `label`, `auth` (`password`/`key`),
`passwordRef`, `keyPath`, `keyPassphraseRef`, `hostKey`, `kind`, `resolvedKind`,
`schedulerDefaults`, `jobRoot`.

## Security model

- Credentials never enter plugin configuration, transcripts, or remote scripts; the plugin
  stores references and resolves values through the DSH credential store.
- Host keys are compared against a pinned fingerprint; a changed key refuses the connection
  rather than silently trusting it.
- The settings-page HTTP facade is same-origin and requires the `x-hpc-request: 1` header.
- Remote job and transfer scripts are written with mode `0700`; job roots are caller-chosen.

## Repository layout

```
packages/dsh-hpc/        the plugin (host + browser half)
  src/index.ts           plugin entry, config schema, lifecycle
  src/tools.ts           16 tools and their contracts
  src/api.ts             settings-page HTTP facade (status/usage/detect)
  src/core/              pool, sessions, jobs, watcher, transfers, ssh
  src/client/            settings-page React section (lazy-CJS bundle)
  test/                  integration suites (real SSH hosts, env-gated)
docs/requirements.md     product requirements and accepted behaviour
scripts/dev/             local SSH probe utility
```

## Development and testing

```bash
cd packages/dsh-hpc
npm install
npm run build        # tsc + client syntax gate
npm run typecheck
```

Integration suites target real hosts and are skipped unless the environment is configured:

```bash
export HPC_TEST_HOST_A=slurm-host HPC_TEST_USER=user HPC_TEST_PASSWORD_A=***
export HPC_TEST_HOST_B=bare-host  HPC_TEST_PASSWORD_B=***
npm run test:tools      # tool surface, sessions, transfers, forwarding
npm run test:session    # sticky sessions and timeout semantics
npm run test:jobs       # scheduler + watcher completion notices
npm run test:transfer   # single/directory/binary/resume/overwrite
npm run test:transfer:queue
npm run test:transfer:big   # GB-scale throughput
npm run test:parent-dir     # explicit parent-directory semantics
```

## Status and limitations

v0.1.0 — first public release. Known limits, tracked for later releases:

- Job submission is implemented for Slurm and bare metal; PBS and LSF are detected and
  displayed but not yet submitted to.
- No job arrays or dependency graphs.
- Port forwarding targets hosts reachable from the server (loopback-oriented); no jump-host
  chaining yet.
- One SSH connection per server by design, to respect HPC login-node session quotas.

## License

MIT — see [LICENSE](LICENSE).
