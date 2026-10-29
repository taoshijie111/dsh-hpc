# 需求规格 v0.8（草案）

| 项 | 内容 |
| --- | --- |
| 文档状态 | 草案；S0 已完成（harness 机制、认证、探测、许可），可进入 S1 |
| 已锁定决策 | D1–D14（见 §0） |
| 相对 v0.3 的变化 | ①会话互通整体**移出 MVP**（D8）；②上下文注入**只走 AGENTS.md**（D3 修订）；③新增**复用优先**与**许可合规**原则（D9/D10）；④新增 FR-8 harness 接入；⑤锁定 Slurm / TypeScript / 三 harness 全接（D11/D12） |
| 未决项 | Q2/Q4/Q5（见 §12）＋ S0.2/S0.3 端点接入 |
| 范围 | 需求与契约层；技术栈已定（TypeScript/Node） |

---

## 0. 决策记录（ADR）

| # | 决策 | 理由 | 状态 |
| --- | --- | --- | --- |
| D1 | 项目是本地一等公民，算力是外设 | 项目状态须在任何超算不可用时完整可读 | 锁定 |
| D2 | 远端零安装、零常驻进程（仅 SSH + POSIX shell + 调度器） | 超算共享资源，登录节点政策限制任意进程 | 锁定 |
| D3 | **上下文注入只使用 AGENTS.md**（v0.3 的"L1 共享事实+统一工具面"收敛为单一实现路径） | AGENTS.md 是 LF 托管的事实标准，60k+ 项目采用，被 Codex/Gemini CLI/goose/opencode/Zed/Cursor 等原生支持；自研上下文协议没有收益 | **修订** |
| D4 | 本地 Web UI + 算力左侧边栏 | 跨平台、手机可看；UI 与 MCP 共享同一守护进程状态 | 锁定 |
| D5 | 文件为权威，索引库为可重建缓存 | 人可读、可 git、可脱离工具存活 | 锁定 |
| D6 | **UI 承载 harness 原生界面，但不重写会话**：Web 类 harness 用反向代理 + 内嵌窗口，TUI 类用终端窗口；不实现自有对话协议、不渲染对话内容 | 满足"对话界面就是 harness 自己的"；不修改 harness 代码；harness 升级不破坏我们 | **修订** |
| D7 | 人工选址 + 显式 stage | 避免意外烧机时/配额；数据流转可追溯 | 锁定 |
| **D8** | **会话互通整体暂缓**：不实现跨 harness 会话迁移、不存储/解析会话内容；只做 harness 接入 | 先验证"本地项目内核 + 算力外设"本身的价值；等真实使用反馈再决定是否引入 | **新增** |
| **D9** | **复用优先**：能复用成熟实现的层不自研 | 避免造轮子；把工程量集中在唯一的差异化部分（账本/状态机/stage） | **新增** |
| **D10** | **许可合规前置**：引入任何第三方代码前先确认许可证；AGPL/无许可证代码不得并入 | 已核实的候选中 3/6 存在许可问题（见 §13） | **新增** |
| **D11** | **调度器无关**（v0.5 的"锁定 Slurm"被推翻）：工具只做配置管理 + 连接/执行/传输打通，任务如何提交交由 agent 决定；端点能力由只读探针发现并写入画像 | 用户实际环境混合（Slurm 集群与裸金属并存）；把调度语义放进工具会让"裸金属"变成二等公民 | **修订** |
| **D12** | **技术栈 TypeScript/Node；三个 harness 全接** | 前后端同语言、类型共享（shared 契约）、官方 MCP SDK 成熟；三 harness 全接才能验证 FR-8 抽象是否成立 | **新增** |
| **D13** | **凭据模型**：密码与私钥并列支持；密码/私钥不得明文入库到项目目录或 git，走 OS 凭据库或本地加密存储 | 用户明确要求"填 IP/端口/用户名/密码"；但凭据泄露是不可接受风险 | **新增** |
| **D14** | **接入拆成两个独立维度**：**工具面**（MCP 优先 → CLI + AGENTS.md 兜底）与**界面承载**（Web 代理窗口 → 终端窗口 → 外部唤起兜底）。原生协议适配器（自建会话）不采用 | 工具能力与会话呈现是两件事，拆开后各自可选最优实现；界面承载只依赖 harness 的公开启动输出，不依赖内部协议，升级免疫 | **修订** |
| **D15** | **harness 进程由 daemon 托管**：Web 类以 detached 子进程运行（会话数据在 harness 自己的 store，重启可重拉）；TUI 类以 node-pty 托管（Windows 用 ConPTY）；**不依赖 tmux** | Citadel 用 tmux 托管 dsh web，Windows 无 tmux；本地环境是 Windows，必须跨平台 | **新增** |
| **D16** | **直接复用 Citadel 的页面承载代码**：`carrier-protocol`、`web-carrier`、`carrier-process` 移植进本仓库；不改其协议与安全模型，只做重命名与跨平台适配 | 用户确认 Citadel 为其自有项目，代码可复用；该部分是 640 行、自包含、已被真实使用验证过的实现，重写无收益 | **新增** |

**由 D3 + D6 + D8 删除的能力（相对 v0.3）：** 会话中枢、transcript 存储、harness 适配层、会话索引器、L2 事件溯源快照、会话转写导出。本工具在 MVP 阶段不保存、不解析、不重放任何 agent 会话内容。

