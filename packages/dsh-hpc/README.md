# dsh-hpc

A DeepSeek Harness plugin for HPC and remote server work. It turns DSH into a practical
remote-computing console: pooled SSH connections, sticky shell sessions, scheduler-aware
background jobs, resumable transfers, and a settings page with live resource sampling.

> Status: v0.1.0 — first public release.

## Features

- **Pooled SSH connections** — one authenticated connection per server, shared by tools and
  the settings page; keepalive plus idle reaping.
- **Sticky shell sessions** — named login shells keep `cd`, exports and `module load`
  across calls; commands in one session run serially; a timeout restarts only that session.
- **Scheduler-aware jobs** — `kind: auto|bare|slurm|pbs|lsf`. Slurm is submitted with
  `sbatch` and reconciled through `squeue`/`sacct`; bare metal runs as a detached
  `setsid`/`nohup` process. A host-side watcher polls only job state (adaptive backoff, no
  remote sampler logs) and settles a DSH background job, so the session receives a
  completion notice instead of polling.
- **Resumable transfers** — single file, directory tree, or queued batch; every file is
  staged as `.part` and sha256-verified before an atomic rename, and resumes from the
  existing partial size in both directions. `background: true` runs transfers as DSH
  background jobs: progress via `job_output`, cancellation via `job_kill`.
- **Settings panel** — manage servers from DSH Settings → 服务器, detect the scheduler type,
  and sample CPU / memory / GPU / disk through a temporary connection that disconnects right
  after sampling. Slurm servers show cluster capacity instead of the login node.
- **Port forwarding** — local TCP tunnels through the pooled connection (Jupyter,
  TensorBoard, database ports on compute nodes).

## Requirements

- DeepSeek Harness `>=0.2.1-rc.2 <0.3.0` (Web UI for the settings page).
- Node.js 24.
- SSH access to the target machines (password, key, optional key passphrase, or
  keyboard-interactive/MFA).

## Install

The plugin follows the standard DSH plugin contract (`dsh.bundle.patch` plus an optional
client half), so it installs like any other DSH plugin.

From npm:

```bash
dsh plugin --profile web add dsh-hpc
```

From a local checkout or tarball:

```bash
git clone https://github.com/taoshijie111/dsh-hpc && cd dsh-hpc
npm install
npm run build
dsh plugin --profile web add "$PWD/packages/dsh-hpc"   # or the built .tgz
```

Restart DSH, then open **Settings → dsh-hpc**.

> **Do not inject the plugin through the profile's `cordis.patch.yml`.** A patch-layer entry
> overrides plugin configuration, so the settings page refuses to save and reports
> `Configuration for "hpc" is overridden by a home patch or command-line overlay`. Install it
> as a bundle (`dsh plugin add`, a local directory/tarball, or the desktop plugin manager) and
> let the settings page own the configuration.

### Troubleshooting the install

`ssh2` carries an optional native extra (`cpu-features`), whose build script pnpm blocks by
default. On the first install pnpm may print `Run "pnpm approve-builds"` and the plugin
command can exit non-zero even though the layer was written. Either:

- run the same `dsh plugin add ...` command again — the second run is a no-op and exits 0; or
- approve the dependency once: `cd ~/.dsh/profiles/<profile> && pnpm approve-builds`; or
- install without dependency build scripts: `dsh plugin --profile web add --ignore-scripts dsh-hpc`.

Verify the profile picked the plugin up:

```bash
dsh --profile web --dump-config | grep -A2 '# == dsh-hpc'
```

## Configure servers

Add a server in the settings page (or with the `server_add` tool). Passwords are written to
the DSH credential store — never into plugin configuration:

```jsonc
{
  "servers": [
    {
      "id": "login01",
      "host": "login01.example.org",
      "username": "alice",
      "auth": "password",          // or "key"
      "passwordRef": "HPC_LOGIN01_PASSWORD",
      "kind": "auto",              // auto detects slurm / pbs / lsf / bare metal
      "schedulerDefaults": { "partition": "gpu", "account": "mylab", "time": "24:00:00" },
      "jobRoot": "~/.dsh-hpc/jobs"
    }
  ]
}
```

### Two-factor authentication (6-digit codes)

When a server asks for a one-time verification code (keyboard-interactive), the agent asks the
user for the current code in the conversation and then calls:

```text
server_connect(server: "mfa-login", otp: "123456")
```

The code establishes the pooled SSH connection once; every later tool call reuses it without
asking again. A new code is needed only after the connection is lost (idle timeout,
`server_disconnect`, network failure or host reboot). Password-looking prompts are answered
from the credential store; verification-code prompts receive `otp`.

The settings page cannot prompt for a code, so for 2FA servers connect once from the chat
(`server_connect`) before using "检测类型"/"资源占用" — sampling then reuses the pooled connection.

`server_test(profile: true)` reports reachability, the host-key fingerprint and the detected
scheduler; approve the fingerprint in the settings page (the agent never pins it silently).

## Tools (17)

| Group | Tools |
| --- | --- |
| Servers | `server_list`, `server_add`, `server_remove`, `server_test`, `server_connect`, `server_disconnect` |
| Shell | `shell_run`, `shell_close` |
| Jobs | `job_submit`, `job_status`, `job_logs`, `job_wait`, `job_cancel` |
| Transfer | `upload`, `download`, `transfer_queue` |
| Network | `forward` |

Destinations use explicit parent directories: `upload(localPath, remoteDir)` writes
`<remoteDir>/<basename(localPath)>`, `download(remotePath, localDir)` writes
`<localDir>/<basename(remotePath)>`, and `transfer_queue` items are
`{"source": "...", "targetDir": "..."}`.

## Security

- Credentials live in the DSH credential store; plugin configuration only stores references.
- Host keys are verified against a pinned fingerprint; a mismatch refuses the connection.
- Settings-page endpoints are same-origin and require the `x-hpc-request: 1` header.
- Transfer scripts are staged with mode `0700`; no secrets are written to remote scripts.

## Development

```bash
cd packages/dsh-hpc
npm install
npm run build        # tsc + client syntax gate
npm run typecheck
```

Integration tests run against real SSH hosts and are skipped unless the environment is
provided:

```bash
export HPC_TEST_HOST_A=test-slurm-host HPC_TEST_USER=testuser HPC_TEST_PASSWORD_A=***
export HPC_TEST_HOST_B=test-bare-host  HPC_TEST_PASSWORD_B=***
npm run test:jobs        # scheduler + watcher end-to-end
npm run test:transfer    # single file / directory / binary / resume / overwrite
npm run test:transfer:queue
npm run test:transfer:big   # GB-scale benchmark
npm run test:parent-dir     # explicit parent-directory semantics
npm run test:tools
npm run test:session
```

## Configuration reference

| Field | Default | Meaning |
| --- | --- | --- |
| `connectTimeoutMs` | 15000 | SSH connect timeout |
| `commandTimeoutMs` | 120000 | Default shell command timeout |
| `keepaliveIntervalMs` | 30000 | TCP keepalive probe interval |
| `idleTimeoutMs` | 600000 | Close idle connections (0 = never) |
| `maxSessionsPerServer` | 4 | Named shell sessions per server |
| `sessionIdleTimeoutMs` | 1800000 | Reap idle shell sessions (0 = never) |

Per-server fields: `id`, `host`, `port`, `username`, `label`, `auth`, `passwordRef`,
`keyPath`, `keyPassphraseRef`, `hostKey`, `kind`, `resolvedKind`, `schedulerDefaults`,
`jobRoot`.

## License

MIT — see [LICENSE](../../LICENSE).
