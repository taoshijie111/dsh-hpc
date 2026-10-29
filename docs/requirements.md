# 产品需求 v1.9 — DSH 服务器管理插件（`dsh-multiservers`）

| 项 | 内容 |
| --- | --- |
| 定位 | DeepSeek Harness 插件：**服务器管理 + 登录/会话 + 文件传输**。不实现终端 UI、不做调度、不包装 Linux 基础命令 |
| 契约基线 | DSH `>= 0.2.1-rc.2 < 0.3.0` |
| 形态 | 一个 bundle：Host 半（连接/会话/传输/工具）＋ Client 半（Settings → 服务器 设置页） |
| 状态 | 需求草案，等待实施 |

---

## 1. 核心原则

1. **一条命令一个执行通道，不做命令包装**：`ls`、`mkdir`、`rm`、`cat` 这类 Linux 命令是 agent 的常识，插件不再提供对应工具；登录后由 agent 自己在 shell 里执行。
2. **连接与会话分离**：连接是传输层（可复用、可断线重连）；会话是远端 shell 进程（保持 `cd`/环境变量，需显式打开关闭）。
3. **长连接是默认，不是可选**：同一服务器复用一条已认证连接；显式提供登录/登出/状态工具。
4. **不确定即停**：断线中断的写操作标记 `uncertain`，绝不自动重放。
5. **尊重 HPC 约束**：登录节点会话配额、空闲踢线、登录节点不得跑长任务——插件只提供能力与提示，不替 agent 做调度决定。

## 2. 概念模型

| 概念 | 定义 | 生命周期 |
| --- | --- | --- |
| **服务器（Server）** | 配置中的一条记录：地址、端口、用户名、凭据、固定主机指纹 | 持久（profile 配置 / 设置页） |
| **连接（Connection）** | 一条已认证 SSH 传输通道；其上可开多个通道（shell / sftp） | 惰性建立、空闲回收、显式登出、插件卸载时关闭 |
| **会话（Session）** | 连接上的一个远端 shell 进程；`cd`、环境变量、已加载 module 在其中保持 | 显式打开/关闭；shell 死亡或超时被重置时失效 |

一条连接可承载**多个命名会话**（每服务器默认上限 4，可配置）；会话之间 `cwd`/环境变量互相独立。

## 3. 生命周期状态机

```
                    server_connect / 任意工具调用
   未连接 ────────────────────────────────────────► 已连接
      ▲                                                │
      │  server_disconnect / 空闲超时 / 插件卸载        │
      └────────────────────────────────────────────────┘
                                                       │ 网络中断 / 服务端踢线
                                                       ▼
                                                   断开（下次操作时重连）
```

- **建连**：首次需要时自动建立；`server_connect` 可提前建立。
- **保活**：keepalive 探测，默认 30s（可配置）。
- **空闲回收**：默认 10 分钟无操作自动断开（可在设置页修改；`0` 表示不自动断开）。
- **重连**：操作前探活失败 → 丢弃旧连接、重建一次（仅读操作自动重试；写操作见 §6）。
- **清理**：插件卸载 / HMR 时关闭全部连接与会话。

## 4. 会话（多会话 · 粘性 shell）

**一个连接 = 一条 SSH 通道；会话 = 通道上的独立 bash 进程。** 每服务器最多 `maxSessionsPerServer` 个（默认 4），防止占满登录节点配额。

- `shell_open(server, name?)`：创建命名会话（默认名 `main`）；同名已存在则复用。会话独立维护 `cwd`、环境变量、已加载 module。
- `shell_run(server, command, session?)`：写入该会话的 stdin，用**唯一哨兵**切分输出并读取退出码；同名会话内命令**串行**执行。
  省略 `session` 时使用 `main`（不存在则自动创建）。