---

## 1. 背景与问题

科研工作者同时推进多个项目，在本地与多台共享超算之间建模、计算、分析、整理，实际操作由多个 agent（dsh / kimi / codex）承担。

| # | 痛点 | 现状后果 |
| --- | --- | --- |
| P1 | 项目钉在单台超算 | 该机资源占满时无法临时改用他机 GPU/CPU；迁移=文件拷贝 |
| P2 | 各超算各有 agent，会话割裂 | 同一任务跨机器无法接续（**MVP 不在工具内解决，改由 AGENTS.md 降低复述成本**） |
| P3 | 本地/远程断裂 | 本地小项目偶需算力时流程陡增 |
| P4 | 数据与项目状态错位 | 大文件在远端，进度与结果散落 |
| P5 | 操作面分散 | 连接、上传下载、执行各有一套，agent 无法统一操控 |

---

## 2. 设计原则

1. **单一权威**：项目状态只存在于本地项目目录；远端不持有项目语义。
2. **弱假设**：远端只有 SSH + POSIX shell + 调度器 + 文件系统；不假设 Node、不假设出网。
3. **显式优于隐式**：数据搬运、机器选择、危险命令都必须显式声明、可审计。
4. **可重建**：删掉所有派生数据后，系统能从权威文件完整恢复。
5. **不确定即停**：无法从远端证据确认的状态一律 `unknown`，不推测、不自动重试。
6. **复用优先（D9）**：优先采用既有标准（AGENTS.md、MCP）与许可证兼容的成熟实现；自研只保留在真差异化处。
7. **许可合规（D10）**：依赖清单附许可证，CI 检查；AGPL/无许可证代码不并入分发物。

---

## 3. 范围

### 3.1 范围内

- 本地项目内核（目录契约、事实库、任务、运行账本）
- 超算端点注册、主机密钥固定、静态画像与动态资源探针
- 作业提交、监督、日志拉取、取消、重启对账
- 文件上传/下载、数据集逻辑引用、显式 stage/pull
- MCP 接口面（resources + tools）
- **AGENTS.md 投影生成 + 各 harness 的 MCP 注册（FR-8）**
- 本地 Web UI：项目视图 + 算力侧边栏

### 3.2 范围外（非目标）

| 非目标 | 原因 |
| --- | --- |
| 远端 agent / 常驻 helper | D2 |
| 跨 harness 会话迁移与转录 | D8（见 §14 暂缓清单） |
| 自研会话 UI / 原生协议适配器 | D6 修订 + D8：界面用 harness 自带的，工具不重写会话 |
| 大数据镜像同步 | 大文件驻留远端，本地留引用 |
| 多用户、权限体系、协作 | 单用户个人工具 |
| HPC 侧 Web UI | D2 |
| 自研推理或模型接入 | 使用既有 agent |
| 自动选址与自动调度 | D7 |
| 通用工作流/DAG 编排引擎 | 先做单作业闭环 |

---

## 4. 角色与关键旅程

**角色**：唯一用户（科研工作者）；协作者是本地 agent（通过 MCP 调用工具）。

| 旅程 | 场景 | 期望结果 |
| --- | --- | --- |
| J1 | 新项目从零开始，跑第一次小规模验证 | 建项目 → 选端点 → 提交 → 看到日志与结果 → 账本有记录 |
| J2 | 主超算队列排满，临时改用另一台 | 侧边栏看到两台状态 → 选新端点 → 输入来源明确 → 提交成功 |
| J3 | 结果回取与进度更新 | 显式 pull 回结果目录；事实与任务状态更新 |
| J4 | daemon 重启 / 网络中断 | 账本 + 远端 `sacct` 对账；不重复提交；状态可解释 |
| J5 | agent 自主提交（人已选址） | 与人工提交产生一致的账本条目 |
| **J6** | **换 harness 继续同一项目** | **新 harness 进入项目目录即读到 AGENTS.md，并已配置好 MCP 工具；无需复述背景** |

---

## 5. 功能需求

### 5.1 项目内核（FR-1）

| 编号 | 需求 | 验收 |
| --- | --- | --- |
| FR-1.1 | 项目以本地目录存在，含 `project.md` frontmatter（id/name/status/objective/tags/created） | 新建生成该文件；手改后系统正确识别 |
| FR-1.2 | 守护进程扫描/监听项目目录，维护索引；索引可由权威文件完整重建 | 删除 `.index/` 后重启，UI 与查询一致 |
| FR-1.3 | 事实库 `knowledge/facts/<id>.md`，含 `source`、`updated_at`、`confidence` | 增删改后索引同步；冲突保留双方 |
| FR-1.4 | 决策记录 `knowledge/decisions/<id>.md`（ADR 式） | 可按时间浏览 |
| FR-1.5 | 任务 `plan/tasks/<id>.md`，含 status / depends_on / acceptance | 状态可流转并被 MCP 查询 |
| FR-1.6 | 生成 `AGENTS.md` 投影（见 FR-6） | 可预览、可关闭 |

### 5.2 端点管理（FR-2）

> 端点 = 用户填写的「IP + 端口(默认 22) + 用户名 + 密码(或密钥)」。**不预设调度器**：工具只负责把连接、执行、传输打通，任务怎么提交由 agent 决定。

