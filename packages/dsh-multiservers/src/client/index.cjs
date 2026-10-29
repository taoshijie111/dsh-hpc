/**
 * dsh-multiservers — browser half.
 *
 * Adds a "服务器" section to DSH Settings. Copy is written for the person using
 * it: no tool names, no storage or schema jargon. Non-secret fields go through
 * the settings form; passwords go to the DSH credential store.
 *
 * Delivered as a lazy-CJS module factory for the DSH client module loader.
 */
window.__ModuleLoader__.load({
  id: "dsh-multiservers",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    const NS = "multiservers";
    const refFor = (id) => `MSS_${String(id).toUpperCase().replace(/[^A-Z0-9_]/g, "_")}_PASSWORD`;

    const css = {
      root: { padding: "4px 2px 28px", maxWidth: 680 },
      head: { display: "flex", alignItems: "baseline", gap: 12, marginBottom: 2 },
      title: { fontSize: 15, fontWeight: 600, margin: 0 },
      grow: { flex: 1 },
      lead: { fontSize: 12.5, opacity: 0.65, margin: "0 0 18px" },
      row: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "11px 12px",
        borderRadius: 8,
        border: "1px solid color-mix(in srgb, currentColor 14%, transparent)",
        marginBottom: 8,
      },
      rowMain: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: 1 },
      name: { fontSize: 13, fontWeight: 600 },
      sub: { fontSize: 12, opacity: 0.6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      warn: { fontSize: 12, color: "#d97706" },
      link: {
        border: "none",
        background: "transparent",
        color: "inherit",
        opacity: 0.65,
        font: "inherit",
        fontSize: 12,
        cursor: "pointer",
        padding: "2px 4px",
      },
      linkDanger: { color: "#dc2626", opacity: 0.9 },
      form: {
        border: "1px solid color-mix(in srgb, currentColor 14%, transparent)",
        borderRadius: 8,
        padding: "14px 14px 12px",
        marginTop: 4,
      },
      grid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
      field: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12 },
      label: { opacity: 0.65 },
      input: {
        padding: "6px 8px",
        borderRadius: 6,
        border: "1px solid color-mix(in srgb, currentColor 22%, transparent)",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        width: "100%",
      },
      advanced: { marginTop: 10, fontSize: 12, opacity: 0.75 },
      actions: { display: "flex", gap: 8, alignItems: "center", marginTop: 14 },
      button: {
        padding: "5px 14px",
        borderRadius: 6,
        border: "1px solid color-mix(in srgb, currentColor 22%, transparent)",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        fontSize: 12.5,
        cursor: "pointer",
      },
      primary: { background: "#3b82f6", borderColor: "#3b82f6", color: "#fff" },
      status: { fontSize: 12, opacity: 0.75, marginTop: 10, minHeight: 16 },
      empty: { fontSize: 12.5, opacity: 0.6, padding: "6px 2px 16px" },
    };

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
    });

    function Field(props) {
      return h(
        "label",
        { style: css.field },
        h("span", { style: css.label }, props.label),
        props.children,
      );
    }



    function formatUsage(sample) {
      const parts = [];
      if (sample.load) parts.push(`负载  ${sample.load}`);
      if (sample.memory) parts.push(`内存
${sample.memory}`);
      if (sample.cpu) parts.push(`CPU
${sample.cpu}`);
      parts.push(`GPU
${sample.gpu && sample.gpu !== "none" ? sample.gpu : "未检测到 GPU"}`);
      if (sample.disk) parts.push(`磁盘
${sample.disk}`);
      if (sample.jobs) parts.push(`我的作业
${sample.jobs}`);
      return parts.join(String.fromCharCode(10, 10));
    }

    function StatusPanel() {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState("");
      const [usage, setUsage] = React.useState({});
      const [busy, setBusy] = React.useState(false);

      const load = React.useCallback(async () => {
        setBusy(true);
        setError("");
        try {
          const response = await fetch("/api/multiservers/status", { headers: { "x-multiservers-request": "1" } });
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
        setUsage((current) => ({ ...current, [id]: { loading: true } }));
        try {
          const response = await fetch(`/api/multiservers/usage?server=${encodeURIComponent(id)}`, {
            headers: { "x-multiservers-request": "1" },
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
          setUsage((current) => ({ ...current, [id]: { text: formatUsage(body) } }));
        } catch (failure) {
          setUsage((current) => ({ ...current, [id]: { error: (failure && failure.message) || String(failure) } }));
        }
      };

      const servers = (data && data.servers) || [];
      return h(
        "div",
        { style: { ...css.form, marginTop: 0, marginBottom: 14 } },
        h(
          "div",
          { style: { display: "flex", alignItems: "baseline", gap: 10 } },
          h("span", { style: css.name }, "状态"),
          h("span", { style: css.grow }),
          h("button", { type: "button", style: css.button, disabled: busy, onClick: load }, busy ? "刷新中…" : "刷新"),
        ),
        h("p", { style: { ...css.lead, margin: "6px 0 10px" } }, "查看服务器是否在线，以及 CPU / GPU / 磁盘占用。"),
        error ? h("div", { style: css.warn }, `读取失败：${error}`) : null,
        servers.length === 0
          ? h("div", { style: css.empty }, "还没有服务器。")
          : servers.map((server) =>
              h(
                "div",
                { key: server.id, style: { borderTop: "1px solid color-mix(in srgb, currentColor 12%, transparent)", padding: "10px 0" } },
                h(
                  "div",
                  { style: css.row },
                  h("span", { style: css.name }, server.label || server.id),
                  h("span", { style: css.sub }, `${server.username}@${server.host}:${server.port}`),
                  h("span", { style: css.meta }, server.connected ? "在线" : "未连接"),
                  h("span", { style: css.spacer }),
                  h("button", { type: "button", style: css.link, onClick: () => sample(server.id) }, "资源占用"),
                ),
                h("div", { style: { ...css.sub, marginTop: 2 } },
                  `会话 ${server.sessions.length ? server.sessions.join("、") : "无"} · 转发 ${server.forwards.length || 0}`),
                usage[server.id] && usage[server.id].loading
                  ? h("div", { style: css.sub }, "采样中…")
                  : null,
                usage[server.id] && usage[server.id].error
                  ? h("div", { style: css.warn }, usage[server.id].error)
                  : null,
                usage[server.id] && usage[server.id].text
                  ? h("pre", { style: { ...css.input, marginTop: 8, maxHeight: 260, overflow: "auto", whiteSpace: "pre-wrap" } }, usage[server.id].text)
                  : null,
              ),
            ),
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
        } catch (error) {
          setNote(`保存失败：${(error && error.message) || error}`);
        } finally {
          setBusy(false);
        }
      };
      return h(
        "details",
        { style: { ...css.form, marginTop: 0, marginBottom: 14 } },
        h(
          "summary",
          { style: { cursor: "pointer", fontSize: 12.5, opacity: 0.75 } },
          `连接设置（空闲 ${draft.idleMinutes} 分钟自动断开）`,
        ),
        h(
          "div",
          { style: { ...css.grid, marginTop: 12 } },
          h(Field, { label: "空闲断开（分钟，0 = 不断开）" },
            h("input", { style: css.input, inputMode: "numeric", value: draft.idleMinutes, onChange: (e) => update({ idleMinutes: e.target.value }) })),
          h(Field, { label: "每服务器最大会话数" },
            h("input", { style: css.input, inputMode: "numeric", value: draft.maxSessions, onChange: (e) => update({ maxSessions: e.target.value }) })),
          h(Field, { label: "保活间隔（秒）" },
            h("input", { style: css.input, inputMode: "numeric", value: draft.keepaliveSeconds, onChange: (e) => update({ keepaliveSeconds: e.target.value }) })),
          h(Field, { label: "命令超时（秒）" },
            h("input", { style: css.input, inputMode: "numeric", value: draft.commandSeconds, onChange: (e) => update({ commandSeconds: e.target.value }) })),
          h(Field, { label: "连接超时（秒）" },
            h("input", { style: css.input, inputMode: "numeric", value: draft.connectSeconds, onChange: (e) => update({ connectSeconds: e.target.value }) })),
          h(Field, { label: "会话空闲断开（分钟，0 = 不断开）" },
            h("input", { style: css.input, inputMode: "numeric", value: draft.sessionIdleMinutes, onChange: (e) => update({ sessionIdleMinutes: e.target.value }) })),
        ),
        h(
          "div",
          { style: css.actions },
          h("button", { type: "button", style: { ...css.button, ...css.primary }, disabled: !writable || busy, onClick: save },
            busy ? "保存中…" : "保存连接设置"),
          note ? h("span", { style: css.status }, note) : null,
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

      const [editing, setEditing] = React.useState(null); // null | 'new' | server id
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
        } catch (error) {
          setStatus(`保存失败：${(error && error.message) || error}`);
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
            } catch (error) {
              return setStatus(`密码保存失败：${(error && error.message) || error}`);
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
          { style: css.row, key: server.id },
          h(
            "div",
            { style: css.rowMain },
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
            { style: css.form, key: "form" },
            h("div", { style: { ...css.name, marginBottom: 10 } }, formTitle),
            h(
              "div",
              { style: css.grid },
              h(Field, { label: "名称" },
                h("input", {
                  style: css.input, value: draft.name, placeholder: "例如 hpc1",
                  disabled: editing !== "new",
                  onChange: (event) => update({ name: event.target.value }),
                })),
              h(Field, { label: "地址" },
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
              draft.auth === "key"
                ? h(Field, { label: "私钥路径" },
                    h("input", {
                      style: css.input, value: draft.keyPath, placeholder: "本机私钥文件路径",
                      onChange: (event) => update({ keyPath: event.target.value }),
                    }))
                : h(Field, { label: "密码" },
                    h("input", {
                      style: css.input, type: "password", value: draft.password,
                      placeholder: editing === "new" ? "登录密码" : "留空则不修改",
                      onChange: (event) => update({ password: event.target.value }),
                    })),
              h(Field, { label: "显示名称（可选）" },
                h("input", {
                  style: css.input, value: draft.label, placeholder: "例如 GPU 集群",
                  onChange: (event) => update({ label: event.target.value }),
                })),
            ),
            h(
              "details",
              { style: css.advanced },
              h("summary", { style: { cursor: "pointer" } }, "高级"),
              h(Field, { label: "主机指纹（可选）" },
                h("input", {
                  style: css.input, value: draft.hostKey, placeholder: "首次连接后可固定",
                  onChange: (event) => update({ hostKey: event.target.value }),
                })),
            ),
            h(
              "div",
              { style: css.actions },
              h("button", { type: "button", style: { ...css.button, ...css.primary }, disabled: !writable || busy, onClick: save },
                busy ? "保存中…" : "保存"),
              h("button", { type: "button", style: css.button, onClick: cancel }, "取消"),
              !writable ? h("span", { style: css.status }, "当前设置为只读") : null,
            ),
          );

      return h(
        "div",
        { style: css.root },
        h(
          "div",
          { style: css.head },
          h("h3", { style: css.title }, "服务器"),
          h("span", { style: css.grow }),
          h("button", { type: "button", style: css.button, disabled: !writable || formOpen, onClick: startAdd }, "添加"),
        ),
        h("p", { style: css.lead }, "管理 agent 可操作的远端机器。"),
        h(StatusPanel, null),
        h(ConnectionSettings, { form, snapshot }),
        servers.length === 0 && !formOpen ? h("div", { style: css.empty }, "还没有服务器。") : null,
        formPanel,
        rows,
        status ? h("div", { style: css.status }, status) : null,
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
                id: "multiservers",
                order: 40,
                label: () => "服务器",
                inject: () => page,
              },
              ServersSection,
            ),
          ),
        "dsh-multiservers: servers settings section",
      );
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