- `shell_close(server, session?)`：结束指定会话；连接保留。全部会话关闭后连接仍按空闲策略回收。
- `session_list`：列出会话（服务器、名称、创建时间、最近活动、是否存活）。
- 会话之间互不影响：一个会话 `cd /tmp` 不影响另一个；一个会话超时重置不影响其他会话。
- **超时策略**：单命令默认超时 120s（可配）。超时只杀该会话的 shell 并重建同名会话，返回 `timedOut + stateReset=true`；其他会话不受影响。
- **上限**：达到 `maxSessionsPerServer` 时拒绝新建，提示先关闭闲置会话。
- **不实现交互式终端**：需要持续交互（编辑器、top）时，由 agent 在会话里用 `tmux`；插件不承担终端 UI。

## 5. 工具面 v2（14 个）

| 组 | 工具 | 作用 |
| --- | --- | --- |
| 管理 | `server_list` | 列出服务器与凭据/指纹状态 |
| | `server_add` | 注册服务器（密码写入 DSH 凭据库） |
| | `server_remove` | 移除服务器（默认同时清除密码凭据） |
| | `server_test` | 连接测试：可达性、延迟、主机指纹、pin |
| | `server_probe` | 只读能力画像（OS、调度器客户端、rsync、tmux、存储） |
| 连接 | `server_connect` | 显式登录（建立/复用连接） |
| | `server_disconnect` | 显式登出（关闭连接与会话） |
| | `server_status` | 连接状态：已连/空闲时长/会话状态/最近错误 |
| 会话 | `shell_open` | 打开或复用粘性 shell |
| | `shell_run` | 在粘性 shell 中执行命令（保持 cwd/env） |
| | `shell_close` | 关闭指定会话（连接可保留） |
| | `session_list` | 列出会话与存活/活动状态 |
| 传输 | `upload` | 本地文件 → 服务器（SFTP，支持续传+校验，见 §5.1） |
| | `download` | 服务器 → 本地文件（SFTP 单文件） |

**移除的工具**：`run`（由 `shell_run` 取代）、`ls`、`stat`、`mkdir`、`rm`（agent 直接在 shell 里用 Linux 命令）。

**保留 `upload`/`download` 的理由**：二进制文件走 shell 需要 base64/重定向，既慢又易错；SFTP 是正确通道，且可复用同一连接。

### 5.1 传输策略（rsync / 续传）

| 阶段 | 方案 | 说明 |
| --- | --- | --- |
| **基线（必须）** | SFTP 单文件 + 按偏移续传 + sha256 校验 | 跨平台（含 Windows 本机）、复用连接池、无需远端 rsync |
| 目录同步 | SFTP 遍历 + 逐文件比较（大小/mtime；可选哈希） | 中等规模可用；海量小文件另议 |
| 可选增强 | 两端都探测到 rsync 时，提供 `sync` 工具走目录增量 | 代价：rsync 自起 ssh 进程，**不复用连接池**，依赖系统 ssh/密钥；默认关闭 |
| 不做 | 自研 delta 算法、Globus/GridFTP 集成 | — |

**结论**：rsync 是 Unix/HPC 的主流增量同步技术，但本机 Windows 无 rsync、且它无法复用 ssh2 连接；因此 SFTP 续传是基线，rsync 作为检测到双方具备时的可选增强。

## 6. 失败与重试语义

| 场景 | 行为 |
| --- | --- |
| 连接失败 / 认证失败 | 报明确错误，不重试；提示检查凭据/网络 |
| 主机指纹不匹配 | **拒绝连接**，要求人工确认后重新 pin |
| 读操作时发现连接已断 | 自动重连 1 次并重试 |
| 写操作（upload/删除类命令）中断 | 返回 `uncertain`，不自动重试；提示先核对远端状态 |
| `shell_run` 超时 | 只杀掉该会话并重建同名会话，返回 `timedOut + stateReset=true`；其他会话无影响 |
| shell 进程意外退出 | 标记会话失效；下次 `shell_run` 自动重建并告知状态已丢失 |
| 空闲超时 | 静默关闭；下次操作自动重连；会话状态丢失需在返回中说明 |

## 7. HPC 环境约束（设计前提）