| 编号 | 需求 | 验收 |
| --- | --- | --- |
| FR-2.1 | 注册 SSH 端点：`label`、`host`、`port`(默认 22)、`username`、凭据（密码 **或** 私钥路径）、可选备注/tags | 缺 host/username/凭据拒绝注册；端口非法拒绝 |
| FR-2.2 | **两种认证路径都必须支持**：密码认证与公钥认证（含 `~/.ssh/config` 中已配置的 IdentityFile） | 两条路径各有实测记录（S0.2 已完成） |
| FR-2.3 | 密码与私钥**不得明文落入项目目录或 git**；使用 OS 凭据库或本地加密存储，UI 只回显"已配置" | 仓库内检索不到任何凭据明文 |
| FR-2.4 | 主机密钥固定（TOFU：首次连接展示指纹，人工确认后写入 pinned 列表） | 指纹变更阻断连接并要求人工介入 |
| FR-2.5 | **能力探针**（只读）：平台/内核、CPU/内存、调度器客户端是否存在（`sbatch`/`qsub`/`bsub`）、`rsync` 版本、`tmux`、语言运行时、模块系统、挂载点与容量 | 探测结果写入端点画像；探测失败标 `unknown`，不得用旧值冒充 |
| FR-2.6 | 端点画像可手工覆盖（如节点数、GPU 型号、分区策略等探针拿不到的信息） | 覆盖值与探针对值分开存储、冲突可见 |
| FR-2.7 | 侧边栏展示端点健康与画像摘要 | 一眼判断"现在该去哪台" |

### 5.3 远程执行原语（FR-3）

> **本工具不做作业调度**。它提供与调度器无关的执行原语；agent 依据端点画像（是否有 Slurm、是否裸金属）自行决定用 `sbatch`、`nohup`、`tmux` 还是直接跑。

| 编号 | 需求 | 验收 |
| --- | --- | --- |
| FR-3.1 | `exec`：前台执行，携带 `cwd`、`env`、超时上限；返回 exit code、stdout、stderr | 超时被强制终止并明确标注 `timed-out` |
| FR-3.2 | `exec_start` / `exec_status` / `exec_logs` / `exec_kill`：后台执行，返回句柄；输出落项目专属远端目录，按 offset 增量拉取 | 断线重连后可按 offset 续读，不重复拉取 |
| FR-3.3 | 远端命令一律经安全转义（POSIX quote），参数不走字符串拼接 | 注入用例有反向测试 |
| FR-3.4 | 登录节点护栏：前台超时上限、可配置的高危命令拒绝清单（如直接跑长时间计算） | 越界命令被拒绝并给出改用后台/调度的提示 |
| FR-3.5 | 每次执行写入**动作审计日志**（时间、端点、命令摘要、退出码、发起方）；agent 可通过 `run_note` 追加语义注记（如作业号、实验目的） | 审计记录 append-only，可导出 |
| FR-3.6 | 调度器无关：工具不解析 `squeue`/`sacct`，也不维护作业状态机；对应信息由 agent 读取并写入注记 | 换调度器或裸金属无需改代码 |


### 5.4 传输与数据驻留（FR-4）

| 编号 | 需求 | 验收 |
| --- | --- | --- |
| FR-4.1 | `transfer_push` / `transfer_pull`，优先 rsync，sha256 校验，支持断点续传 | 中断重试不重传已完成部分 |
| FR-4.2 | `data/datasets.yaml`：逻辑 ID → 副本（endpoint/path/size/mtime/sha256） | 同一 ID 可多副本；`dataset_locate` 返回可用副本 |
| FR-4.3 | 显式 stage：提交前列出将传输的文件与体积，需确认 | 未确认不传输 |
| FR-4.4 | 结果回取只取声明为输出的路径 | 未声明文件不会被自动拉回 |

### 5.5 MCP 接口面（FR-5）

| 编号 | 需求 | 验收 |
| --- | --- | --- |
| FR-5.1 | resources：`project://{id}/context`、`project://{id}/datasets`、`hpc://endpoints` | agent 可读并据此行动 |
| FR-5.2 | tools：discovery / compute / fs / transfer / ledger / dataset 六组（§8） | 清单稳定且有版本 |
| FR-5.3 | 写操作携带 `requestId`，同参重复返回同一结果，异参拒绝 | 重试不产生重复作业/传输 |
| FR-5.4 | 全部工具调用落账本（何时/谁/参数摘要/结果） | 可从账本复现一次提交 |
| FR-5.5 | 危险操作（`shell_quick`、`fs_remove`）默认需确认或显式授权 | 无授权拒绝执行 |

### 5.6 上下文契约（FR-6）

| 编号 | 需求 | 验收 |
| --- | --- | --- |
| FR-6.1 | 生成**符合 AGENTS.md 规范**的投影文件，含项目目标、当前任务、近期运行摘要、可用端点、常用命令 | 任意支持 AGENTS.md 的 harness 进入目录即具备背景 |
| FR-6.2 | 支持**嵌套 AGENTS.md**（靠近文件的优先），允许子目录/子项目覆盖 | 子目录指令优先于根目录 |
| FR-6.3 | 注入受 token 预算约束，超限按重要性裁剪并在文首声明已裁剪 | 不因上下文膨胀导致 harness 报错 |
| FR-6.4 | 每条事实标注来源；冲突保留双方不静默覆盖 | 可追溯"谁说的" |
| FR-6.5 | 投影文件带生成标记；手改会被覆盖并告警 | 不产生"改了但没生效"的困惑 |

