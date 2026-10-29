import io, sys

def patch(path, pairs):
    s = io.open(path, encoding='utf-8').read()
    for old, new in pairs:
        if old not in s:
            print('MISS', path, repr(old[:70]))
            sys.exit(1)
        s = s.replace(old, new, 1)
    io.open(path, 'w', encoding='utf-8').write(s)
    print('patched', path)

# ---------- types ----------
patch('src/core/types.ts', [
("""  keyPath?: string;""",
"""  keyPath?: string;
  /** Credential reference holding the private key passphrase. */
  keyPassphraseRef?: string;"""),
("""  maxSessionsPerServer?: number;""",
"""  maxSessionsPerServer?: number;
  /** Close a shell session after this many idle milliseconds; 0 disables. */
  sessionIdleTimeoutMs?: number;"""),
])

# ---------- ssh: passphrase + keyboard-interactive ----------
patch('src/core/ssh.ts', [
("""  if (server.auth === "password") {
    connectConfig.password = await resolvePassword(ctx, server);
  } else {""",
"""  let interactiveSecret: string | undefined;
  if (server.auth === "password") {
    connectConfig.password = await resolvePassword(ctx, server);
    interactiveSecret = connectConfig.password;
  } else {"""),
("""    try {
      connectConfig.privateKey = await readFile(server.keyPath);
    } catch (error) {
      throw new MultiserversError(
        `Cannot read private key for "${server.id}" at ${server.keyPath}: ${(error as Error).message}`,
      );
    }
  }""",
"""    try {
      connectConfig.privateKey = await readFile(server.keyPath);
    } catch (error) {
      throw new MultiserversError(
        `Cannot read private key for "${server.id}" at ${server.keyPath}: ${(error as Error).message}`,
      );
    }
    if (server.keyPassphraseRef) {
      const hit = await ctx.credentials.resolve(credentialRef(server.keyPassphraseRef));
      if (hit?.value) {
        connectConfig.passphrase = hit.value;
        interactiveSecret = hit.value;
      }
    }
  }
  // Keyboard-interactive servers (MFA) receive the same secret for every prompt.
  connectConfig.tryKeyboard = true;
  client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
    finish(interactiveSecret ? prompts.map(() => interactiveSecret) : []);
  });"""),
])

# ---------- session: bounded capture + busy + idle sweep ----------
patch('src/core/session.ts', [
('const MARKER = "\\x1eMSS";', 'const MARKER = "\\x1eMSS";\nconst MAX_BUFFER = 1024 * 1024;'),
("""  durationMs: number;
  cwd: string | null;
};""",
"""  durationMs: number;
  cwd: string | null;
  truncated: boolean;
  totalBytes: number;
};"""),
("""  timer: NodeJS.Timeout | null;
  signal?: AbortSignal;
  onAbort?: () => void;
};""",
"""  timer: NodeJS.Timeout | null;
  signal?: AbortSignal;
  onAbort?: () => void;
  truncated: boolean;
  totalBytes: number;
};"""),
("""  get alive(): boolean {
    return !this.closed && !this.dead && this.stream !== null;
  }""",
"""  get alive(): boolean {
    return !this.closed && !this.dead && this.stream !== null;
  }

  /** True while a command runs or is queued; idle reaping skips busy sessions. */
  get busy(): boolean {
    return this.pending !== null || this.queue.length > 0;
  }"""),
("""  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    this.drain();
  }""",
"""  private onData(chunk: Buffer): void {
    const text = chunk.toString("utf8");
    if (!this.pending) {
      this.buffer += text;
      return;
    }
    this.pending.totalBytes += Buffer.byteLength(text);
    this.buffer += text;
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer = this.buffer.slice(this.buffer.length - MAX_BUFFER);
      this.pending.truncated = true;
    }
    this.drain();
  }"""),
("""      durationMs: Date.now() - pending.startedAt,
      cwd,
    });""",
"""      durationMs: Date.now() - pending.startedAt,
      cwd,
      truncated: pending.truncated,
      totalBytes: pending.totalBytes,
    });"""),
("""        durationMs: Date.now() - pending.startedAt,
        cwd: null,
      });""",
"""        durationMs: Date.now() - pending.startedAt,
        cwd: null,
        truncated: pending.truncated,
        totalBytes: pending.totalBytes,
      });"""),
("""        durationMs: 0,
        cwd: null,
      });""",
"""        durationMs: 0,
        cwd: null,
        truncated: false,
        totalBytes: 0,
      });"""),
("""      ...(next.signal ? { signal: next.signal } : {}),
    };""",
"""      ...(next.signal ? { signal: next.signal } : {}),
      truncated: false,
      totalBytes: 0,
    };"""),
("""      durationMs: Date.now() - pending.startedAt,
      cwd: null,
    });""",
"""      durationMs: Date.now() - pending.startedAt,
      cwd: null,
      truncated: pending.truncated,
      totalBytes: pending.totalBytes,
    });"""),
("""  constructor(
    private readonly pool: ConnectionPool,
    private readonly maxPerServer: () => number,
  ) {}

  private key(""",
"""  constructor(
    private readonly pool: ConnectionPool,
    private readonly options: { maxPerServer: () => number; idleTimeoutMs: () => number },
  ) {}

  private sweepTimer: NodeJS.Timeout | null = null;

  private armSweep(): void {
    if (this.sweepTimer || this.sessions.size === 0) return;
    this.sweepTimer = setInterval(() => this.sweepIdle(), 60_000);
    this.sweepTimer.unref?.();
  }

  private sweepIdle(): void {
    const timeout = this.options.idleTimeoutMs();
    if (timeout > 0) {
      const now = Date.now();
      for (const session of [...this.sessions.values()]) {
        if (!session.alive || session.busy) continue;
        if (now - Date.parse(session.describe().lastUsedAt) > timeout) void this.close(session.serverId, session.name);
      }
    }
    if (this.sessions.size === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private key("""),
("""    if (inUse >= this.maxPerServer()) {
      throw new MultiserversError(
        `Server "${serverId}" already has ${inUse} sessions (limit ${this.maxPerServer()}); close an idle session first.`,
      );
    }""",
"""    const limit = this.options.maxPerServer();
    if (inUse >= limit) {
      throw new MultiserversError(
        `Server "${serverId}" already has ${inUse} sessions (limit ${limit}); close an idle session first.`,
      );
    }"""),
("""    this.sessions.set(key, session);
    this.pool.attachSession(serverId, name);
    return session;""",
"""    this.sessions.set(key, session);
    this.pool.attachSession(serverId, name);
    this.armSweep();
    return session;"""),
("""    }
    this.sessions.clear();
  }
}""",
"""    }
    this.sessions.clear();
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}"""),
])