- 登录节点会话数有配额：**每服务器只保留一条连接**，避免占满。
- 登录节点会踢空闲会话：keepalive + 空闲回收是必需项。
- 长任务/GPU 任务应交给调度器：插件不解析 `sbatch/squeue`，但 `server_probe` 会把可用调度器告诉 agent。
- 密码/MFA：当前仅支持密码与公钥；**键盘交互式 MFA 尚未支持**（明确列为限制）。

## 8. 配置项（设置页）

| 字段 | 默认 | 设置页呈现 |
| --- | --- | --- |
| `servers[]` | `[]` | 服务器列表（添加/编辑/移除） |
| `idleTimeoutMs` | 600000（10 分钟） | “空闲断开时间”（分钟；0 = 不断开） |
| `maxSessionsPerServer` | 4 | 收进“高级” |
| `keepaliveIntervalMs` | 30000 | 收进“高级” |
| `commandTimeoutMs` | 120000 | 收进“高级” |
| `connectTimeoutMs` | 15000 | 收进“高级” |

设置页文案保持面向使用者：不出现工具名、存储实现、字段约束等实现细节。

## 9. 验收标准

| # | 验收项 |
| --- | --- |
| A1 | 连续 5 次 `shell_run` 只发生 1 次 SSH 认证；第 2 次起单命令延迟显著低于首次建连 |
| A2 | `cd /tmp` 后 `pwd` 返回 `/tmp`；`export X=1` 后 `echo $X` 返回 1 |
| A3 | 断开网络/杀掉连接后，读操作自动重连成功；写操作返回 `uncertain` 而非成功 |
| A4 | 空闲 10 分钟后连接关闭（`server_status` 显示未连接），下次操作自动重连 |
| A5 | 超时命令导致会话重建，返回 `stateReset=true`，后续命令可继续 |
| A6 | 主机指纹变更时拒绝连接并报明确错误 |
| A7 | 插件卸载/重载后无残留远端 shell 进程（由 `server_status` 与远端 `ps` 交叉验证） |
| A8 | 设置页可修改空闲时间并生效（无需重启） |
| A9 | 两个会话分别 `cd` 到不同目录，各自 `pwd` 互不影响 |
| A10 | 一个会话超时重置后，另一会话仍在原目录且可继续执行 |
| A11 | 超过 `maxSessionsPerServer` 时拒绝新建并给出可操作提示 |

### 9.1 实施与验证（v1.3）

| 验证 | 结果 |
| --- | --- |
| 工具面 | 14 个工具注册；`run/ls/stat/mkdir/rm` 已移除 |
| 连接复用 | 首连 3.7s，复用后单命令 0–42ms；`server_status` 报告单连接 |
| 粘性会话 | `cd /tmp` 后 `pwd` 为 `/tmp`；命名会话 cwd/env 互相隔离 |
| 超时语义 | 单命令超时只重置本会话（`stateReset=true`），其他会话不受影响 |
| 会话上限 | 达 `maxSessionsPerServer` 拒绝新建并给出提示 |
| 传输 | 上传/下载 sha256 校验通过；相同文件重复上传跳过；`upload --overwrite` 行为已定义 |
| 集成测试 | `test/tools-smoke.mjs` **19/19**；`test/session-smoke.mjs` **13/13** |
| 网页端 | 新工具面与「连接设置」已下发，插件加载无报错 |


### 9.2 v1.4 实施记录（工具面收敛 + P0 + 指定 P2）

| 项 | 结果 |
| --- | --- |
| 工具面 14 → 10 | `server_list` 合并运行时状态；`server_test` 合并探测与建连（`profile` 开关）；`shell_run` 自动建会话；删除 `server_status/session_list/shell_open/server_probe/server_connect` |
| P0-1 输出上限 | `shell_run` 捕获上限 1 MiB，`maxBytes` 可调，返回 `truncated/totalBytes` |
| P0-2 原子传输 | 上传/下载均写 `.part`，校验后 rename；中断可续传 |
| P0-3 密码移出工具 | `server_add` 不再接受 password；密码只在设置页写入凭据库 |
| P0-4 指纹不由 agent pin | `server_test` 仅报告指纹；信任由设置页人工确认 |
| P2-9 目录传输 | `upload`/`download` 支持目录递归，逐文件原子传输 |
| P2-10 会话空闲回收 | `sessionIdleTimeoutMs`（默认 30 分钟，0=关闭），设置页可改 |
| P2-12 密钥口令 / MFA | 私钥 passphrase 走 `keyPassphraseRef` 凭据；keyboard-interactive 用同一凭据应答 |
| P2-13 端口转发 | `forward` 工具经连接池转发本地 TCP 端口；断开/卸载时自动关闭 |
| 测试 | tools-smoke **19/19**；session-smoke **13/13** |