### 5.7 侧边栏（FR-7）

| 编号 | 需求 | 验收 |
| --- | --- | --- |
| FR-7.1 | 端点列表：健康、队列、GPU 空闲、配额 | 状态可刷新，有加载/失败态 |
| FR-7.2 | 简单操作：测试连接、浏览远端目录、查看运行中作业、取消 | 与 MCP 工具语义一致 |
| FR-7.3 | 危险操作二次确认并说明影响 | 不可一键误删 |

### 5.8 Harness 接入（FR-8）

| 编号 | 需求 | 验收 |
| --- | --- | --- |
| FR-8.1 | 识别本机已安装的 harness（dsh / kimi / codex），记录可执行路径与版本 | 列出可用/不可用状态 |
| FR-8.2 | 判定其原生界面形态（web / tui / both），并据此选择承载方式（FR-9） | 判定结果可手工覆盖 |
| FR-8.3 | **工具面**注册：MCP server（stdio/HTTP）优先；不支持 MCP 时提供 CLI 子命令 + AGENTS.md 使用说明 | 配置变更可回滚，写入前备份 |
| FR-8.4 | 在项目目录投放 AGENTS.md 投影 | 与 FR-6 一致 |
| FR-8.5 | **不侵入**：不修改 harness 代码、不写它的会话存储、不代理其推理请求；卸载后 harness 恢复原状 | 卸载后目录/配置无残留 |
| FR-8.6 | 接入自检：验证该 harness 能调用到工具，且界面能被承载 | 自检可复现、可导出 |

### 5.9 Agent 窗口（FR-9）

> 对话界面 = harness 自身的界面，本工具只做承载、不重写。

| 编号 | 需求 | 验收 |
| --- | --- | --- |
| FR-9.1 | **Web 承载窗口**：反向代理 harness 的本地 Web UI；每个 target 独立 origin/端口；一次性 ticket 换 HttpOnly cookie；转发 WebSocket upgrade；剥离阻断内嵌的响应头 | dsh web / kimi web 能在窗口内正常对话与流式输出 |
| FR-9.2 | **终端承载窗口**：node-pty + xterm.js，cwd = 项目目录；滚动缓冲有上限；断线重连恢复画面 | codex TUI 在窗口内可用 |
| FR-9.3 | **外部唤起兜底**：打开系统终端或浏览器，UI 仅记录"已在外部启动" | 承载失败时仍能工作 |
| FR-9.4 | 窗口与项目绑定：一个窗口属于一个项目，切换项目时按项目恢复窗口集合 | 关闭 UI 再打开可恢复 |
| FR-9.5 | 关闭浏览器不终止 harness 进程 | 重连后窗口内容仍在 |

### 5.10 进程托管与恢复（FR-10）

| 编号 | 需求 | 验收 |
| --- | --- | --- |
| FR-10.1 | daemon 持有 harness 进程（Web 类 detached 子进程；TUI 类 PTY 会话） | 进程归属可查（pid/启动时间） |
| FR-10.2 | 重启恢复：Web 类重拉并重新发现地址；TUI 类标记会话已结束并提供 `resume` 入口 | 重启后不产生僵尸进程 |
| FR-10.3 | 跨平台：Windows（ConPTY）/ macOS / Linux；不依赖 tmux | 三平台各有一条冒烟记录 |
| FR-10.4 | 地址发现：优先显式固定端口；否则解析 harness 公开启动输出（如 `dsh web: http://127.0.0.1:<port>/?token=...`、kimi 启动时的 bearer token）；解析失败降级外部唤起 | 解析失败有明确错误与降级动作 |
| FR-10.5 | 版本变化防护：只依赖公开启动输出，不解析内部协议；harness 升级后用自检确认承载仍可用 | 升级场景有回归用例 |


---

## 6. 非功能需求

| 编号 | 维度 | 要求 |
| --- | --- | --- |
| NFR-1 | 安全 | 私钥永不出本机；**主机密钥固定为强制**（不接受未知密钥）；远端命令强制 shell quote；`shell_quick` 有超时与二进制白名单；不向远端写入凭据 |
| NFR-2 | 可靠性 | 账本 append-only；`unknown` 为一等状态；派生数据可重建；崩溃对账不重复提交 |
| NFR-3 | 性能 | UI 本地交互 < 100ms（不含远端探测）；探测带 TTL；大文件流式传输不占内存 |
| NFR-4 | 可维护性 | 明确模块边界与边界测试；领域逻辑与传输/调度适配器分离 |
| NFR-5 | 可移植性 | 本地支持 macOS 与 Linux |
| NFR-6 | 可观测性 | 结构化日志；每次运行可追溯；关键工具调用有审计 |
| NFR-7 | 政策合规 | 假设登录节点禁止长任务；计算必须经调度器；不绕过配额 |
| **NFR-8** | **许可合规** | 依赖清单含许可证；CI 阻断 AGPL/未知许可证进入分发物；第三方代码片段保留出处与许可 |

---

## 7. 数据与文件契约