# ---------- index ----------
patch('src/index.ts', [
("""  maxSessionsPerServer: Schema.number().default(4).description("Named shell sessions allowed per server.").volatile(),""",
"""  maxSessionsPerServer: Schema.number().default(4).description("Named shell sessions allowed per server.").volatile(),
  sessionIdleTimeoutMs: Schema.number()
    .default(1800000)
    .description("Close idle shell sessions after this many milliseconds; 0 disables.")
    .volatile(),"""),
("""  const sessions = new SessionRegistry(pool, () => live().maxSessionsPerServer ?? 4);""",
"""  const sessions = new SessionRegistry(pool, {
    maxPerServer: () => live().maxSessionsPerServer ?? 4,
    idleTimeoutMs: () => live().sessionIdleTimeoutMs ?? 1_800_000,
  });"""),
])

# ---------- client ----------
patch('src/client/index.cjs', [
("""          connectSeconds: Math.round((value.connectTimeoutMs ?? 15000) / 1000),
        });""",
"""          connectSeconds: Math.round((value.connectTimeoutMs ?? 15000) / 1000),
          sessionIdleMinutes: Math.round((value.sessionIdleTimeoutMs ?? 1800000) / 60000),
        });"""),
("""            ["connectTimeoutMs", Math.max(1000, Math.round(Number(draft.connectSeconds) * 1000))],
          ];""",
"""            ["connectTimeoutMs", Math.max(1000, Math.round(Number(draft.connectSeconds) * 1000))],
            ["sessionIdleTimeoutMs", Math.max(0, Math.round(Number(draft.sessionIdleMinutes) * 60000))],
          ];"""),
("""          h(Field, { label: "连接超时（秒）" },
            h("input", { style: css.input, inputMode: "numeric", value: draft.connectSeconds, onChange: (e) => update({ connectSeconds: e.target.value }) })),
        ),""",
"""          h(Field, { label: "连接超时（秒）" },
            h("input", { style: css.input, inputMode: "numeric", value: draft.connectSeconds, onChange: (e) => update({ connectSeconds: e.target.value }) })),
          h(Field, { label: "会话空闲断开（分钟，0 = 不断开）" },
            h("input", { style: css.input, inputMode: "numeric", value: draft.sessionIdleMinutes, onChange: (e) => update({ sessionIdleMinutes: e.target.value }) })),
        ),"""),
])
print('all patches applied')