### 9.3 v1.6 设置页状态面板（替代斜杠命令）

| 项 | 结果 |
| --- | --- |
| 决策 | 斜杠命令的 host 结果在当前 DSH 版本不作为第三方节点渲染，改为人人可用的设置页面板；`/servers`、`/usage` 已移除 |
| Host API | `GET /api/multiservers/status`（配置 + 连接/会话/转发）、`GET /api/multiservers/usage?server=<id>`（负载/内存/CPU/GPU/磁盘/作业）；要求同源头 `x-multiservers-request: 1` |
| 设置页 | 「状态」区：在线状态、会话、转发、刷新；每台服务器「资源占用」按需采样并内联渲染 |
| 验证 | status/usage 接口实测返回正确 JSON；集成测试 19/19 |


### 9.4 v1.7 长任务后台子系统

| 项 | 实现 |
| --- | --- |
| 服务器类型 | `kind: auto\|bare\|slurm`（默认 auto）；首次提交探测 `sbatch+squeue` 并缓存到 `resolvedKind`，可手动覆盖 |
| 默认资源 | `schedulerDefaults`（partition/account/qos/time/cpus/memory/gpus）+ 任务级覆盖 |
| 账本 | `$DSH_HOME/multiservers/jobs/<id>.json`，脚本与日志在远端 `jobRoot`（默认 `~/.multiservers/jobs`） |
| 裸金属后端 | 脚本落盘 + `setsid nohup` 启动；pid 文件 + `/proc/<pid>/stat` 启动时间防复用；退出码文件判定终态 |
| Slurm 后端 | 生成 `#SBATCH` 脚本 + `sbatch --parsable`；`squeue` 查运行态、`sacct` 查终态，记账延迟返回 `unknown`；`scancel` 取消 |
| 工具 | `job_submit`（立即返回 jobId）、`job_status`、`job_logs`（offset/截断）、`job_cancel`；工具总数 14 |
| 稳定性修复 | `execRemote` 超时只销毁通道不关连接池；后台启动以 pid 文件返回，不等待通道关闭 |
| 测试 | jobs-smoke **14/14**（裸金属 `wxj-94` + Slurm `jz`）；tools-smoke **20/20** |


### 9.5 v1.8 作业完成通知（本地 watcher）

| 项 | 实现 |
| --- | --- |
| 背景 | 旧用法靠 agent 在远端跑采样器写日志再读日志，长任务（DFT 数天）会产生无限日志且持续消耗上下文 |
| 方案 | 提交后在本机注册 DSH 后台任务（`ctx.jobs.start`，owner=当前会话）：只轮询远端状态（`squeue`/`kill -0`），不写任何远端日志；作业终态时后台任务结束，`dsh-tool-jobs` 自动向该会话推送完成通知 |
| 轮询 | 自适应退避：15s → 25s → … → 上限 15min；监控失败仅追加一条诊断，不中断 |
| 工具 | `job_submit` 新增 `watch`（默认 true）；新增 `job_wait`（默认 5min 阻塞等待）；`job_status` 返回 `watching`；`job_cancel` 同时撤销 watcher |
| 重载恢复 | 插件启动时按账本恢复未完成作业的 watcher（无 owner 时退化为静默监控） |
| 测试 | jobs-smoke **17/17**（含 watcher 注册、job_wait、cancel 撤销）；tools-smoke **20/20**（15 工具） |


### 9.6 v1.9 设置界面重做（手动资源采样）

