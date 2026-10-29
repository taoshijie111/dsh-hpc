# Multiservers

科研工作的本地工作台：**项目在本地，远端服务器是算力与存储资源**。

本地守护进程持有项目状态、服务器配置与 agent 进程；界面承载各 coding agent（dsh / kimi / codex）**自己的**界面，而不是重新实现一套会话 UI。

> 当前状态：**S1 demo**。可运行的纵切是「本地 Web 工作台 + 内嵌 dsh 原生 Web UI」；
> 项目内核、服务器配置、终端窗口仍在后续切片。需求与决策见 [docs/requirements.md](docs/requirements.md)。

## 快速开始

```bash
npm ci
npm run build
npm start
# 打开 http://127.0.0.1:4390/
```

页面会自动请求打开 DeepSeek Harness 窗口。首次启动 dsh web 约 5–8 秒。

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MULTISERVERS_PORT` | `4390` | 本地守护进程端口 |
| `MULTISERVERS_BIND` | `127.0.0.1` | 监听地址（默认仅本机） |
| `MULTISERVERS_DATA_DIR` | `.multiservers` | 本地运行态目录 |
| `MULTISERVERS_DSH_BIN` | 自动发现 | dsh 的真实入口（`lib/bin.js`）路径 |

## 当前可用的能力

| 能力 | 状态 |
| --- | --- |
| 守护进程（Fastify）+ 静态工作台 UI | ✅ |
| harness 发现（dsh，含版本） | ✅ |
| 启动 dsh web 并**不依赖 tmux** 解析其地址与 token | ✅ |
| 页面承载：私有 relay → carrier → 一次性 ticket → 内嵌窗口 | ✅ |
| 匿名访问拒绝、票据单次、pass 撤销 | ✅ |
| 子资源代理（JS/插件包，633 KB + 40 KB 实测） | ✅ |
| WebSocket/流式子资源 | ⏳ 待真实对话验证 |
| kimi 承载 | ⏳ 下一片 |
| codex 终端窗口（node-pty + xterm） | ⏳ 下一片 |
| 服务器端点配置 / 凭据 | ⏳ S1-c |
| 项目内核 / AGENTS.md 投影 | ⏳ S1-d |

## 架构（当前纵切）

```
浏览器 127.0.0.1:4390
  └─ 工作台 UI（侧边栏 + 窗口区 iframe）
       │
       └─ daemon（Fastify，权限与状态中心）
            ├─ WindowManager：窗口 → relay → carrier target → ticket
            ├─ CarrierProcess ── fork ──> web-carrier（独立进程，无控制端口）
            │                                 └─ 独立 origin，ticket→cookie，WS 转发
            └─ HarnessWebProcess ── spawn ──> dsh --profile web --no-open --port 0
                                              （stdout 发布地址 + token）
```

relay：Windows 用命名管道，POSIX 用 Unix domain socket；carrier 因此接触不到任意网络。

## 开发命令

```bash
npm run typecheck        # 三个 tsconfig
npm run test:carrier     # carrier 冒烟（7 项断言，Windows 已通过）
npm run probe:harness dsh  # 单独探测 harness web 地址发现
```

## 代码来源

`packages/carrier-protocol`、`packages/web-carrier` 移植自作者自己的 Project Citadel 项目，
详见 [NOTICE.md](NOTICE.md)。
