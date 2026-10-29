const $ = (id) => document.getElementById(id);
const state = { windowId: null, harnesses: [], busy: false };

const els = {
  agents: $("agents"),
  health: $("health"),
  title: $("window-title"),
  sub: $("window-sub"),
  placeholder: $("placeholder"),
  loading: $("loading"),
  frame: $("frame"),
  reload: $("reload"),
  close: $("close"),
  openDsh: $("open-dsh"),
  log: $("log"),
};

async function api(path, options) {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

function setBusy(busy, text) {
  state.busy = busy;
  els.loading.hidden = !busy;
  els.placeholder.hidden = busy || Boolean(state.windowId);
  if (busy && text) els.loading.querySelector("p").textContent = text;
}

function showFrame(url) {
  els.frame.src = url;
  els.frame.hidden = false;
  els.placeholder.hidden = true;
  els.loading.hidden = true;
  els.reload.disabled = false;
  els.close.disabled = false;
}

function clearFrame() {
  els.frame.removeAttribute("src");
  els.frame.hidden = true;
  els.placeholder.hidden = false;
  els.reload.disabled = true;
  els.close.disabled = true;
  els.title.textContent = "未打开窗口";
  els.sub.textContent = "";
  state.windowId = null;
}

function renderAgents() {
  els.agents.innerHTML = "";
  for (const harness of state.harnesses) {
    const row = document.createElement("button");
    row.className = "agent";
    row.disabled = !harness.available || state.busy;
    row.innerHTML = `
      <span class="dot ${harness.available ? "ok" : ""}"></span>
      <span class="agent-name">${harness.label}</span>
      <span class="agent-kind">${harness.kind}</span>
      <span class="agent-version">${harness.version ?? "—"}</span>
    `;
    row.title = harness.available ? `打开 ${harness.label}` : (harness.reason ?? "不可用");
    if (harness.available && harness.id === "dsh") row.addEventListener("click", () => openDsh());
    els.agents.appendChild(row);
  }
}

async function loadStatus() {
  const status = await api("/api/status");
  state.harnesses = status.harnesses;
  renderAgents();
  els.health.textContent = `daemon ok · ${status.windows.length} window(s)`;
  els.log.textContent = status.log.slice(-12).join("\n");
}

async function openDsh() {
  if (state.busy) return;
  setBusy(true, "正在启动 DeepSeek Harness 并建立承载通道…");
  try {
    const view = await api("/api/windows", { method: "POST", body: JSON.stringify({ harness: "dsh" }) });
    state.windowId = view.id;
    els.title.textContent = view.label;
    els.sub.textContent = `${view.id} · 原生 Web UI 承载`;
    showFrame(view.url);
  } catch (error) {
    setBusy(false);
    alert(`打开失败：${error.message}`);
  }
}

async function reloadWindow() {
  if (!state.windowId) return;
  try {
    const view = await api(`/api/windows/${state.windowId}/ticket`);
    showFrame(view.url);
  } catch (error) {
    alert(`重新载入失败：${error.message}`);
  }
}

async function closeWindow() {
  if (!state.windowId) return;
  await api(`/api/windows/${state.windowId}`, { method: "DELETE" }).catch(() => ({}));
  clearFrame();
}

els.openDsh.addEventListener("click", openDsh);
els.reload.addEventListener("click", reloadWindow);
els.close.addEventListener("click", closeWindow);

const params = new URLSearchParams(location.search);
loadStatus()
  .then(() => {
    if (params.get("auto") !== "0") openDsh();
  })
  .catch((error) => {
    els.health.textContent = `daemon 不可用：${error.message}`;
  });

setInterval(() => {
  api("/api/log")
    .then((data) => (els.log.textContent = data.log.slice(-12).join("\n")))
    .catch(() => undefined);
}, 4000);
