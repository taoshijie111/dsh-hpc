# dsh-multiservers

DeepSeek Harness plugin: manage remote servers and operate them over SSH.

Exposes 12 tools to the model — server registry, connectivity/host-key checks, capability probing,
command execution, SFTP file operations and transfers. No separate UI, no daemon: the plugin runs
inside DSH and stores passwords in DSH's own credential store (the same place provider API keys live).

## Tools (14)

| Group | Tool | Purpose |
| --- | --- | --- |
| Servers | `server_list` | List configured servers, auth mode and pin state |
| | `server_add` / `server_remove` | Register / remove a server; passwords live in the credential store |
| | `server_test` | Reachability, latency, host fingerprint, optional pin |
| | `server_probe` | Read-only capability profile (OS, schedulers, rsync, tmux, storage) |
| Connection | `server_connect` / `server_disconnect` | Explicit login / logout; connections are pooled and reused |
| | `server_status` | Live connections, idle time, sessions |
| Session | `shell_open` / `shell_run` / `shell_close` | Named sticky shells: `cd`, exports and module loads persist; commands run serially |
| | `session_list` | All sessions across servers |
| Transfer | `upload` / `download` | SFTP single file, resume from the existing partial size, sha256 verification |

Linux commands are not wrapped: after `shell_open`, the agent runs `ls`, `mkdir`, `rm`, `grep`, `sbatch`
and anything else directly in the session.

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