```
<project>/
  project.md              # 权威：项目元数据
  knowledge/
    facts/<id>.md         # id/updated_at/source/confidence
    decisions/<id>.md     # ADR
  plan/
    roadmap.md
    tasks/<id>.md         # status/depends_on/acceptance
  runs/<run-id>.md        # 运行账本（append-only 语义）
  results/<run-id>/       # 主要结果（小体积）
  data/datasets.yaml      # 逻辑数据集 → 副本
  .index/                 # 派生 SQLite（git 忽略，可重建）
  AGENTS.md               # 生成的上下文投影（勿手改）
```

**权威性规则**：只有上面的文件是权威；`.index/` 与内存状态都不是。`runs/` 只追加。生成文件带标记，手改被覆盖并告警。

---

## 8. 接口契约（MCP）

### 8.1 Resources（只读）

| URI | 内容 |
| --- | --- |
| `project://{id}/context` | 目标、当前任务、近期运行、待办、约束（受预算裁剪） |
| `project://{id}/datasets` | 逻辑数据集与副本位置 |
| `hpc://endpoints` | 端点静态画像与最近一次探测摘要 |

### 8.2 Tools（动作）

| 组 | 工具 | 幂等 |
| --- | --- | --- |
| discovery | `hpc_list` / `hpc_probe` | 是 |
| compute | `job_submit` / `job_status` / `job_logs` / `job_cancel` | 是（requestId） |
| fs | `fs_list` / `fs_stat` / `fs_mkdir` / `fs_remove` | 是（`fs_remove` 需授权） |
| transfer | `transfer_push` / `transfer_pull` | 是 |
| guarded | `shell_quick` | 否（需确认 + 审计） |
| ledger | `run_list` / `run_get` / `run_note` | 读 / 追加 |
| dataset | `dataset_register` / `dataset_locate` | 是 |

### 8.3 结果语义

| 结果 | 含义 | 客户端行为 |
| --- | --- | --- |
| `applied` | 已完成 | 继续 |
| `rejected` | 明确拒绝 | 修正后重试 |
| `uncertain` | 无法确认 | **禁止自动重试**，先查询确认 |
| `unknown`（状态） | 作业状态未知 | 等待对账，不得判定完成 |

---

## 9. MVP 切片与验收

| 切片 | 内容 | 验收标准 | 状态 |
| --- | --- | --- | --- |
| **S0** | 可行性验证：①harness 接入机制；②连接认证与只读探测；③传输能力（rsync）与续传；④候选组件许可核查 | 各项产出带原始输出的记录 | **①③④完成，②完成** |
| **S1** | 项目内核 + 端点配置 + 只读侧边栏 + AGENTS.md 投影 | 删 `.index/` 可完整恢复；harness 读到投影 | 待开始 |
| **S2** | 单端点闭环：连接 → 执行/后台执行 → 日志 → 上传/下载 → 动作审计 | 断线重连可续读；凭据不出本机 | 待开始 |
| **S3** | 多端点：画像对比、跨机传输、人工选址 | 同一操作在新端点跑通，数据来源可追溯 | 待开始 |

**MVP 完成定义**：J1–J5 全部走通；J6 至少两个 harness 可接入；密码与密钥两种认证路径均可用。

---

## 10. 风险与待验证

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| R1 | 各 harness 的 MCP 注册方式不同（配置文件格式、是否支持 HTTP） | 接入成本上升 | stdio shim 统一兜底；FR-8.5 自检 |
| R2 | 登录节点政策限制 | 长任务占用登录节点 | 前台超时上限 + 高危命令清单；提示改用后台会话或调度器 |
| R3 | 跨网传输是主瓶颈 | stage/pull 体验差 | rsync 断点续传 + 校验 + 体积预告 |
| R4 | 上下文膨胀 | harness 溢出或成本上升 | token 预算 + 分层注入 |
| R5 | 多入口并发写同一项目 | 数据损坏 | 单写者守护进程 + 串行化 |
| R6 | ~~调度器差异~~ | ~~工具面需抽象~~ | 已消解：D11 调度器无关，工具不碰调度语义 |
| **R7** | **harness 私有配置格式随版本漂移** | 工具面注册失效 | 写入前备份 + 自检可重跑 + 失败回滚 |
| **R8** | **第三方组件许可证误用** | 法律风险 | D10 + NFR-8 + 依赖清单审计 |
| **R9** | **harness Web UI 的启动输出格式变化**（地址/token 行改写） | 承载失败、窗口打不开 | 优先固定端口；只解析公开启动输出；解析失败降级外部唤起；纳入接入自检 |
| **R10** | **内嵌页面被 X-Frame-Options/CSP/Host 校验拦截** | 窗口白屏 | 反向代理重写响应头与 Host；kimi 使用其代理模式参数；仍失败则外部唤起 |
| **R11** | **Windows ConPTY 下 TUI 渲染异常**（颜色、宽字符、按键） | codex 窗口体验差 | 用 xterm.js + ConPTY 实测；异常时降级外部终端；记录为已知限制 |
| **R12** | **harness Web UI 自带鉴权差异**（dsh 用 URL token，kimi 用 bearer token） | 代理适配成本 | 代理层按 target 配置鉴权策略；token 一律换成 ticket + HttpOnly cookie |

---

## 11. 与 Project Citadel 的关系