| 项 | 实现 |
| --- | --- |
| 资源采样改为手动触发 | 点「资源占用」→ 临时建立一条 SSH 连接 → 采集 CPU/内存/GPU/磁盘/作业 → **立即断开**；不占用连接池、不影响 agent 会话 |
| 结构化数据 | Host 解析 `uptime/nproc/top/free/nvidia-smi/df/squeue` 返回 JSON（含 `/proc/meminfo` 回退，过滤 boot/efi 噪声磁盘） |
| 可视化 | CPU 使用率条（含核数/负载）、内存条、每卡 GPU 利用率+显存条、磁盘条、排队作业数；按 60%/85% 变色 |
| 布局修复 | 输入框 `box-sizing` + `min-width:0`，网格改为 `auto-fit minmax`；长字段（地址/密码/私钥/指纹）整行显示，消除可填框重叠；连接设置按「空闲与回收 / 超时与保活」分组 |
| 服务器类型 | 状态行显示 Slurm / 裸金属 / 自动检测徽标 |
| 类型检测 | `kind: auto` 首次采样或点「检测类型」时探测 `scontrol/sbatch`→Slurm、`qsub/qstat`→PBS、`bsub/bjobs`→LSF，否则裸金属；结果写回 `resolvedKind` 并显示在服务器卡片；新建/编辑时可手动指定（自动/裸金属/Slurm/PBS/LSF） |
| Slurm 集群视图 | jz 显示计算节点而非登录节点：71 节点（空闲/混合/分配/异常）、CPU 分配率 90.7%（12366/13632 核）、各节点可用内存合计（约 29.5 TB）、分区明细（cpu192 / cpu192-mem-64G）、运行/排队作业；登录节点仅作参考行 |
| 实测 | wxj-94（512 核、A800、内存 52%）与 jz（Slurm 集群）均返回正确结构化数据；采样后 `connected:false` 证明已自动断开 |

### 9.7 传输回归（v1.9.1）

| 场景 | 结果（wxj-94 / jz 各 19 项） |
| --- | --- |
| 单文件上传/下载（文本） | sha256 校验通过、内容一致 |
| 二进制文件（4 KB 随机） | 双向往返字节一致 |
| 相同文件重复上传 | `skipped=true`、传输 0 字节 |
| 目录（4 文件、含两级嵌套、二进制） | 递归上传/下载，文件数、嵌套内容一致 |
| 多文件（3 个独立文件入库） | 逐个上传 + 目录下载 3 文件 |
| 覆盖保护 | 同大小不同内容拒绝（提示 overwrite），`overwrite=true` 可替换 |
| 上传续传 | 远端 `.part` 512 KB → 续传（resumed=true，仅传剩余 1.5 MB） |
| 下载续传 | 本地 `.part` 512 KB → 续传（resumed=true） |
| `.part` 残留 | 传输后远端无 `*.part` 残留 |
| 缺失文件下载 | 明确报错 `Remote file not found` |
| 现场修复 | 每笔传输单独开 SFTP 通道并关闭；此前通道泄漏会撞服务器 MaxSessions |

### 9.8 传输进度/取消与大文件调优（v1.9.2）

| 项 | 实现 |
| --- | --- |
| 后台传输 | `upload`/`download` 新增 `background: true`：传输注册为 DSH 后台任务，`job_output` 看实时进度（`1.2 GB / 4.0 GB · 30%`），`job_kill` 取消，完成时收到会话通知 |
| 取消语义 | 前台传输走 `exec.signal`：上传按块检查、中断后保留可续传 `.part`；中断且 0 字节时不留下空文件 |
| 分块自适应 | 256 KB（<32 MB）/ 4 MB（32–256 MB）/ 8 MB（>256 MB）；可用 `chunkSize` 显式覆盖 |
| 下载加速 | 非续传路径改用 ssh2 `fastGet`（concurrency 32、1 MB 分块）管线化拉取；续传仍用带 offset 的流式读取 |
| 结果指标 | 每次传输返回 `durationMs` / `throughputMBps` |

**1 GB 实测（wxj-94，2026-10-29）**

