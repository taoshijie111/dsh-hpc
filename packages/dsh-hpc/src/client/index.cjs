/**
 * dsh-hpc — browser half.
 *
 * Adds a "dsh-hpc" section to DSH Settings. Copy is written for the person using
 * it: no tool names, no storage or schema jargon. Non-secret fields go through
 * the settings form; passwords go to the DSH credential store.
 *
 * Delivered as a lazy-CJS module factory for the DSH client module loader.
 */
window.__ModuleLoader__.load({
  id: "dsh-hpc",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    const NS = "hpc";
    const refFor = (id) => `MSS_${String(id).toUpperCase().replace(/[^A-Z0-9_]/g, "_")}_PASSWORD`;

    const line = "1px solid color-mix(in srgb, currentColor 13%, transparent)";
    const muted = "color-mix(in srgb, currentColor 62%, transparent)";

    const css = {
      root: { padding: "2px 2px 32px", maxWidth: 760, fontSize: 13 },
      head: { display: "flex", alignItems: "center", gap: 10, marginBottom: 2 },
      title: { fontSize: 15, fontWeight: 600, margin: 0 },
      grow: { flex: 1 },
      lead: { fontSize: 12.5, color: muted, margin: "2px 0 16px" },
      spacer: { flex: 1 },
      card: {
        border: line,
        borderRadius: 10,
        padding: "14px 16px",
        marginBottom: 14,
        background: "color-mix(in srgb, currentColor 2.5%, transparent)",
      },
      cardHead: { display: "flex", alignItems: "center", gap: 10, minWidth: 0 },
      cardTitle: { fontSize: 13.5, fontWeight: 600 },
      cardHint: { fontSize: 12, color: muted, margin: "4px 0 12px" },
      serverRow: { borderTop: line, padding: "12px 0" },
      serverHead: { display: "flex", alignItems: "center", gap: 8, minWidth: 0, flexWrap: "wrap" },
      name: { fontSize: 13, fontWeight: 600 },
      sub: { fontSize: 12, color: muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11.5, color: muted },
      badge: {
        fontSize: 10.5,
        padding: "1px 7px",
        borderRadius: 999,
        border: line,
        color: muted,
        whiteSpace: "nowrap",
      },
      dotOnline: { width: 7, height: 7, borderRadius: 999, background: "#16a34a" },
      dotOffline: { width: 7, height: 7, borderRadius: 999, background: "color-mix(in srgb, currentColor 30%, transparent)" },
      grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 },
      field: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, minWidth: 0 },
      label: { color: muted },
      input: {
        boxSizing: "border-box",
        width: "100%",
        minWidth: 0,
        padding: "7px 9px",
        borderRadius: 7,
        border: "1px solid color-mix(in srgb, currentColor 20%, transparent)",
        background: "transparent",
        color: "inherit",
        font: "inherit",
      },
      wide: { gridColumn: "1 / -1" },
      advanced: { marginTop: 12, fontSize: 12, color: muted },
      actions: { display: "flex", gap: 8, alignItems: "center", marginTop: 14, flexWrap: "wrap" },
      button: {
        padding: "5px 13px",
        borderRadius: 7,
        border: "1px solid color-mix(in srgb, currentColor 20%, transparent)",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        fontSize: 12.5,
        cursor: "pointer",
        whiteSpace: "nowrap",
      },
      primary: { background: "#3b82f6", borderColor: "#3b82f6", color: "#fff" },
      link: { border: "none", background: "transparent", color: "inherit", opacity: 0.7, font: "inherit", fontSize: 12, cursor: "pointer", padding: "2px 4px", whiteSpace: "nowrap" },
      linkDanger: { color: "#dc2626", opacity: 0.9 },
      warn: { fontSize: 12, color: "#d97706" },
      note: { fontSize: 12, color: muted },
      empty: { fontSize: 12.5, color: muted, padding: "6px 2px 16px" },
      statsGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginTop: 12 },
      stat: { minWidth: 0 },
      statHead: { display: "flex", alignItems: "baseline", gap: 6, marginBottom: 5 },
      statLabel: { fontSize: 12, fontWeight: 600 },
      statValue: { fontSize: 12, color: muted, marginLeft: "auto", whiteSpace: "nowrap" },
      bar: {
        height: 8,
        borderRadius: 999,
        background: "color-mix(in srgb, currentColor 12%, transparent)",
        overflow: "hidden",
      },
      barFill: { height: "100%", borderRadius: 999, transition: "width .25s ease" },
      gpuCard: { border: line, borderRadius: 8, padding: "10px 12px", minWidth: 0 },
      gpuHead: { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8, minWidth: 0 },
      gpuName: { fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      chip: {
        fontSize: 11,
        padding: "2px 8px",
        borderRadius: 999,
        border: line,
        color: muted,
        whiteSpace: "nowrap",
      },
      footer: { marginTop: 10, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", fontSize: 11.5, color: muted },
      loading: { fontSize: 12, color: muted, padding: "6px 0" },
    };

    const colorFor = (percent) => {
      if (percent === null || percent === undefined) return "color-mix(in srgb, currentColor 30%, transparent)";
      if (percent >= 85) return "#dc2626";
      if (percent >= 60) return "#d97706";
      return "#16a34a";
    };
    const clamp = (value) => Math.max(0, Math.min(100, Number(value) || 0));
    const gb = (mb) => (Number.isFinite(mb) ? `${(mb / 1024).toFixed(mb >= 10 * 1024 ? 0 : 1)} GB` : "—");

    const emptyDraft = () => ({
      name: "",
      host: "",
      port: "22",
      username: "",
      auth: "password",
      password: "",
      keyPath: "",
      hostKey: "",
      label: "",
      kind: "auto",
    });

    function Field(props) {
      return h(
        "label",
        { style: props.wide ? { ...css.field, ...css.wide } : css.field },
        h("span", { style: css.label }, props.label),
        props.children,
      );
    }

    function Bar(props) {
      const percent = clamp(props.percent);
      return h(
        "div",
        { style: css.bar },
        h("div", { style: { ...css.barFill, width: `${percent}%`, background: colorFor(percent) } }),
      );
    }

    function Stat(props) {
      return h(
        "div",
        { style: css.stat },
        h(
          "div",
          { style: css.statHead },
          h("span", { style: css.statLabel }, props.label),
          h("span", { style: css.statValue }, props.value),
        ),
        h(Bar, { percent: props.percent }),
      );
    }


    function ClusterUsage(props) {
      const sample = props.sample;
      const cluster = sample.cluster || {};
      const nodes = cluster.nodes || {};
      const cpus = cluster.cpus || {};
      const memory = cluster.memoryMb || null;
      const gpus = cluster.gpus || {};
      const jobs = cluster.jobs || {};
      const partitions = Array.isArray(cluster.partitions) ? cluster.partitions : [];
      const login = sample.login || {};
      const partitionTotal = (entry) => entry.idle + entry.mixed + entry.allocated + entry.down + entry.other;
      return h(
        "div",
        null,
        h(
          "div",
          { style: { ...css.serverHead, marginBottom: 8 } },
          h("span", { style: css.cardTitle }, "计算节点"),
          h("span", { style: css.chip }, `共 ${nodes.total || 0} 台`),
          h("span", { style: css.chip }, `空闲 ${nodes.idle || 0}`),
          h("span", { style: css.chip }, `混合 ${nodes.mixed || 0}`),
          h("span", { style: css.chip }, `分配 ${nodes.allocated || 0}`),
          nodes.down ? h("span", { style: { ...css.chip, color: "#dc2626" } }, `异常 ${nodes.down}`) : null,
          h("span", { style: css.spacer }),
          h("span", { style: css.chip }, `运行作业 ${jobs.running || 0} · 排队 ${jobs.pending || 0}`),
        ),
        h(
          "div",
          { style: css.statsGrid },
          h(Stat, {
            label: "CPU 分配率",
            value: `${cpus.percent || 0}% · ${cpus.allocated || 0} / ${cpus.total || 0} 核`,
            percent: cpus.percent,
          }),
          memory && memory.total > 0 && memory.allocated > 0
            ? h(Stat, {
                label: "内存分配率",
                value: `${memory.percent || 0}% · ${gb(memory.allocated)} / ${gb(memory.total)}`,
                percent: memory.percent,
              })
            : memory && memory.freeMb > 0
              ? h(Stat, { label: "可用内存（各节点合计）", value: gb(memory.freeMb), percent: null })
              : memory && memory.total > 0
                ? h(Stat, { label: "内存总量", value: `${gb(memory.total)}（分配数据不可用）`, percent: null })
                : null,
          gpus.total > 0
            ? h(Stat, {
                label: "GPU 占用",
                value: `${gpus.percent || 0}% · ${gpus.used || 0} / ${gpus.total || 0} 卡`,
                percent: gpus.percent,
              })
            : h("div", { style: css.note }, "该集群无 GPU 节点"),
        ),
        partitions.length
          ? h(
              "div",
              { style: { ...css.statsGrid, marginTop: 10, gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))" } },
              partitions.slice(0, 6).map((partition) =>
                h(
                  "div",
                  { key: partition.name, style: css.gpuCard },
                  h(
                    "div",
                    { style: { ...css.serverHead, marginBottom: 6 } },
                    h("span", { style: css.gpuName }, partition.name),
                    h("span", { style: css.spacer }),
                    h("span", { style: css.chip }, `${partitionTotal(partition)} 节点`),
                  ),
                  h(
                    "div",
                    { style: { ...css.note, marginBottom: 5 } },
                    `空闲 ${partition.idle} · 混合 ${partition.mixed} · 分配 ${partition.allocated}${partition.down ? ` · 异常 ${partition.down}` : ""}`,
                  ),
                  h(Bar, { percent: partitionTotal(partition) > 0 ? (partition.allocated / partitionTotal(partition)) * 100 : 0 }),
                ),
              ),
            )
          : null,
        h(
          "div",
          { style: css.footer },
          h("span", null, "登录节点"),
          h("span", null, `CPU ${login.cpu && login.cpu.usagePercent != null ? login.cpu.usagePercent : "—"}%`),
          h("span", null, `内存 ${login.memory ? login.memory.percent : "—"}%`),
          h("span", null, `${login.cpu && login.cpu.cores ? login.cpu.cores : "?"} 核`),
          h("span", { style: css.spacer }),
          h("span", null, `采样 ${new Date(sample.sampledAt).toLocaleTimeString()} · ${sample.elapsedMs} ms · 已自动断开`),
        ),
      );
    }

    function UsageGauges(props) {
      if (props.sample.kind === "slurm") return h(ClusterUsage, { sample: props.sample });
      if (props.sample.kind === "queue") return h(QueueUsage, { sample: props.sample });
      const sample = props.sample;
      const cpu = sample.cpu || {};
      const memory = sample.memory || null;
      const gpus = Array.isArray(sample.gpus) ? sample.gpus : [];
      const disks = Array.isArray(sample.disks) ? sample.disks : [];
      const load = Array.isArray(cpu.load) ? cpu.load.map((value) => value.toFixed(2)).join(" / ") : "—";
      return h(
        "div",
        null,
        h(
          "div",
          { style: css.statsGrid },
          h(Stat, {
            label: "CPU",
            value: `${cpu.usagePercent === null || cpu.usagePercent === undefined ? "—" : `${cpu.usagePercent}%`} · ${cpu.cores || "?"} 核 · load ${load}`,
            percent: cpu.usagePercent,
          }),
          memory
            ? h(Stat, {
                label: "内存",
                value: `${memory.percent}% · ${gb(memory.usedMb)} / ${gb(memory.totalMb)}`,
                percent: memory.percent,
              })
            : h("div", { style: css.note }, "内存信息不可用"),
        ),
        gpus.length === 0
          ? h("div", { style: { ...css.note, marginTop: 10 } }, "未检测到 GPU（nvidia-smi 不可用或无 GPU）")
          : h(
              "div",
              { style: { ...css.statsGrid, gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))" } },
              gpus.map((gpu) =>
                h(
                  "div",
                  { key: gpu.index, style: css.gpuCard },
                  h(
                    "div",
                    { style: css.gpuHead },
                    h("span", { style: css.gpuName }, gpu.name),
                    h("span", { style: css.chip }, `GPU ${gpu.index}`),
                  ),
                  h(Stat, { label: "利用率", value: `${gpu.utilPercent}%`, percent: gpu.utilPercent }),
                  h("div", { style: { height: 6 } }),
                  h(Stat, {
                    label: "显存",
                    value: `${gb(gpu.memUsedMb)} / ${gb(gpu.memTotalMb)}`,
                    percent: gpu.memTotalMb > 0 ? (gpu.memUsedMb / gpu.memTotalMb) * 100 : 0,
                  }),
                ),
              ),
            ),
        disks.length > 0
          ? h(
              "div",
              { style: { ...css.statsGrid, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" } },
              disks.slice(0, 4).map((disk) =>
                h(Stat, {
                  key: disk.mount,
                  label: disk.mount,
                  value: `${disk.percent}% · ${disk.used} / ${disk.size}`,
                  percent: disk.percent,
                }),
              ),
            )
          : null,
        h(
          "div",
          { style: css.footer },
          h("span", null, `采样时间 ${new Date(sample.sampledAt).toLocaleTimeString()}`),
          h("span", null, `用时 ${sample.elapsedMs} ms`),
          h("span", null, "已自动断开"),
          h("span", { style: css.chip }, `排队作业 ${sample.jobs ?? 0}`),
        ),
      );
    }

    function QueueUsage(props) {
      const sample = props.sample;
      const cpu = sample.cpu || {};
      const memory = sample.memory || null;
      const load = Array.isArray(cpu.load) ? cpu.load.map((value) => value.toFixed(2)).join(" / ") : "—";
      return h(
        "div",
        null,
        h("div", { style: css.note, marginBottom: 8 }, sample.note || "该服务器使用队列系统。"),
        h(
          "div",
          { style: css.statsGrid },
          h(Stat, {
            label: "登录节点 CPU",
            value: `${cpu.usagePercent == null ? "—" : `${cpu.usagePercent}%`} · ${cpu.cores || "?"} 核 · load ${load}`,
            percent: cpu.usagePercent,
          }),
          memory ? h(Stat, { label: "登录节点内存", value: `${memory.percent}% · ${gb(memory.usedMb)} / ${gb(memory.totalMb)}`, percent: memory.percent }) : null,
        ),
        h("div", { style: css.footer },
          h("span", null, `系统 ${String(sample.queueSystem || sample.mode || "").toUpperCase()}`),
          h("span", { style: css.spacer }),
          h("span", null, `采样 ${new Date(sample.sampledAt).toLocaleTimeString()} · ${sample.elapsedMs} ms · 已自动断开`)),
      );
    }

    function StatusPanel() {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [samples, setSamples] = React.useState({});
      const [detecting, setDetecting] = React.useState({});

      const detect = async (id) => {
        setDetecting((current) => ({ ...current, [id]: true }));
        try {
          const response = await fetch(`/api/hpc/detect?server=${encodeURIComponent(id)}`, {
            headers: { "x-hpc-request": "1" },
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
          await load();
        } catch (failure) {
          setError(`检测失败：${(failure && failure.message) || failure}`);
        } finally {
          setDetecting((current) => ({ ...current, [id]: false }));
        }
      };

      const load = React.useCallback(async () => {
        setBusy(true);
        setError("");
        try {
          const response = await fetch("/api/hpc/status", { headers: { "x-hpc-request": "1" } });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
          setData(body);
        } catch (failure) {
          setError((failure && failure.message) || String(failure));
        } finally {
          setBusy(false);
        }
      }, []);

      React.useEffect(() => {
        void load();
      }, [load]);

      const sample = async (id) => {
        setSamples((current) => ({ ...current, [id]: { loading: true } }));
        try {
          const response = await fetch(`/api/hpc/usage?server=${encodeURIComponent(id)}`, {
            headers: { "x-hpc-request": "1" },
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
          setSamples((current) => ({ ...current, [id]: { sample: body } }));
        } catch (failure) {
          setSamples((current) => ({ ...current, [id]: { error: (failure && failure.message) || String(failure) } }));
        }
      };

      const servers = (data && data.servers) || [];
      return h(
        "div",
        { style: css.card },
        h(
          "div",
          { style: css.cardHead },
          h("span", { style: css.cardTitle }, "状态"),
          h("span", { style: css.spacer }),
          h("button", { type: "button", style: css.button, disabled: busy, onClick: load }, busy ? "刷新中…" : "刷新状态"),
        ),
        h("p", { style: css.cardHint }, "点「资源占用」会临时连接一次，采集 CPU / 内存 / GPU / 磁盘后自动断开。"),
        error ? h("div", { style: css.warn }, `读取失败：${error}`) : null,
        servers.length === 0
          ? h("div", { style: css.empty }, "还没有服务器。")
          : servers.map((server) => {
              const state = samples[server.id] || {};
              return h(
                "div",
                { key: server.id, style: css.serverRow },
                h(
                  "div",
                  { style: css.serverHead },
                  h("span", { style: server.connected ? css.dotOnline : css.dotOffline }),
                  h("span", { style: css.name }, server.label || server.id),
                  h("span", { style: css.sub }, `${server.username}@${server.host}:${server.port}`),
                  h(
                    "span",
                    { style: css.badge },
                    server.kind === "slurm"
                      ? "Slurm 集群"
                      : server.kind === "bare"
                        ? "裸金属"
                        : server.kind === "pbs"
                          ? "PBS 队列"
                          : server.kind === "lsf"
                            ? "LSF 队列"
                            : "类型未检测",
                  ),
                  server.hostKeyPinned ? h("span", { style: css.badge }, "指纹已固定") : null,
                  h("span", { style: css.spacer }),
                  server.kind === "auto" || !server.kind
                    ? h(
                        "button",
                        { type: "button", style: css.button, disabled: detecting[server.id] === true, onClick: () => detect(server.id) },
                        detecting[server.id] ? "检测中…" : "检测类型",
                      )
                    : null,
                  h(
                    "button",
                    { type: "button", style: css.button, disabled: state.loading === true, onClick: () => sample(server.id) },
                    state.loading ? "采集中…" : "资源占用",
                  ),
                ),
                h(
                  "div",
                  { style: { ...css.sub, marginTop: 3 } },
                  `${server.connected ? "在线" : "未连接"} · 会话 ${server.sessions.length ? server.sessions.join("、") : "无"} · 转发 ${server.forwards.length || 0}`,
                ),
                state.error ? h("div", { style: { ...css.warn, marginTop: 8 } }, `采样失败：${state.error}`) : null,
                state.sample ? h("div", { style: { marginTop: 12 } }, h(UsageGauges, { sample: state.sample })) : null,
              );
            }),
      );
    }

    function ConnectionSettings(props) {
      const { form, snapshot } = props;
      const value = snapshot.value ?? {};
      const [draft, setDraft] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [note, setNote] = React.useState("");
      React.useEffect(() => {
        setDraft({
          idleMinutes: Math.round((value.idleTimeoutMs ?? 600000) / 60000),
          maxSessions: value.maxSessionsPerServer ?? 4,
          keepaliveSeconds: Math.round((value.keepaliveIntervalMs ?? 30000) / 1000),
          commandSeconds: Math.round((value.commandTimeoutMs ?? 120000) / 1000),
          connectSeconds: Math.round((value.connectTimeoutMs ?? 15000) / 1000),
          sessionIdleMinutes: Math.round((value.sessionIdleTimeoutMs ?? 1800000) / 60000),
        });
      }, [snapshot.revision, snapshot.status]);
      if (!draft) return null;
      const writable = snapshot.status === "ready" && snapshot.writable;
      const update = (patch) => setDraft((current) => ({ ...current, ...patch }));
      const save = async () => {
        setBusy(true);
        setNote("");
        try {
          const ops = [
            ["idleTimeoutMs", Math.max(0, Math.round(Number(draft.idleMinutes) * 60000))],
            ["maxSessionsPerServer", Math.max(1, Math.round(Number(draft.maxSessions)))],
            ["keepaliveIntervalMs", Math.max(0, Math.round(Number(draft.keepaliveSeconds) * 1000))],
            ["commandTimeoutMs", Math.max(1000, Math.round(Number(draft.commandSeconds) * 1000))],
            ["connectTimeoutMs", Math.max(1000, Math.round(Number(draft.connectSeconds) * 1000))],
            ["sessionIdleTimeoutMs", Math.max(0, Math.round(Number(draft.sessionIdleMinutes) * 60000))],
          ];
          let ok = true;
          for (const [field, amount] of ops) ok = (await form.set(field, amount)) && ok;
          setNote(ok ? "已保存" : "保存失败");
        } catch (failure) {
          setNote(`保存失败：${(failure && failure.message) || failure}`);
        } finally {
          setBusy(false);
        }
      };
      return h(
        "details",
        { style: css.card },
        h(
          "summary",
          { style: { cursor: "pointer", ...css.cardHead } },
          h("span", { style: css.cardTitle }, "连接设置"),
          h("span", { style: css.sub }, `空闲 ${draft.idleMinutes} 分钟断开 · 会话空闲 ${draft.sessionIdleMinutes} 分钟回收`),
        ),
        h(
          "div",
          { style: { marginTop: 14 } },
          h("div", { style: { ...css.cardTitle, marginBottom: 8 } }, "空闲与回收"),
          h(
            "div",
            { style: css.grid },
            h(Field, { label: "连接空闲断开（分钟，0 = 不断开）" },
              h("input", { style: css.input, inputMode: "numeric", value: draft.idleMinutes, onChange: (event) => update({ idleMinutes: event.target.value }) })),
            h(Field, { label: "会话空闲回收（分钟，0 = 不回收）" },
              h("input", { style: css.input, inputMode: "numeric", value: draft.sessionIdleMinutes, onChange: (event) => update({ sessionIdleMinutes: event.target.value }) })),
            h(Field, { label: "每服务器最大会话数" },
              h("input", { style: css.input, inputMode: "numeric", value: draft.maxSessions, onChange: (event) => update({ maxSessions: event.target.value }) })),
          ),
          h("div", { style: { ...css.cardTitle, margin: "14px 0 8px" } }, "超时与保活"),
          h(
            "div",
            { style: css.grid },
            h(Field, { label: "保活间隔（秒）" },
              h("input", { style: css.input, inputMode: "numeric", value: draft.keepaliveSeconds, onChange: (event) => update({ keepaliveSeconds: event.target.value }) })),
            h(Field, { label: "命令超时（秒）" },
              h("input", { style: css.input, inputMode: "numeric", value: draft.commandSeconds, onChange: (event) => update({ commandSeconds: event.target.value }) })),
            h(Field, { label: "连接超时（秒）" },
              h("input", { style: css.input, inputMode: "numeric", value: draft.connectSeconds, onChange: (event) => update({ connectSeconds: event.target.value }) })),
          ),
          h(
            "div",
            { style: css.actions },
            h("button", { type: "button", style: { ...css.button, ...css.primary }, disabled: !writable || busy, onClick: save }, busy ? "保存中…" : "保存设置"),
            note ? h("span", { style: css.note }, note) : null,
          ),
        ),
      );
    }

    function ServersSection(props) {
      const { form, remote } = props;
      const snapshot = React.useSyncExternalStore(
        (listener) => form.subscribe(listener),
        () => form.getSnapshot(),
        () => form.getSnapshot(),
      );
      const value = snapshot.value ?? {};
      const servers = Array.isArray(value.servers) ? value.servers : [];
      const writable = snapshot.status === "ready" && snapshot.writable;

      const [editing, setEditing] = React.useState(null);
      const [draft, setDraft] = React.useState(emptyDraft);
      const [status, setStatus] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [configured, setConfigured] = React.useState({});
      const ids = servers.map((server) => server.id).join(",");

      React.useEffect(() => {
        let cancelled = false;
        const refs = servers
          .filter((server) => server.auth !== "key")
          .map((server) => server.passwordRef || refFor(server.id));
        if (refs.length === 0) {
          setConfigured({});
          return () => {
            cancelled = true;
          };
        }
        remote.credentials
          .describe(refs)
          .then((response) => {
            if (cancelled || !response || !response.ok || !response.value) return;
            const next = {};
            for (const [ref, view] of Object.entries(response.value)) next[ref] = Boolean(view && view.configured);
            setConfigured(next);
          })
          .catch(() => undefined);
        return () => {
          cancelled = true;
        };
      }, [ids, remote]);

      const update = (patch) => setDraft((current) => ({ ...current, ...patch }));

      const writeServers = async (next) => {
        setBusy(true);
        try {
          const accepted = await form.set("servers", next);
          if (!accepted) setStatus("保存失败，请稍后重试");
          return accepted;
        } catch (failure) {
          setStatus(`保存失败：${(failure && failure.message) || failure}`);
          return false;
        } finally {
          setBusy(false);
        }
      };

      const startAdd = () => {
        setStatus("");
        setDraft(emptyDraft());
        setEditing("new");
      };

      const startEdit = (server) => {
        setStatus("");
        setDraft({
          name: server.id,
          label: server.label || "",
          host: server.host,
          port: String(server.port || 22),
          username: server.username,
          auth: server.auth || "password",
          password: "",
          keyPath: server.keyPath || "",
          hostKey: server.hostKey || "",
          kind: server.kind || "auto",
        });
        setEditing(server.id);
      };

      const cancel = () => {
        setEditing(null);
        setStatus("");
      };

      const save = async () => {
        const name = draft.name.trim();
        const host = draft.host.trim();
        const username = draft.username.trim();
        const port = Number(draft.port) || 22;
        if (!name) return setStatus("请填写名称");
        if (!host) return setStatus("请填写地址");
        if (!username) return setStatus("请填写用户名");
        if (port < 1 || port > 65535) return setStatus("端口需在 1–65535 之间");

        const isNew = editing === "new";
        if (isNew && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
          return setStatus("名称只能包含小写字母、数字和短横线");
        }
        if (isNew && servers.some((server) => server.id === name)) return setStatus("该名称已被使用");

        const previous = isNew ? null : servers.find((server) => server.id === editing) || null;
        const entry = {
          id: name,
          host,
          username,
          port,
          auth: draft.auth,
        };
        if (draft.label.trim()) entry.label = draft.label.trim();
        if (draft.hostKey.trim()) entry.hostKey = draft.hostKey.trim();
        entry.kind = draft.kind || "auto";
        if (entry.kind === "auto" && previous && previous.resolvedKind) entry.resolvedKind = previous.resolvedKind;
        if (previous && previous.schedulerDefaults) entry.schedulerDefaults = previous.schedulerDefaults;
        if (previous && previous.jobRoot) entry.jobRoot = previous.jobRoot;

        if (draft.auth === "key") {
          if (!draft.keyPath.trim()) return setStatus("请填写私钥路径");
          entry.keyPath = draft.keyPath.trim();
        } else {
          const keepExisting = !isNew && previous && previous.auth !== "key";
          if (!draft.password && !keepExisting) return setStatus("请填写密码");
          entry.passwordRef = (previous && previous.passwordRef) || refFor(name);
          if (draft.password) {
            try {
              await remote.credentials.set(entry.passwordRef, draft.password);
            } catch (failure) {
              return setStatus(`密码保存失败：${(failure && failure.message) || failure}`);
            }
          }
        }

        const next = isNew
          ? [...servers, entry]
          : servers.map((server) => (server.id === editing ? entry : server));

        if (await writeServers(next)) {
          setEditing(null);
          setDraft(emptyDraft());
          setStatus("已保存");
        }
      };

      const remove = async (server) => {
        if (!(await writeServers(servers.filter((entry) => entry.id !== server.id)))) return;
        try {
          await remote.credentials.unset(server.passwordRef || refFor(server.id));
        } catch {
          /* config already updated */
        }
        setStatus("已移除");
      };

      const formOpen = editing !== null;
      const formTitle = editing === "new" ? "添加服务器" : "编辑服务器";

      const rows = servers.map((server) => {
        const missingPassword =
          server.auth !== "key" && configured[server.passwordRef || refFor(server.id)] === false;
        return h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 10, padding: "11px 12px", border: line, borderRadius: 8, marginBottom: 8 } },
          h(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: 1 } },
            h("span", { style: css.name }, server.label || server.id),
            h("span", { style: css.sub }, `${server.username}@${server.host}:${server.port || 22}`),
            missingPassword ? h("span", { style: css.warn }, "尚未保存密码") : null,
          ),
          h("button", { type: "button", style: css.link, disabled: !writable, onClick: () => startEdit(server) }, "编辑"),
          h(
            "button",
            { type: "button", style: { ...css.link, ...css.linkDanger }, disabled: !writable, onClick: () => remove(server) },
            "移除",
          ),
        );
      });

      const formPanel = !formOpen
        ? null
        : h(
            "div",
            { style: css.card, key: "form" },
            h("div", { style: { ...css.cardTitle, marginBottom: 12 } }, formTitle),
            h(
              "div",
              { style: css.grid },
              h(Field, { label: "名称" },
                h("input", {
                  style: css.input, value: draft.name, placeholder: "例如 hpc1",
                  disabled: editing !== "new",
                  onChange: (event) => update({ name: event.target.value }),
                })),
              h(Field, { label: "显示名称（可选）" },
                h("input", {
                  style: css.input, value: draft.label, placeholder: "例如 GPU 集群",
                  onChange: (event) => update({ label: event.target.value }),
                })),
              h(Field, { label: "地址", wide: true },
                h("input", {
                  style: css.input, value: draft.host, placeholder: "主机名或 IP",
                  onChange: (event) => update({ host: event.target.value }),
                })),
              h(Field, { label: "端口" },
                h("input", {
                  style: css.input, value: draft.port, inputMode: "numeric",
                  onChange: (event) => update({ port: event.target.value }),
                })),
              h(Field, { label: "用户名" },
                h("input", {
                  style: css.input, value: draft.username, placeholder: "登录用户名",
                  onChange: (event) => update({ username: event.target.value }),
                })),
              h(Field, { label: "认证方式" },
                h("select", {
                  style: css.input, value: draft.auth,
                  onChange: (event) => update({ auth: event.target.value }),
                }, h("option", { value: "password" }, "密码"), h("option", { value: "key" }, "私钥"))),
              h(Field, { label: "类型（调度系统）", wide: true },
                h("select", {
                  style: css.input, value: draft.kind,
                  onChange: (event) => update({ kind: event.target.value }),
                },
                  h("option", { value: "auto" }, "自动检测"),
                  h("option", { value: "bare" }, "裸金属（无队列）"),
                  h("option", { value: "slurm" }, "Slurm"),
                  h("option", { value: "pbs" }, "PBS（作业工具暂不支持）"),
                  h("option", { value: "lsf" }, "LSF（作业工具暂不支持）"))),
              draft.auth === "key"
                ? h(Field, { label: "私钥路径", wide: true },
                    h("input", {
                      style: css.input, value: draft.keyPath, placeholder: "本机私钥文件路径",
                      onChange: (event) => update({ keyPath: event.target.value }),
                    }))
                : h(Field, { label: "密码", wide: true },
                    h("input", {
                      style: css.input, type: "password", value: draft.password,
                      placeholder: editing === "new" ? "登录密码（保存在安全凭据库）" : "留空则不修改",
                      onChange: (event) => update({ password: event.target.value }),
                    })),
            ),
            h(
              "details",
              { style: css.advanced },
              h("summary", { style: { cursor: "pointer" } }, "高级"),
              h("div", { style: { ...css.grid, marginTop: 10 } },
                h(Field, { label: "主机指纹（可选）", wide: true },
                  h("input", {
                    style: css.input, value: draft.hostKey, placeholder: "首次连接后固定，例如 SHA256:...",
                    onChange: (event) => update({ hostKey: event.target.value }),
                  })),
              ),
            ),
            h(
              "div",
              { style: css.actions },
              h("button", { type: "button", style: { ...css.button, ...css.primary }, disabled: !writable || busy, onClick: save },
                busy ? "保存中…" : "保存"),
              h("button", { type: "button", style: css.button, onClick: cancel }, "取消"),
              !writable ? h("span", { style: css.note }, "当前设置为只读") : null,
            ),
          );

      return h(
        "div",
        { style: css.root },
        h(
          "div",
          { style: css.head },
          h("h3", { style: css.title }, "dsh-hpc"),
          h("span", { style: css.grow }),
          h("button", { type: "button", style: css.button, disabled: !writable || formOpen, onClick: startAdd }, "添加"),
        ),
        h("p", { style: css.lead }, "管理 agent 可操作的远端服务器；资源占用按需临时连接采集。"),
        h(StatusPanel, null),
        h(ConnectionSettings, { form, snapshot }),
        servers.length === 0 && !formOpen ? h("div", { style: css.empty }, "还没有服务器。") : null,
        formPanel,
        rows,
        status ? h("div", { style: { ...css.note, marginTop: 8 } }, status) : null,
      );
    }

    const inject = ["slots", "configForms", "remote", "remote.credentials"];

    function apply(ctx) {
      const page = { form: ctx.configForms.get(NS), remote: ctx.remote };
      ctx.effect(
        () =>
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              {
                name: "settings.section",
                id: "hpc",
                order: 40,
                label: () => "dsh-hpc",
                inject: () => page,
              },
              ServersSection,
            ),
          ),
        "dsh-hpc: servers settings section",
      );
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