| 维度 | Citadel | 本工具 |
| --- | --- | --- |
| 一等公民 | 机器与 agent 会话 | 项目 |
| HPC 角色 | 可挂项目、跑终端与 agent 的机器 | 纯执行/存储资源 |
| agent 位置 | 本地 Pi + 每台远端 helper 上的 Codex/Kimi | 全部本地；远端零安装 |
| 会话 | 每台机器各自会话，UI 承载 | 不管理会话（D8），仅注入 AGENTS.md |
| 集成协议 | 自研 host-helper（Unix socket JSONL） | MCP |
| 状态存储 | `.citadel` SQLite 为主 | 项目目录文件为主 |

Citadel 的可复用经验：幂等回执 + `uncertain` 不重放、架构边界脚本、SSH 连接池与租约、单实例锁。不可复用：机器为中心的建模与远端 helper。

---

## 12. 问题状态

### 12.1 已决

| # | 问题 | 结论 | 决策号 |
| --- | --- | --- | --- |
| Q1 | 调度器 | **不锁定**。实测测试端点有 Slurm 20.11.9，但用户环境中存在裸金属；工具不做调度语义，只做执行原语，调度由 agent 决定 | D11 |
| Q3 | rsync 与跨机数据 | 不做设计期假设，**由端点探针实测**（`rsync`/`tar`/`df`/`quota` 可用性），结果进端点画像 | D11 |
| Q6 | harness 范围 | **三个全接**（dsh / kimi / codex），用于验证 FR-8 的抽象是否成立 | D12 |
| — | 技术栈 | **TypeScript / Node**（前后端同语言、类型共享、官方 MCP SDK） | D12 |
| — | 凭据形式 | **密码 + 私钥并列支持**；不得明文入库 | D13 |
| — | harness 接入方式 | **MCP → CLI → 原生适配器**三层降级；MVP 做到前两层 | D14 |

### 12.2 未决

| # | 问题 | 为什么要紧 | 默认假设（未回答则按此执行） |
| --- | --- | --- | --- |
| Q2 | 单作业规模：多作业并行还是基本一次一个？ | 决定是否需要并发提交与排队管理 | **先按单作业闭环**，接口预留并发 |
| Q4 | 会不会多台本地机访问同一项目？ | 决定远程访问模型 | **先按单机本地**，不实现多机同步 |
| Q5 | 与 Citadel 的关系 | 决定是否复用代码与设计文档 | **彻底新建**，仅借鉴设计经验 |
| Q7 | S0.2/S0.3 需要一个真实 Slurm 端点 | 无端点无法验证 shell-only 轮询与 rsync 续传 | 由用户提供只读探测方式（见 §16.3） |

---

## 13. 复用清单（已核实，S0 基线）

> 核实方式：通过 `codeload.github.com` 拉取源码快照（GitHub HTTPS 直连在本机被阻断，SSH-443 可用），核对 LICENSE、manifest、工具清单与传输实现。快照落在 `references/oss/`。

