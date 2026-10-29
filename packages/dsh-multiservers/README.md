# dsh-multiservers

DeepSeek Harness plugin: manage remote servers and operate them over SSH.

Exposes 12 tools to the model — server registry, connectivity/host-key checks, capability probing,
command execution, SFTP file operations and transfers. No separate UI, no daemon: the plugin runs
inside DSH and stores passwords in DSH's own credential store (the same place provider API keys live).

## Tools (14)

| Group | Tool | Purpose |
| --- | --- | --- |
| Servers | `server_list` | Config + live state: connection, idle time, sessions, forwards |
| | `server_add` / `server_remove` | Upsert / remove a server (no secrets in tool arguments) |
| | `server_test` | Reachability, latency, host fingerprint; `profile=true` adds the capability profile |
| | `server_disconnect` | Close sessions, forwards and the connection |
| Shell | `shell_run` | Named sticky session (created on demand); capped output; timeout resets only that session |
| | `shell_close` | Close one named session |
| Transfer | `upload` / `download` | File or directory tree; `.part` staging + sha256, resume from partial size |
| Network | `forward` | Local TCP forward through the pooled connection (Jupyter/TensorBoard) |
| Jobs | `job_submit` / `job_status` / `job_logs` / `job_wait` / `job_cancel` | Long-running jobs: Slurm (`sbatch`, `squeue`/`sacct`, `scancel`) or bare metal (`setsid`+`nohup`, pid + exit-code file). Server `kind: auto` detects and caches the backend; `schedulerDefaults` supply partition/account/qos/time/cpus/mem/gpus; scripts and logs live under `jobRoot`. Transfers cover single files, directory trees, binary content, `.part` resume in both directions and an overwrite guard (`test:transfer`). Large transfers: chunk size adapts to file size (256 KB → 8 MB), results report `durationMs`/`throughputMBps`, `background: true` runs the transfer as a DSH background job (progress via `job_output`, cancel via `job_kill`), and downloads use pipelined `fastGet`. `test:transfer:big` benchmarks GB-scale files. `job_submit` also starts a host-side watcher (a DSH background job owned by the session) that polls only job state with adaptive backoff — no remote sampler, no growing watch logs — and the session receives a completion notice when the job ends. |

Authentication: password or key, plus an optional key passphrase credential; keyboard-interactive
(multi-factor) prompts are answered with the same stored secret. Connections are pooled; sessions
and connections are reaped on idle (configurable in DSH Settings → 服务器).

## Settings status page

DSH Settings → 服务器 shows live server state: online/offline, active sessions, forwarded ports.
Each row has a **资源占用** action that samples the machine over the pooled SSH connection and renders
load, memory, CPU, GPU (`nvidia-smi`/`rocm-smi`), disks and the user's scheduler jobs. A **刷新**
button re-reads the connection state. The page calls two host endpoints
(`/api/multiservers/status`, `/api/multiservers/usage`) that require the `x-multiservers-request: 1`
same-origin header.

## Install

```bash
npm run build

# fresh profile is recommended
dsh --profile mss --from-default-profile web --dump-config
dsh plugin --profile mss add <path-to-this-package>
dsh --profile mss --port 4400
```

## Configuration

```yaml
- id: multiservers
  name: dsh-multiservers
  config:
    servers:
      - id: hpc1
        label: HPC login node
        host: 114.214.255.60
        port: 22
        username: taoshijie
        auth: key              # password | key
        keyPath: C:/Users/you/.ssh/id_ed25519
        hostKey: SHA256:...    # pin on first server_test if empty
    connectTimeoutMs: 20000
    commandTimeoutMs: 120000
```

Password authentication never puts the secret in this file: set the credential
`MSS_<ID>_PASSWORD` in DSH's credential store (Settings → Models/credentials, or `server_add`).

## Development

```bash
npm run build
npm run typecheck
MSS_TEST_HOST=<host> MSS_TEST_USER=<user> MSS_TEST_KEY=<key> node test/tools-smoke.mjs
```


## Settings page

The client half adds a **Servers** section to DSH Settings (registered into the
`settings.section` slot). It lists configured servers, adds new ones (id, label, host, port,
user, auth mode, key path or password, optional pinned fingerprint) and removes them.

- Non-secret fields are written through the client `configForms` service.
- Passwords are written through `remote.credentials` into DSH's credential store as
  `MSS_<ID>_PASSWORD`; they never enter the profile configuration.
- The page only appears while the Host serves the `multiservers` settings namespace
  (`configForms.whileServed`).

Editing an existing server and a "test connection" action are the next increments.