| 指标 | 数值 |
| --- | --- |
| 上传 | 992 MB 实际传输（含 32 MB 续传）· 30.4 s · **32.6 MB/s** |
| 下载 | 1024 MB · 18.2 s · **56.2 MB/s** |
| 校验 | 远端 sha256 = 本地 sha256，下载字节一致 |
| 中断 | 取消后无空 `.part`，续传从 32 MB 偏移继续 |
| 调优前 | 下载 ~4–5 MB/s → **56 MB/s**；上传 ~5 MB/s → **33 MB/s** |
| 测试 | `npm run test:transfer:big`（`MSS_BIG_MB` 可调，默认 512） |

### 9.9 传输队列（v1.9.3）

| 项 | 实现 |
| --- | --- |
| 工具 | 新增 `transfer_queue`（第 16 个工具）：`direction` + `items`（JSON 数组 `{localPath, remotePath}`）+ `overwrite/chunkSize/continueOnError/background` |
| 执行模型 | 默认注册为 DSH 后台任务，顺序处理每个条目；`job_output` 看每项/每块进度，`job_kill` 取消；结束时推送完成通知 |
| 失败策略 | `continueOnError` 默认 true：单项失败继续，摘要含每项结果与错误；false 时遇到首个失败即停 |
| 无后台服务时 | 自动退化为同步执行并返回完整摘要（测试环境可用） |
| 目录条目 | 目录递归传输；单文件上传自动 `mkdir -p` 远端父目录（此前缺失会导致 "No such file"） |
| 实测 | 前台队列 9/9（3 文件+目录+新建嵌套目录、失败继续/停止、非法 JSON）；headless 真实后台队列：`mss-transfer-11850a8c69f342f6`，3 项 3 文件 failed=0，完成通知送达 |

### 9.10 传输父目录语义（v1.9.4）

| 项 | 实现 |
| --- | --- |
| 参数 | `upload(localPath, remoteDir)`、`download(remotePath, localDir)`：目标 = 父目录 + 来源 basename；父目录必须由调用方显式给出 |
| 队列 | `transfer_queue` 条目改为 `{source, targetDir}`（上传 targetDir=远端父目录，下载 targetDir=本地父目录） |
| 行为 | 不再从来源路径自动推导目标父目录；显式给出的父目录不存在时创建；缺失父目录参数会明确报错 |
| 兼容 | 旧的全路径参数 `remotePath`/`localPath`/`{localPath,remotePath}` 仍接受 |
| 验证 | `test/parent-dir.mjs` 8/8：文件/目录上传下载的 basename 追加、队列 targetDir、旧参数兼容、缺参报错 |

## 10. 待定

1. ~~多会话~~（已定：多会话，默认上限 4）。
2. **目录同步的 rsync 可选增强**：等 SFTP 基线稳定后评估。
3. **键盘交互式认证（MFA）**：暂不支持。
4. **会话空闲回收**：当前只有连接级空闲回收；会话级是否需要独立 TTL 待观察。

## 11. 版本记录

- v1.0 插件化重写：12 个工具、凭据、主机指纹、设置页
- v1.1 连接/会话模型讨论
- v1.2 连接复用 + 粘性 shell；移除基础文件工具；空闲时间可配置
- v1.3 多会话（命名、上限、独立状态、session_list）；传输策略分层（SFTP 续传为基线，rsync 可选）
- v1.3 已实施：连接池 + 多会话 + 新工具面 + SFTP 续传/校验；集成测试 19/19 与 13/13
- v1.4 已实施：工具面收敛为 10 个；P0 四项；目录传输、会话空闲回收、密钥口令/MFA、端口转发
- v1.5 斜杠命令实验（已移除：第三方 host 命令结果无渲染节点）
- v1.6 设置页「状态」面板 + host 状态/采样 HTTP 接口；移除斜杠命令
- v1.7 长任务子系统：服务器类型/默认资源、作业账本、裸金属与 Slurm 双后端、4 个 job 工具
- v1.8 本地 watcher + DSH 后台任务完成通知；job_wait；取消联动撤销监控
- v1.9 设置界面重做：手动资源采样（连一次、采完断开）、CPU/GPU 可视化、表单布局修复