| 候选 | 许可证 | 架构匹配 | 复用判定 |
| --- | --- | --- | --- |
| [ssh-mcp](https://github.com/m-kvn/ssh-mcp)（Python/Paramiko，22 个工具，支持 ProxyCommand，远端零安装） | **AGPL-3.0** | 高 | **不并入代码**。可作为"用户自行安装的外部 MCP"或仅借鉴工具分类。另：默认 `AutoAddPolicy`（自动接受未知主机密钥），与 NFR-1 冲突，若采用必须强制 strict |
| [slurm-mcp (sahuno)](https://github.com/sahuno/slurm-mcp)（Python，MIT，10 个工具） | **MIT** | **低**：subprocess 直接调 `sbatch/squeue/sacct`，要求运行在登录节点，非远程 SSH | **复用其工具 schema 与命令封装词汇**，传输层改为 SSH 远程执行 |
| [mcp-slurm (tejasvinu)](https://github.com/tejasvinu/mcp-slurm)（TS，node-ssh，5 个工具） | **无 LICENSE** | **高**：本地 MCP + SSH 到登录节点 | **不可复用代码**（默认保留所有权利）。仅借鉴工具划分：info/submit/job_control/script/files |
| [basic-memory](https://github.com/basicmachines-co/basic-memory)（Python，Markdown 知识图 + MCP） | **AGPL-3.0** | 中 | 仅借鉴 Markdown/知识图 schema，不引入代码 |
| [agent-session-bridge](https://pypi.org/project/agent-session-bridge/)（Python，MIT） | **MIT** | 中（D8 暂缓） | 列入暂缓清单；若恢复会话互通可直接依赖 |
| [AGENTS.md](https://agents.md/)（LF 托管规范） | 开放规范 | 高 | 自由实现；FR-6 即按此规范 |

**结论**：看起来"可复用"的 6 个候选里，只有 2 个可以合法并入代码，且其中一个（sahuno）的传输架构与 D2 不匹配。因此 S0 的复用策略应为：**规范层复用（AGENTS.md、MCP）+ 命令与 schema 词汇复用（MIT）+ 传输与账本自研**。

---

## 14. 暂缓清单（等真实使用反馈再评估）

| 能力 | 触发条件 | 候选实现 |
| --- | --- | --- |
| 跨 harness 会话转写与 resume | 用户反馈"换 harness 后要重新说明背景"成本高 | `agent-session-bridge`（MIT，已验证 Claude Code/Codex/Hermes 互转） |
| 事件溯源共享记忆（L2） | 需要"项目级记忆"而非仅 AGENTS.md 静态投影 | ESAA 模式：append-only 事件日志 → 投影 handoff/state/decisions/tasks |
| 自动选址 | 人工选址成为瓶颈 | 资源画像 + 策略引擎 |

---

## 15. 术语表

| 术语 | 含义 |
| --- | --- |
| 端点 | 一台可 SSH 到达的超算登录节点及其画像 |
| 运行（run） | 一次提交的完整生命周期记录，账本基本单位 |
| 账本 | `runs/` 下追加式记录集合 |
| stage / pull | 提交前把输入送到远端 / 结束后把结果取回 |
| 上下文投影 | 由权威文件生成的 AGENTS.md，供 agent 直接读取 |
| unknown | 无法从远端证据确认的状态，严禁当作完成或失败 |
| harness | 本地 coding agent 运行体（dsh / kimi / codex） |

---

## 16. S0 执行记录（滚动更新）

### 16.1 S0.1 已完成：harness 接入机制核实

核实环境：本机（Windows + Git Bash），2026-10-29。仅做只读探测与配置结构阅读，未修改任何 harness 配置。

| harness | 版本 | 可执行路径 | MCP 注册机制 | 结论 |
| --- | --- | --- | --- | --- |
| **codex** | `codex-cli 0.46.0` | `%APPDATA%\npm\codex` | **有官方 CLI**：`codex mcp add <COMMAND\|--url <URL>> <NAME>`、`list`/`get`/`remove`；配置落 `~/.codex/config.toml`（`[mcp_servers.*]`）；**同时支持 stdio 与 streamable HTTP** | ✅ 最规范，优先用 CLI 写入而非手改 TOML |
| **kimi** | `2.2.0` | `~/.kimi-code/bin/kimi` | 标准 `mcpServers` JSON：`~/.kimi-code/mcp.json`（另有遗留 `~/.kimi/mcp.json`） | ✅ 直接改 JSON，格式与 Claude/Cursor 同构 |
| **dsh** | `0.2.0-rc.2` | `%APPDATA%\npm\dsh` | **不是 mcp.json**：profile = pnpm workspace + `cordis.yml`（空根）+ `cordis.patch.yml` 覆盖层 + `package.json` 的 `dsh.profile.bundles`；配置 schema 中存在条目 `@deepseek-ai/dsh-mcp-resources` / 键 `mcp-resources`，但该插件未安装 | ⚠️ **消费外部 MCP server 的路径未确认**，需专项验证（见 16.2） |

### 16.2 S0.1 遗留验证项（dsh）

1. 在 `cordis.patch.yml` 中挂载 `@deepseek-ai/dsh-mcp-resources` 后，是否能读到外部 MCP server 的 tools/resources；
2. 若不能，降级方案：把本工具能力同时暴露为 **CLI 子命令**，由 dsh 通过 shell 工具调用（牺牲工具面统一性但不牺牲功能）；
3. 记录方式：一次最小实验（挂插件 → `dsh --dump-config` → 让 agent 调用一个 echo 工具），输出留存为 S0 证据。

### 16.3 S0.2 已完成：连接、认证与端点探测（真实主机）

测试端点：`114.214.255.60:22`，用户 `taoshijie`；实现栈为本项目实际选型 **Node 24 + ssh2**（非系统 `ssh`）。

| 验证项 | 结果 | 证据 |
| --- | --- | --- |
| 公钥认证 | ✅ 通过（本机 `~/.ssh/config` 已配 `IdentityFile`，`ssh -G` 可见；ssh2 直接加载该私钥） | 连接 205 ms，`hostname=login01` |
| 密码认证 | ✅ 通过（`SSH_PASS` 经环境变量传入，未落盘） | `PASSWORD_AUTH_OK` / `taoshijie` / `login01` |
| 主机密钥指纹 | `SHA256:RdHHL8XKm28DrTNlHdu9NhY+o5qzf8Dr5V/9AbardOI` | `hostVerifier` 采集，可作为 pin 示例 |
| 远端零安装 | ✅ 成立：全程只用 `exec` 跑只读命令，未写入任何文件、未安装任何组件 | 探测脚本仅含 `hostname/uname/cat/command -v/df/quota` |

**端点画像（自动发现，写入画像供 agent 使用）**：

| 维度 | 实测值 |
| --- | --- |
| 平台 | Linux 4.18.0-193.el8.x86_64，CentOS 8 (Core) |
| 登录节点 | `login01`，4 vCPU / 98 GB |
| 调度器 | **Slurm 20.11.9**（`sbatch`/`squeue`/`sacct`/`scancel`/`sinfo`/`scontrol` 均在 `/usr/local/globle/softs/slurm/20.11.9/bin`）；`qsub`/`qstat` 缺失 |
| 传输 | **rsync 3.1.3** 可用；SFTP 假定可用 |
| 交互 | tmux 可用 |
| 运行时 | python3（miniconda）、conda、docker；无 singularity/apptainer |
| 模块系统 | `module` 命令可用 |
| 存储 | `/public` 800 TB（Nexdata，38% 用量）；`/usr/local/globle/softs` 491 GB；`/` 141 GB |
| HOME / SHELL | `/public/home/taoshijie` / `/bin/bash` |

**探测发现的两个设计要点**：

1. **`quota -s` 会挂起**（20 s 超时未返回）——探针必须逐命令设超时，且超时命令只能标 `unknown`，不得阻塞整体画像。这也验证了 FR-2.5 的"探测失败标 unknown"要求。
2. **登录节点与计算节点资源差异显著**（登录节点 4 vCPU/98 GB）——端点画像必须区分"登录节点规格"与"集群/分区规格"，后者靠 agent 读取 `sinfo` 等命令获得，工具不做解析（D11）。

### 16.4 复现命令

```bash
# 公钥
SSH_HOST=<host> SSH_USER=<user> SSH_KEY_PATH=<private-key> node scripts/dev/ssh-probe.mjs
# 密码（凭据仅经环境变量传入，不落盘）
SSH_HOST=<host> SSH_USER=<user> SSH_PASS=<password> node scripts/dev/ssh-probe.mjs
```

探测脚本 `scripts/dev/ssh-probe.mjs` 只包含只读命令，可审计后执行；S1 起该逻辑迁入核心的 `hpc_probe` 工具。

### 16.5 S0.3 已完成：harness 原生界面承载可行性

核实环境：本机，2026-10-29（只读探测，未启动/修改任何 harness 配置）。

| harness | 原生界面形态 | 启动方式 | 承载方案 | 关键证据 |
| --- | --- | --- | --- | --- |
| **dsh** | Web UI（+ TUI） | `dsh --profile web --no-open --port 0`，就绪后打印 `dsh web: http://127.0.0.1:<port>/?token=<token>` | 反向代理 + 内嵌窗口 | `dsh --help`；Citadel 已实现同款解析（`src/server/own-interfaces/dsh.ts:179`） |
| **kimi** | Web UI（+ TUI + ACP） | `kimi web --port <p>`，本地 HTTP + bearer token；官方支持置于自有认证代理之后（`--dangerous-bypass-auth`、`--allowed-host`） | 反向代理 + 内嵌窗口 | `kimi web --help` 全量参数 |
| **codex** | **仅 TUI**（无 web 子命令） | 默认交互式 TUI；另有 `exec` / `app-server` / `mcp-server` / `resume` | 终端窗口（node-pty + xterm.js） | `codex --help` 子命令清单 |

**承载结论**：

1. **两种承载原语足够**：Web 代理窗口（dsh/kimi）+ 终端窗口（codex）。不需要原生协议适配器，也不需要 harness 提供 UI 插件机制。
2. **反向代理是硬需求**，原因：token 不能交给前端；harness 有 Host/DNS-rebinding 校验；手机访问时 `127.0.0.1` 会指向手机自身；每 target 需独立 origin 做隔离；WebSocket upgrade 必须转发。
3. **Citadel 的可借鉴部分**：`own-interfaces` + `web-carrier` 的 window carrier 设计（独立 origin、一次性 ticket→cookie、hop-by-hop 头过滤、WS 转发、页面端口池）。**不可借鉴部分**：其 Pi/ACP/app-server 会话适配器（自建会话，与 D6 冲突）。
4. **Citadel 方案的平台缺口**：它用 tmux 托管 dsh web 进程；本机为 Windows，无 tmux，故 D15 改为 daemon 直接托管子进程/PTY。
5. **当前 dsh WebUI 未携带页面时返回 401**（需 token），验证了 FR-9.1 的 ticket→cookie 流程必要性。

**待验证（S1 内完成）**：

- codex TUI 在 Windows ConPTY + xterm.js 下的渲染与按键（R11）
- kimi web 与 dsh web 的响应头是否阻断 iframe，以及代理重写规则（R10）
- harness 升级后启动输出格式稳定性的回归用例（R9）


### 16.6 S1 进行中：页面承载层已落地并验证

| 步骤 | 结果 | 证据 |
| --- | --- | --- |
| 移植 `carrier-protocol` + `web-carrier` | ✅ 完成，包名改为 `@multiservers/*`，`citadel` 字样已清理 | `packages/carrier-protocol/`、`packages/web-carrier/` |
| 入口路径与 cookie 前缀更名 | ✅ `/__multiservers/enter`、`multiservers_page_*` | `packages/carrier-protocol/src/index.ts:73`、`packages/web-carrier/src/carrier.ts:124` |
| 构建 | ✅ `npm run build` 通过，产出 `dist/*.js` + `*.d.ts` | 两个包的 `dist/` |
| **Windows 兼容性冒烟** | ✅ **7/7 通过**：启动→监听→ticket→pass cookie→转发上游→匿名拒绝→撤销拒绝 | `npm run test:carrier`（`scripts/dev/carrier-smoke.mjs`） |
| 关键跨平台适配 | 上游中继 socket 在 Windows 上用命名管道 `\\.\pipe\multiservers-*`，在 POSIX 上用 Unix domain socket | 冒烟测试同时覆盖两种分支 |

**冒烟测试证明的链路**：`fork(carrier)` → IPC 下发 target → carrier 监听独立端口 → `GET /__multiservers/enter?ticket=…` 返回 303 + `HttpOnly; SameSite=Strict` cookie → 带 cookie 请求到达上游 → 无 pass 返回 401 → `revoke-passes` 后旧 pass 失效。

**尚未验证（留待接入真实 harness 时）**：WebSocket upgrade 转发、真实 dsh/kimi 页面的响应头（XFO/CSP）重写、目标应用断线重连。
