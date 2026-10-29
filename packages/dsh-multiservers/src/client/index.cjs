/**
 * dsh-multiservers — browser half.
 *
 * Registers a "Servers" section on the DSH Settings page. Non-secret fields are
 * written to this plugin's config through the settings service; passwords go to
 * DSH's credential store through `remote.credentials`, never into the config.
 *
 * The file is a lazy-CJS module factory expected by the DSH client module
 * loader (`window.__ModuleLoader__.load`). React is resolved through the
 * loader's `require`; no cross-plugin value imports are made.
 */
window.__ModuleLoader__.load({
  id: "dsh-multiservers",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    /** Settings namespace === the Loader entry id used in cordis.patch.yml. */
    const NS = "multiservers";
    const refFor = (id) =>
      `MSS_${String(id).toUpperCase().replace(/[^A-Z0-9_]/g, "_")}_PASSWORD`;

    const styles = {
      root: { padding: "8px 4px 24px", maxWidth: 760, color: "inherit" },
      title: { fontSize: 15, fontWeight: 600, margin: "0 0 4px" },
      hint: { fontSize: 12, opacity: 0.7, margin: "0 0 16px", lineHeight: 1.6 },
      card: {
        border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
        borderRadius: 8,
        padding: "10px 12px",
        marginBottom: 8,
      },
      row: { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" },
      name: { fontWeight: 600, fontSize: 13 },
      meta: { fontSize: 12, opacity: 0.75 },
      spacer: { flex: 1 },
      grid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 },
      field: { display: "flex", flexDirection: "column", gap: 3, fontSize: 12 },
      input: {
        padding: "5px 7px",
        borderRadius: 6,
        border: "1px solid color-mix(in srgb, currentColor 25%, transparent)",
        background: "transparent",
        color: "inherit",
        font: "inherit",
      },
      actions: { display: "flex", gap: 8, marginTop: 10, alignItems: "center" },
      button: {
        padding: "5px 12px",
        borderRadius: 6,
        border: "1px solid color-mix(in srgb, currentColor 25%, transparent)",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        cursor: "pointer",
      },
      primary: { background: "#3b82f6", borderColor: "#3b82f6", color: "#fff" },
      danger: { color: "#dc2626" },
      status: { fontSize: 12, opacity: 0.8, marginTop: 8, minHeight: 16 },
      empty: { fontSize: 12, opacity: 0.65, padding: "8px 0" },
    };

    const blankDraft = () => ({
      id: "",
      label: "",
      host: "",
      port: "22",
      username: "",
      auth: "password",
      keyPath: "",
      password: "",
      hostKey: "",
    });

    function labeled(label, input) {
      return h(
        "label",
        { style: styles.field },
        h("span", null, label),
        input,
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
      const [draft, setDraft] = React.useState(blankDraft);
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
          setStatus(accepted ? "已保存" : "未保存：服务器拒绝了该配置（可能为只读）");
          return accepted;
        } catch (error) {
          setStatus(`保存失败：${(error && error.message) || error}`);
          return false;
        } finally {
          setBusy(false);
        }
      };

      const addServer = async () => {
        const id = draft.id.trim();
        const host = draft.host.trim();
        const username = draft.username.trim();
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) return setStatus("id 只能包含小写字母、数字和短横线");
        if (!host) return setStatus("host 必填");
        if (!username) return setStatus("username 必填");
        if (servers.some((server) => server.id === id)) return setStatus("id 已存在");
        const entry = { id, host, username, port: Number(draft.port) || 22, auth: draft.auth };
        if (draft.label.trim()) entry.label = draft.label.trim();
        if (draft.hostKey.trim()) entry.hostKey = draft.hostKey.trim();
        if (draft.auth === "key") {
          if (!draft.keyPath.trim()) return setStatus("私钥认证需要 keyPath");
          entry.keyPath = draft.keyPath.trim();
        } else {
          if (!draft.password) return setStatus("密码认证需要填写密码");
          entry.passwordRef = refFor(id);
          try {
            await remote.credentials.set(entry.passwordRef, draft.password);
          } catch (error) {
            return setStatus(`写凭据失败：${(error && error.message) || error}`);
          }
        }
        if (await writeServers([...servers, entry])) setDraft(blankDraft());
      };

      const removeServer = async (server) => {
        if (!(await writeServers(servers.filter((entry) => entry.id !== server.id)))) return;
        try {
          await remote.credentials.unset(server.passwordRef || refFor(server.id));
        } catch {
          /* the config is already updated; a leftover credential is harmless */
        }
      };

      const rows = servers.map((server) =>
        h(
          "div",
          { style: styles.card, key: server.id },
          h(
            "div",
            { style: styles.row },
            h("span", { style: styles.name }, server.label || server.id),
            h("span", { style: styles.meta }, `${server.username}@${server.host}:${server.port || 22}`),
            h("span", { style: styles.meta }, server.auth === "key" ? "私钥" : "密码"),
            h("span", { style: styles.meta }, server.hostKey ? "指纹已固定" : "指纹未固定"),
            server.auth !== "key"
              ? h(
                  "span",
                  { style: styles.meta },
                  configured[server.passwordRef || refFor(server.id)] ? "凭据已配置" : "缺少密码",
                )
              : null,
            h("span", { style: styles.spacer }),
            h(
              "button",
              {
                type: "button",
                style: { ...styles.button, ...styles.danger },
                disabled: !writable || busy,
                onClick: () => removeServer(server),
              },
              "移除",
            ),
          ),
        ),
      );

      return h(
        "div",
        { style: styles.root },
        h("h3", { style: styles.title }, "远端服务器"),
        h(
          "p",
          { style: styles.hint },
          "配置后，agent 可用 server_probe / run / ls / upload / download 等工具操作这些服务器。",
          "密码写入 DSH 凭据库（与模型 API key 同一存储），不会进入 profile 配置；",
          "私钥认证只记录本地路径。首次连接可在对话里让 agent 执行 server_test 并 pin 主机指纹。",
        ),
        servers.length === 0 ? h("div", { style: styles.empty }, "还没有配置服务器。") : rows,
        h("div", { style: { ...styles.card, marginTop: 16 } },
          h("div", { style: styles.name }, "添加服务器"),
          h(
            "div",
            { style: styles.grid },
            labeled("id（小写字母/数字/-）", h("input", {
              style: styles.input, value: draft.id,
              onChange: (event) => update({ id: event.target.value }), placeholder: "hpc1",
            })),
            labeled("显示名（可选）", h("input", {
              style: styles.input, value: draft.label,
              onChange: (event) => update({ label: event.target.value }), placeholder: "HPC login node",
            })),
            labeled("Host / IP", h("input", {
              style: styles.input, value: draft.host,
              onChange: (event) => update({ host: event.target.value }), placeholder: "10.0.0.5",
            })),
            labeled("端口", h("input", {
              style: styles.input, value: draft.port,
              onChange: (event) => update({ port: event.target.value }), placeholder: "22",
            })),
            labeled("用户名", h("input", {
              style: styles.input, value: draft.username,
              onChange: (event) => update({ username: event.target.value }), placeholder: "alice",
            })),
            labeled("认证方式", h("select", {
              style: styles.input, value: draft.auth,
              onChange: (event) => update({ auth: event.target.value }),
            }, h("option", { value: "password" }, "密码"), h("option", { value: "key" }, "私钥"))),
            draft.auth === "key"
              ? labeled("私钥路径（本地）", h("input", {
                  style: styles.input, value: draft.keyPath,
                  onChange: (event) => update({ keyPath: event.target.value }), placeholder: "C:/Users/me/.ssh/id_ed25519",
                }))
              : labeled("密码（写入凭据库）", h("input", {
                  style: styles.input, type: "password", value: draft.password,
                  onChange: (event) => update({ password: event.target.value }), placeholder: "••••••",
                })),
            labeled("主机指纹（可选，首次连接后 pin）", h("input", {
              style: styles.input, value: draft.hostKey,
              onChange: (event) => update({ hostKey: event.target.value }), placeholder: "SHA256:...",
            })),
          ),
          h("div", { style: styles.actions },
            h("button", {
              type: "button",
              style: { ...styles.button, ...styles.primary },
              disabled: !writable || busy,
              onClick: addServer,
            }, busy ? "保存中…" : "添加"),
            !writable ? h("span", { style: styles.meta }, "当前部署的设置为只读或尚未就绪") : null,
          ),
        ),
        h("div", { style: styles.status }, status),
        snapshot.status === "unavailable" ? h("div", { style: styles.status }, "Host 未提供 multiservers 设置命名空间") : null,
      );
    }

    const inject = ["slots", "configForms", "remote", "remote.credentials"];

    function apply(ctx) {
      const page = { form: ctx.configForms.get(NS), remote: ctx.remote };
      // Registered without the served-namespace guard so the page is visible even
      // when the Host settings namespace is briefly unavailable; the card reports
      // that state itself instead of disappearing silently.
      ctx.effect(
        () =>
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              {
                name: "settings.section",
                id: "multiservers",
                order: 40,
                label: () => "Servers",
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
