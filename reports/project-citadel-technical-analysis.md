# Project Citadel 技术分析报告

| 项目 | 内容 |
| --- | --- |
| 分析对象 | `references/project-citadel-dev-main/`（本地源代码快照） |
| 仓库标识 | `project-citadel` v0.1.0，`private: true`（`package.json:2-4`） |
| 代码规模 | 811 个文件（排除 `node_modules`）：实现 123,775 行 TS/TSX，测试 53,398 行，设计文档 11,339 行，CSS 19,866 行 |
| 分析方式 | 纯静态分析（源码、配置、CI 定义、设计文档）；未执行 `npm ci` / `build` / `test`，未启动服务实例 |
| 证据约定 | 每个结论附 `文件:行号`；无法定位者标 **未识别**；有线索但不足定论者标 **待确认** |
| 分析单元 | 4 个并行分析单元（服务端+共享层 / 前端+构建 / 协议栈+部署 / 质量+安全）＋主分析师交叉核验 |

---

## 0. 分析范围、方法与静态边界

### 0.1 实际读取的输入

| 类别 | 具体输入 |
| --- | --- |
| 构建与依赖清单 | `package.json`、`package-lock.json`（lockfileVersion 3）、`packages/*/package.json`、7 个 `tsconfig*.json`（根 3 + 各包 4） |
| 构建器配置 | `vite.config.ts`、`vitest.config.ts`、`playwright.config.ts`、`eslint.config.js`、`.prettierrc.json` |
| 入口与组合根 | `src/server/index.ts`、`src/server/app.ts`、`index.html`、`src/client/main.tsx` |
| 工程脚本 | `scripts/` 41 个文件（构建、边界校验、验证、评估） |
| CI | `.github/workflows/foundations.yml`（唯一流水线） |
| 文档体系 | `AGENTS.md`、`README.md`（227 行）、`design/` 130 篇（其中 `design/dev-history/` 68 篇） |
| 测试资产 | `tests/` 174 个文件（100 个 Vitest 用例、64 个 Playwright spec） |

### 0.2 证据等级约定

| 标记 | 含义 | 处理方式 |
| --- | --- | --- |
| 已确认 | 在源码/配置中直接定位 | 给出 `文件:行号` |
| 未识别 | 全仓检索后确认不存在对应实现 | 显式写"无"，并说明检索口径 |
| 待确认 | 存在线索但静态分析无法定论 | 说明缺哪一步验证 |

### 0.3 静态分析边界（重要）

1. **不做运行时断言**。凡涉及"性能""并发竞态""实际内存占用""启动耗时"的结论，本报告一律不给出定量判断。
2. **依赖版本为声明值**。`package.json` 中写的是 semver 区间（如 `^5.12.7`），`node_modules` 未随仓库提供，实际解析版本 **待确认**（需 `npm ls --depth=0` 或读取 `package-lock.json` 的 resolved 字段）。
3. **无 `.git` 目录**。该快照不含版本控制元数据，因此提交历史、分支策略、评审流程、贡献者结构、变更频率、是否存在已删除的部署文件均 **未识别**。
4. **未量化覆盖率**。仓库未配置覆盖率工具，测试行数是源码统计而非覆盖率数值。

---

## 1. 项目概览

### 1.1 基本身份

| 维度 | 结论 | 依据 |
| --- | --- | --- |
| 产品定位 | 个人使用的自托管 WebUI，用于人机持续协作：管理机器、终端、文件、手工项目、与 agent 对话 | `README.md:3-5`、`AGENTS.md:3` |
| 仓库形态 | 单仓库多包（monorepo），npm workspaces，4 个私有 workspace 包 | `package.json:113-115` |
| 模块系统 | 纯 ESM（`"type": "module"`） | `package.json:5` |
| 目标平台 | Linux 与 macOS；AGENTS.md 明确 Windows 不在支持面 | `AGENTS.md:31-39`、`README.md:11` |
| 交付状态 | 里程碑开发（M0→M3.99 已实施，M4 仅计划未授权） | `design/implementation-status.md` |

### 1.2 目录结构与组织方式

```
project-citadel-dev-main/
├── src/
│   ├── server/     73 文件 / 33,333 行    Fastify 服务端（按职责分子域）
│   │   ├── agents/        会话仓储、本地工具、项目编辑、权限
│   │   ├── pi/            Pi 推理子进程的 RPC/凭证/会话
│   │   ├── external-agents/ 外部 agent 运行时（Codex/Kimi/ACP）+ 远端 helper
│   │   ├── machines/      机器注册、终端、vitals、应用设置
│   │   ├── own-interfaces/ 原生 WebUI（DSH/Kimi WebUI）承载
│   │   ├── appearance/    图片库
│   │   └── native/        随构建编译的 C 原生模块
│   ├── shared/     39 文件 /  6,976 行    zod 契约 + 域类型（双端共用，禁 import 两端）
│   └── client/    293 文件 / 73,675 行 TS/TSX + 19,866 行 CSS   React SPA
│       ├── app/ shell/ ui/ widgets/  路由、窗口管理、原子组件、可配置 widget
│       ├── apps/         12 个应用（files/projects/terminal/settings/…）
│       ├── data/ sync/   传输层、实时通道、订阅仓库
│       ├── fixtures/ dev/ 示例与设计预览面（生产依赖图禁止可达）
│       └── styles/       23 个全局 CSS（设计令牌 + BEM）
├── packages/      4 个工作区包 / 9,791 行
│   ├── helper-protocol/    宿主助手 wire 契约（zod）
│   ├── carrier-protocol/   页面承载载体契约（zod）
│   ├── host-helper/        独立可部署的宿主助手（bin: citadel-host-helper）
│   └── web-carrier/        应用无关的反向代理载体
├── tests/         174 文件 / 53,398 行  Vitest（100）+ Playwright（64）
├── scripts/        41 文件 / 12,008 行  构建、边界校验、端到端验证、行为评估
├── design/        130 篇 / 11,339 行    设计规范与开发史（68 篇归档）
├── config/         hosts.example.json   仅为虚构示例，真实配置在仓库外
└── .github/workflows/foundations.yml    唯一 CI 流水线
```

组织方式的两个显式约定：

1. **按职责而非按里程碑命名**：`design/domain-organization.md:13-29` 定义归属表；`scripts/check-boundaries.ts:31-33` 以脚本强制"`src/` 内路径不得以里程碑编号命名"。
2. **兼容词表与源码命名分离**：HTTP 路径 `/api/v1/m1|m2|m3`、SQLite 表前缀 `m1_/m2_/m3_`、事件字面量属于兼容面，源码名可改、序列化名不可改（`design/domain-organization.md:9`；表前缀见 `src/server/store.ts:59-274`）。

### 1.3 入口文件

| 入口 | 作用 | 依据 |
| --- | --- | --- |
| `src/server/index.ts` | 服务端进程入口：加载配置 → 建数据目录（`0o700`）→ 获取单实例租约 → `createApp` → `listen`；SIGINT/SIGTERM 触发 `app.close()` + 释放租约 | `src/server/index.ts:7-34`、`package.json:13`（`start: node dist/server/index.js`） |
| `index.html` | SPA 宿主页，挂载 `/src/client/main.tsx` | `index.html:11` |
| `src/client/main.tsx` | 前端入口：引入 3 套可变字体 + 19 个全局 CSS → `createRoot` + `StrictMode` + 唯一根 Provider `PrefsProvider` | `src/client/main.tsx:1-34` |
| `packages/host-helper` | 独立进程的宿主助手，`bin` 暴露 `citadel-host-helper → dist/main.js` | `packages/host-helper/package.json:9-11` |
| `packages/web-carrier` | 无 `bin`，只能由服务端以 Node IPC 拉起（缺 `process.send` 直接 `exit 2`） | `packages/web-carrier/src/main.ts:9-44` |

### 1.4 项目类型判定

**判定：模块化单体（modular monolith）的自托管 Web 应用**，形态是「单页桌面式 SPA + 同源 Fastify HTTP/WebSocket 服务 + 多个受管子进程/远端助手」。

| 候选类型 | 判定 | 依据 |
| --- | --- | --- |
| Web 应用 | 是 | SPA + REST/WS 服务同源分发（`src/server/app.ts:587-595` 静态资源与 SPA 回退） |
| 单体 vs 微服务 | **单体** | 全部 HTTP 路由注册在同一个 Fastify 实例（`src/server/app.ts:281-586`）；无服务发现、无独立部署单元、无跨进程 API 网关 |
| CLI 工具 | 否 | `scripts/` 41 个文件是验证/评估入口，非产品 CLI；无 `bin` 于根包 |
| 库 / SDK | 否 | 所有包 `private: true`，协议包仅内部消费（`packages/*/package.json`） |
| 桌面应用 | 否（但形态接近） | 浏览器外壳 + 自研窗口管理器（`src/client/shell/windows.tsx`），无 Electron/Tauri 依赖 |
| 边端/多机系统 | 部分成立 | 主服务通过 pinned SSH 在远端主机部署 helper 并拉起本地 agent 进程（`src/server/external-agents/remote-bootstrap.ts:19-34`），属于"单控制面 + 多执行宿主" |

### 1.5 规模度量

| 区域 | 文件数 | 行数 | 占比（实现口径） |
| --- | --- | --- | --- |
| `src/client`（TS/TSX） | 265（另 23 CSS + 5 资产） | 73,675 | 59.5% |
| `src/server` | 73 | 33,333 | 26.9% |
| `src/shared` | 39 | 6,976 | 5.6% |
| `packages/*` | 44 | 9,791 | 7.9% |
| **实现合计** | — | **123,775** | 100% |
| `tests` | 174 | 53,398 | 测试/实现 = **0.43 : 1** |
| `scripts` | 41 | 12,008 | 与实现比 0.10 : 1 |
| `design`（Markdown） | 130 | 11,339 | 与实现比 0.09 : 1 |

体积分布结论：**前端是最大单体**（59.5%），且其中 14,469 行属于 `fixtures/`（7,991）与 `dev/`（6,478）预览/示例代码，生产依赖图已用脚本排除其可达性（`scripts/check-boundaries.ts:14-20`）。已知超过 1,000 行的源文件 **27 个**（`src` + `packages` 口径）。

---

## 2. 技术栈识别

> 说明：下表"声明版本"取自 `package.json` 的 semver 区间；实际解析版本 **待确认**（`node_modules` 未提供）。所有条目均给出对应配置或代码位置。

### 2.1 编程语言及版本约束

| 项 | 结论 | 依据 |
| --- | --- | --- |
| 主语言 | TypeScript（全仓无 JavaScript 源文件，测试 fixture 为 `.mjs`） | `scripts/`、`src/` 全为 `.ts/.tsx`；`tests/fixtures/*.mjs` |
| TypeScript 版本（编译/typecheck） | 声明 `^7.0.2` | `package.json:100` |
| TypeScript 版本（AST 分析） | 另设别名 `typescript-api: npm:typescript@^6.0.3`，专供 Compiler API 脚本使用 | `package.json:101`；`scripts/check-boundaries.ts:1`、`scripts/maintenance/imports.ts:1` |
| 编译目标 | `target: ES2023`，`module/moduleResolution: NodeNext`（服务端）；前端 `module: ESNext` + `Bundler` | `tsconfig.json:3-6`、`tsconfig.client.json:4-5` |
| 类型严格度 | `strict: true` + `noUncheckedIndexedAccess: true` | `tsconfig.json:7-8` |
| 运行时语言版本 | Node.js `>=24.22.1 <25`（根包与两个可部署包均声明） | `package.json:6-8`、`packages/host-helper/package.json:6-8`、`packages/web-carrier/package.json:6-8` |
| 运行时版本约束的业务理由 | 24.22.1 起包含 eMudhra 证书链修复 | `README.md:19` |
| 原生代码 | C（`src/server/native/exclusive-rename.c`），由系统 `cc` 在构建期编译 | `scripts/build-native.ts:9-34` |

### 2.2 框架与核心运行时

| 类别 | 技术 | 声明版本 | 用途与依据 |
| --- | --- | --- | --- |
| HTTP 服务框架 | Fastify | `^5.12.7` | 全部 API/WS 路由；`src/server/app.ts:281` `Fastify({...})` |
| Fastify 插件 | `@fastify/cookie` | `^11.1.3` | Cookie 读写；`src/server/app.ts:330` |
| | `@fastify/websocket` | `^11.3.4` | 实时通道与终端 WS；`src/server/app.ts:340`（`maxPayload: 65536`） |
| | `@fastify/static` | `^10.1.7` | 分发 `dist/client` 静态产物；`src/server/app.ts:589` |
| 前端框架 | React + React DOM | `^19.3.1` | `src/client/main.tsx:29-34`；使用 `lazy/Suspense`、`<Activity>`、`useSyncExternalStore`、`useEffectEvent` |
| 前端构建 | Vite + `@vitejs/plugin-react` | `^8.3.5` / `^6.1.2` | `vite.config.ts:1-28` |
| 契约校验 | zod | `^4.6.7` | 全栈共享 schema：`src/shared/*.ts`、`packages/*-protocol/src/*.ts` |
| 数据库驱动 | better-sqlite3（同步 API） | `^13.0.3` | `src/server/store.ts:573` `new Database(...)` |
| 另一 SQLite 客户端 | `node:sqlite`（`DatabaseSync`，Node 内置） | 随 Node 24 | 仅宿主助手侧账本；`packages/host-helper/src/ledger.ts:1` |
| PTY | node-pty | `1.1.0`（精确版本） | 本地终端；`src/server/machines/local-terminal.ts:134` |
| SSH | ssh2 | `^1.17.0` | 远端机器连接、跳板、SFTP；`src/server/remote.ts:18` |
| 文件锁 | proper-lockfile | `^4.1.2` | 单实例租约；`src/server/lease.ts:6-12` |
| 终端渲染 | `@xterm/xterm` + `addon-fit` | `^6.0.0` / `^0.11.0` | 仅 2 个前端文件：`src/client/apps/terminal/LiveTerminal.tsx:2` |
| Markdown 渲染 | react-markdown + remark-gfm | `^10.1.0` / `^4.0.1` | 仅 `src/client/ui/AgentMarkdown.tsx:2-3` |
| 图标 | lucide-react | `^1.61.0` | 86 个前端文件引用 |
| 字体 | `@fontsource-variable/{inter,fraunces,jetbrains-mono}` | `^5.3.0` | 入口 `import`；`src/client/main.tsx:1-3` |
| Agent 推理运行时 | `@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent` | `1.4.0`（精确） | 主对话 agent；`src/server/pi/rpc.ts`、`src/server/pi/providers.ts` |

### 2.3 依赖管理与包管理器

| 项 | 结论 | 依据 |
| --- | --- | --- |
| 包管理器 | **npm**（无 `pnpm-lock.yaml` / `yarn.lock`） | 仅 `package-lock.json`；CI 使用 `npm ci`（`.github/workflows/foundations.yml:28`） |
| 工作区机制 | npm workspaces，`packages/*` | `package.json:113-115` |
| 锁文件 | `lockfileVersion: 3`，锁定 579 个 `node_modules/*` 条目 | `package-lock.json:5`、条目计数 |
| 直接依赖规模 | 21 个 `dependencies` + 22 个 `devDependencies` | `package.json:59-105` |
| 传递依赖钉版 | `overrides` 强制 `@earendil-works/pi-coding-agent → undici 8.12.3` | `package.json:116-120` |
| 安装脚本白名单 | `allowScripts` 仅允许 5 个含原生编译的包执行 postinstall（better-sqlite3、cpu-features、esbuild、node-pty、ssh2） | `package.json:106-112` |
| 版本一致性风险 | `helper-protocol` 的 `package.json` 为 `0.12.0`，但 wire 身份是 `HELPER_VERSION="0.15.0"` / `HELPER_PROTOCOL=5` → 包版本已滞后于协议版本（疑似漏改，**待确认**是否有意） | `packages/helper-protocol/package.json:3` 对比 `packages/helper-protocol/src/index.ts:8,11` |

包依赖是严格单向且被脚本强制的：`host-helper → helper-protocol`、`web-carrier → carrier-protocol`；协议包禁止 import `src/` 或 `host-helper`（`scripts/check-boundaries.ts:67-78`）。

### 2.4 构建 / 打包工具与脚本

**构建链（单一入口 `npm run build`，`package.json:12`）：**

```
npm run build
  ├─ build:helper
  │    ├─ build:protocol   tsc -p packages/helper-protocol  ─→ dist/index.js + .d.ts
  │    │                   tsc -p packages/carrier-protocol
  │    ├─ build-helper.ts  esbuild → packages/host-helper/dist/main.js（bundle, esm, node24）
  │    └─ build-carrier.ts esbuild → packages/web-carrier/dist/main.js
  ├─ tsc -p tsconfig.server.json   rootDir=src → dist/（src/server + src/shared, sourceMap）
  ├─ tsx scripts/build-native.ts   拷贝并 cc -O2 编译 exclusive-rename.c → dist/（失败仅降级）
  └─ vite build                    → dist/client/
```

| 工具 | 声明版本 | 角色 | 依据 |
| --- | --- | --- | --- |
| tsc 多 project | `^7.0.2` | 服务端 emit、协议包 emit、前端仅 typecheck（`noEmit`） | `tsconfig.json`、`tsconfig.server.json`、`tsconfig.client.json` |
| esbuild | `^0.28.2` | 把 host-helper / web-carrier 打成单文件 ESM bundle（无运行时 npm 依赖） | `scripts/build-helper.ts:3-12`、`scripts/build-carrier.ts:4-10` |
| Vite | `^8.3.5` | 前端产物；`outDir: dist/client`；dev 固定 `127.0.0.1:5173` 且 `/api` 代理到 `4321`（`ws: true`） | `vite.config.ts:20-27` |
| tsx | `^4.23.15` | `dev` 的 watch 运行器与全部验证脚本执行器 | `package.json:10`、`22-57` |
| 系统 C 编译器 | `cc`（外部依赖） | 编译原生 rename 适配器 | `scripts/build-native.ts:6-8` |

**前置钩子链（属性是隐式构建依赖，`package.json:41-48`）：** `predev`/`pretypecheck`/`pretest`/`precheck:boundaries` 均先执行 `build:helper` 或 `build:protocol`，保证协议包 `dist` 先于类型检查与测试存在。这是一处需要读者注意的隐式契约：直接跑 `npx vitest` 或 `tsc --noEmit` 而不经 npm 脚本会因缺少协议 `dist` 而失败。

### 2.5 数据存储与中间件

| 类别 | 结论 | 依据 |
| --- | --- | --- |
| 主存储 | **SQLite 单库** `.citadel/citadel.sqlite`，WAL 模式 + 外键约束 | `src/server/store.ts:573`、`store.ts:614-615` |
| 表结构定义 | 集中在 `store.ts` 的 `migrations` 数组，**20 个版本**（v1→v20），版本顺序应用、每版独立事务 | `src/server/store.ts:25-412` |
| 迁移策略 | 拒绝降级（未知更高版本直接拒绝）；v16 之前迁移先 `VACUUM INTO` 备份 | `src/server/store.ts:435-468`、`store.ts:578-610` |
| 持久化门面 | `resource-store.ts`（M1 记录，读写全过 zod）、`agent-store.ts`（M2 门面：UoW/事件/会话仓储） | `src/server/resource-store.ts:112`、`src/server/agent-store.ts:221` |
| 数据目录布局 | `citadel.sqlite`、`service.lock`、`credentials/`、`artifacts/`、`pictures/`、`private/`、`storage/`、`agents/main/{agent,sessions,work}`、`m3-helper/`、`fixture/` | `src/server/config.ts:144`、`src/server/app.ts:121`、模块内路径拼接 |
| 缓存 | **无**（无 Redis/Memcached 等依赖或实现） | `package.json:59-81` 依赖清单无缓存客户端 |
| 消息队列 / 中间件 | **无**。异步工作队列由 SQLite 表承担（`m2_dispatch_intents`、`m2_retry_intents`） | `src/server/store.ts:204-259` |
| 对象/文件存储 | 文件系统即存储；制品落 `dataDir/artifacts/<operationId>.json` | `src/server/app.ts:503` |
| 凭据存储 | 摘要（sha256）入库、明文/私钥落 `credentials/` 私有目录（`0o700`/`0o600`） | `src/server/access.ts:778-783`、`src/server/machine-runtime.ts:194-200` |
| 远端状态 | 宿主助手自有 journal（外存 schema v1）与 `node:sqlite` 账本 | `packages/host-helper/src/journal.ts:63-85`、`ledger.ts:18-42` |

### 2.6 测试框架与代码质量工具

| 工具 | 声明版本 | 覆盖范围与配置 | 依据 |
| --- | --- | --- | --- |
| Vitest | `^5.0.5` | `tests/**/*.test.ts`，node 环境（无 jsdom），`setupFiles: tests/setup-env.ts`，超时 15s；**100 个用例文件** | `vitest.config.ts:3`、`package.json:15` |
| Playwright | `^1.64.1` | `tests/browser`，仅 chromium，`workers: 1`，`fullyParallel: false`；**64 个 spec / 384 处 `test(` / 2,101 处 `expect(`**；`screenshot/trace` 强制 `off`（因配对响应含私有 cookie 证明） | `playwright.config.ts:24-46` |
| 可访问性 | `@axe-core/playwright ^4.14.0` | 30 个 spec 内 61 处 `AxeBuilder`，只断言 `serious|critical` | `tests/browser/a11y.spec.ts:26-31` |
| Lint | ESLint `^10.13.0` + `@babel/eslint-parser ^8.0.7` + `eslint-plugin-react-hooks ^7.1.1` | **仅 `src/client`**，仅 3 条规则：`rules-of-hooks`、`exhaustive-deps`、禁用 `crypto.randomUUID` | `eslint.config.js:5-31`、`package.json:34` |
| 格式化 | Prettier `^3.9.10` | `printWidth: 110`、`trailingComma: all`；`format:check` 不含 Markdown | `.prettierrc.json:1-4`、`package.json:33` |
| 架构边界校验 | 自研 `scripts/check-boundaries.ts`（TypeScript Compiler API，105 行） | 6 类规则，见 §3.4 | `scripts/check-boundaries.ts:12-105` |
| 类型检查聚合 | `npm run typecheck` 串联 4 个 tsconfig | 根（src 排除 client + tests + scripts）、client、host-helper、web-carrier | `package.json:14` |
| 行为/质量评估脚本 | `evaluate:m2`、`review:m0/m1/m2`、`verify:*` 共 30+ 入口 | 需真实 provider 的评估与受控 peer 验证分开 | `package.json:18-57` |
| CI | GitHub Actions 单文件 | `ubuntu-latest` + Node 24 + `npm run verify:m3` | `.github/workflows/foundations.yml:16-34` |

### 2.7 部署与运行方式

| 项 | 结论 | 依据 |
| --- | --- | --- |
| 容器化 | **无**（全仓无 Dockerfile / docker-compose / Buildah / Nix） | 全仓检索（排除 `node_modules`）仅命中 `.github/workflows` |
| 编排 | **无**（无 k8s / Helm / Nomad / Compose） | 同上 |
| 服务安装 | **无** systemd unit / launchd plist / PM2 配置（仅在注释中提到 launchd/systemd 的 PATH 场景） | `src/server/machines/local-machine.ts:22` |
| 实际部署方式 | `npm ci` → `npm run build` → `npm start`，即 `node dist/server/index.js` | `README.md:13-17`、`package.json:13` |
| 监听与传输 | 默认 `0.0.0.0:4321`，**明文 HTTP**；TLS、服务安装、反代信任均为"后续部署工作" | `README.md:21`、`README.md:68` |
| 生产环境变量（7 个） | `CITADEL_DATA_DIR`（默认 `.citadel`）、`CITADEL_BIND`（须 IP/localhost）、`CITADEL_PORT`、`CITADEL_ORIGINS`（逗号分隔 origin）、`CITADEL_HOSTS_FILE`（一次性遗留导入）、`CITADEL_PAGE_PORTS`（页码范围，≤1024） | `src/server/config.ts:143-196` |
| 已废弃环境变量 | `CITADEL_ACCESS_TOKEN`：非空即抛错，共享 token 登录已被硬性退役 | `src/server/config.ts:159-162`、`src/server/app.ts:396-402` |
| 配置校验 | 全部经 zod schema 校验；SSH 主机要求 `SHA256:` 43 字符指纹、macOS 必须显式 zsh、路径禁控制字符 | `src/server/config.ts:8-47` |
| 配置权威源 | 首次从 `CITADEL_HOSTS_FILE` 事务性导入后，**SQLite 为权威** | `README.md:136`、`src/server/config.ts:139-141` |
| 远端部署模型 | pinned SSH（含跳板）→ 传输 base64 自包含 Node 程序 → 校验 `node24`/平台/命名空间 → 以 sha256 命名写入 `~/.citadel_managed/helpers/<ns>/<digest>.mjs` → detached 启动；socket 落 `/tmp/citadel-rh-<uid>-<ns>/agent.sock` | `src/server/external-agents/remote-bootstrap.ts:19-34,76-78,159-203` |
| 私有信息策略 | 真实配置、地址、端口、凭据一律不入库；`.gitignore` 排除 `config/hosts.json`、`.citadel/`、`.env` | `.gitignore:1-10`、`config/hosts.example.json`（虚构值）、`AGENTS.md:47-49` |

### 2.8 技术栈"未识别"项

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 覆盖率工具 | **未识别** | `vitest.config.ts` 无 `coverage` 段；无 c8/istanbul 依赖 |
| Lint 规则集（typescript-eslint） | **未识别** | `devDependencies` 无 `typescript-eslint`/`@typescript-eslint/*` |
| 开源许可证 | **未识别**（项目级） | 仓库根无 `LICENSE`；`package.json` 无 `license` 字段（私有仓库，合理但需确认）。注：第三方图标资产自带许可文件 `src/client/own-interfaces/icons/DSH-LICENSE`、`KIMI-LICENSE` |
| 容器基础镜像 / IaC | **未识别** | 无 Terraform/Ansible/Pulumi |
| 服务网格 / 反向代理配置 | **未识别** | 无 nginx/Caddy 配置入库；README 将反代信任列为未完成项 |
| 依赖漏洞扫描 | **未识别** | 无 Dependabot 配置、无 `npm audit` 步骤、无 CodeQL/secret scanning |
| Node 版本管理器文件 | **未识别** | 无 `.nvmrc` / `.node-version`，版本约束仅存于 `engines`（`npm` 默认只告警不强制） |

---

## 3. 架构与模块划分

### 3.1 整体架构风格

**结论：分层 + 端口/适配器（ports & adapters）风格的模块化单体，控制面与执行面分离。**

三个可验证的结构特征：

1. **契约层独立**：`src/shared/` 只含 zod schema 与域类型，禁止 import `server` 或 `client`（`scripts/check-boundaries.ts:37-49` 强制）。它被 52 个服务端文件与 124 个客户端文件引用（import 图统计），是双端唯一的类型来源。
2. **前端端口化**：控制器只接受窄 `Pick` 端口 + `read/update/notify`，不直连 live 组合；非 `app/` 目录的功能禁止直连 `LiveResourceProvider`/`LiveAgentProvider`（`scripts/check-boundaries.ts:37-48`）。
3. **执行面外置**：agent 执行不在主服务进程内，而在 Pi 子进程谱系或远端 host-helper 内（§3.6），主服务只做编排与持久化。

### 3.2 分层视图

| 层 | 位置 | 职责 | 证据 |
| --- | --- | --- | --- |
| 表现层 | `src/client/{app,shell,ui,widgets,apps}` | 路由分发、窗口管理、12 个应用、原子组件 | `src/client/app/App.tsx:68`（硬编码路由 switch）、`src/client/shell/Desktop.tsx:67` |
| 边缘/接入层 | `src/server/app.ts`、`src/server/live.ts`、`src/server/terminal.ts` | Fastify 装配、鉴权总闸、错误映射、WS 事件泵、SPA 回退 | `src/server/app.ts:281-586` |
| 应用服务层 | `agent-service`、`resource-runtime`、`machines/runtime`、`external-agents/runtime`、`own-interfaces/runtime`、`operations`/`jobs`、`transfers` | 用例编排、状态机、生命周期 | `src/server/app.ts:142,151,200-257` |
| 领域契约层 | `src/shared/*` | zod schema、域类型、版本常量（`API_VERSION`/`DOMAIN_VERSION`） | `src/shared/service.ts`、`src/shared/live.ts`、`src/server/app.ts:12-24` |
| 基础设施适配层 | `file-providers`（Local/SFTP）、`machine-runtime`（CredentialVault/ConnectionManager）、`pi/*`（JSONL RPC）、`external-agents/helper-client`、`terminal-service`（node-pty） | 外部系统接入 | `src/server/file-providers.ts:471,804`、`src/server/machine-runtime.ts:115,499`、`src/server/pi/rpc.ts:1-12` |
| 持久化层 | `store.ts`（唯一 SQLite 句柄）+ `resource-store`/`agent-store`（门面） | 迁移、事务、事件写入 | `src/server/store.ts:564-620`、`src/server/store.ts:25-412` |

### 3.3 核心模块职责（服务端与共享层）

| 模块 | 行数 | 职责 | 证据 |
| --- | --- | --- | --- |
| `store.ts` | 927 | 唯一 SQLite 句柄、20 版迁移、基础表（tasks/operations/artifacts/events/browser_grants）、`schemaVersion` 与 `storeIdentity` | `store.ts:564-620` |
| `resource-store.ts` | 1,004 | M1 记录持久化，读写全过 zod 校验 | `resource-store.ts:1-4,112` |
| `agent-store.ts` | 2,869 | M2 门面：工作单元、事件写入、会话仓储、凭据投影（**全仓最大服务端文件**） | `agent-store.ts:221` |
| `agent-runtime.ts` | 656 | 单活 run 调度：同一 agent 同时仅一个 run 在跑 | `agent-runtime.ts:67,71` |
| `agent-service.ts` | 588 | M2 服务组合根 | `agent-service.ts:73-125` |
| `file-service.ts` | 2,205 | 唯一 HTTP ↔ 文件 provider 边界 | `file-service.ts:1-30` |
| `file-providers.ts` | 1,227 | Local 与 SFTP 两种文件 provider | `file-providers.ts:471,804` |
| `transfers.ts` | 2,012 | 服务端自有拷贝状态机（幂等 id = requestId，并发 2） | `transfers.ts:1-28,319-333` |
| `machine-runtime.ts` | 2,075 | `CredentialVault`（凭据落私有文件）+ `ConnectionManager`（SSH 连接池与租约）+ 机器注册 | `machine-runtime.ts:115,495-499` |
| `access.ts` | 953 | 请求边界（精确 Origin/Host/变更头）、loopback/paired/whitelist 三级鉴权、配对码生命周期、配对限流 | `access.ts:334-352,680-921` |
| `pi/rpc.ts` | 1,687 | 与 Pi 子进程的 JSONL 传输 + 命令白名单 | `pi/rpc.ts:1-12` |
| `pi/providers.ts` | 1,910 | 模型/凭证翻译与 provider 适配 | `pi/providers.ts:5-14` |
| `external-agents/runtime.ts` | 869 | 外部 agent 运行时编排（helper 生命周期、会话、历史） | `external-agents/runtime.ts:107` |
| `own-interfaces/runtime.ts` | 873 | 原生 WebUI 承载（DSH/Kimi WebUI） | `own-interfaces/runtime.ts` |
| `terminal-service.ts` | 590 | PTY + tmux 目标管理、断线重连 | `terminal-service.ts:347` |
| `live.ts` | 205 | 单一 scoped WS 订阅、快照/批次/检查点、背压 256 KiB | `live.ts:20,40-45` |
| `jobs.ts`/`operations.ts` | 289/218 | 任务→操作→制品；幂等 requestId、取消、对账 | `jobs.ts:155`、`operations.ts:27` |

### 3.4 模块依赖与耦合度量

| 指标 | 结果 | 方法/依据 |
| --- | --- | --- |
| 入度最高模块 | `store.ts`(20)、`resource-store.ts`(13)、`config.ts`(9)、`agents/errors.ts`(9)、`machine-runtime.ts`(7) | import 图脚本统计（TypeScript Compiler API 解析） |
| 循环依赖 | **3 处**：`pi/providers ↔ pi/compatibility`、`external-agents/runtime ↔ external-agents/history-scopes` | 强连通分量检测 |
| 反向依赖（client→server） | **0**（脚本强制失败） | `scripts/check-boundaries.ts:37-48` |
| 反向依赖（shared→两端） | **0**（脚本强制失败） | `scripts/check-boundaries.ts:57-69` |
| shared 被引用面 | 服务端 52 文件 / 客户端 124 文件 | import 图统计 |
| 包间越界 | **0**（helper/carrier 均禁 import `src/`；carrier 还禁命名具体应用） | `scripts/check-boundaries.ts:67-97` |
| 前端 `apps/*` 互引 | 极少：仅 `NotConnected`(6 处)、`files/DirectoryPicker`(5 处跨用)；反向存在 `apps` 被 `agents`/`machines` 引用 | 客户端 import 图 |

**架构边界脚本 `scripts/check-boundaries.ts` 强制的 6 类规则（这是该项目最值得称道的工程机制）：**

1. 生产入口 `src/client/app/ProductionApp.tsx` 必须存在，并沿**运行时**边（`type` 边不计入）做可达性分析；禁止可达 `fixtures/`、`experience/mock|scenarios`、`/dev/`（`check-boundaries.ts:14-20`；`scripts/maintenance/imports.ts:64-78,87-89`）。
2. `client` 禁 import `server`；非 `src/client/app/` 的功能禁直连 live 组合；`shared` 禁 import 任一端（`check-boundaries.ts:37-49`）。
3. `client` 内禁用 `any` 关键字；`src/server/agent-runtime.ts` 与 `src/server/pi/` 禁止经 `.db`/`.store` 穿透持久化（`check-boundaries.ts:52-64`）。
4. `host-helper` + `helper-protocol` 禁 import `src/`；`helper-protocol` 另禁 import `host-helper`（`check-boundaries.ts:67-78`）。
5. `web-carrier` + `carrier-protocol` 禁 import `src/`、`host-helper`、`helper-protocol`，且文本禁出现 `deepseek|dsh|codex|kimi|jupyter|tensorboard|vite`（`check-boundaries.ts:80-97`）。
6. `src/` 内路径不得以里程碑编号命名（正则 `/(?:^|\/)[mM]\d+(?:[A-Z]|[-./])/`）（`check-boundaries.ts:31-33`）。

耦合评估结论：**跨层耦合被脚本化压到很低**，残余耦合集中于两点——(a) `app.ts` 作为 621 行组合根，用闭包 `runtimeFor()` 做服务定位（`app.ts:164-198`），新增运行时需改这里；(b) `agent-store.ts`(2,869 行) 与 `file-service.ts`(2,205 行) 呈"上帝对象"倾向。

### 3.5 关键调用链路（静态追踪）

**链路 A — 浏览器配对与鉴权**
`POST /api/v1/pairing` → `access.createPairing()` 限流（5 次/分）→ 生成 8 位 CSPRNG 码 + 32 字节凭据，仅存 sha256 摘要（`access.ts:768-783`）→ 已授权浏览器 `POST /pairing/:id/approve`（幂等 `requestId`）→ 请求方 `POST /pairing/current/claim` 签发持久 grant 与 Cookie（`access.ts:898-921`）→ 之后每个 API 请求先过 `boundary()`（精确 Origin/Host + 变更头 `X-Citadel-Request: 1`），再过 `auth()`（优先级 loopback > paired > whitelist）（`app.ts:341-370`、`access.ts:375-417`）。

**链路 B — 主对话 agent 执行（Pi）**
`app.ts:151` 创建 `agent-service` → `agent-runtime.ts:134` 从 `m2_dispatch_intents` drain 取下一个 dispatch → `sessions.ts:399` 取 `OwnedPiProcess` → `pi/process.ts:84` spawn supervisor → `pi/supervisor.ts:78` spawn Pi 实例 → `agent-runtime.ts:426` 下发 prompt，流式事件经 `live.ts` 推给浏览器。调度约束：**同一 agent 单活 run**（`agent-runtime.ts:71`）。

**链路 C — 远端文件传输（SFTP）**
`resource-runtime.ts:406` → `transfers.ts:319,333`（并发上限 2）→ `machine-runtime.ts:538` 取连接租约 → `file-providers.ts:804` SFTP → `transfers.ts:1790` 发布/取消。安全语义：独占临时兄弟文件 + 不覆盖发布，失败保留已完成项（`README.md:86`）。

**链路 D — 终端 PTY**
`app.ts:572` 注册终端 WS → `terminal.ts:28-30` 升级 → `terminal-service.ts:347` attach → `machines/local-terminal.ts:134` `spawnPty`；背压处理为"拥塞即断开"而非无限缓冲（`terminal.ts:66`）。

**链路 E — 外部 agent（跨机）**
主服务 `helper-client.ts:111-123` 本地 `spawn(process.execPath, [host-helper/dist/main.js, ...])`；远端经 SSH 送出 bootstrap 程序 → 校验 → 写 `~/.citadel_managed` → detached 启动 → 主服务经 **Unix domain socket 上的 JSON-lines** 通信（8 MiB 帧上限、≤16 in-flight，`packages/host-helper/src/main.ts:19-30,123-130`）。helper 再拉起原生 agent（Codex App Server 走 `--stdio` JSON-RPC，`packages/host-helper/src/codex.ts:317`）。

### 3.6 进程与运行时拓扑

```
              ┌──────────────────────── 浏览器（Chromium/Safari/Firefox）──────┐
              │  SPA (dist/client)  ←HTTP/WS→  同一 origin                     │
              └───────────────────────────────┬────────────────────────────────┘
                                              │ HTTP + WebSocket /api/v1/*
                                    ┌─────────▼──────────────────────────────┐
                                    │ 主服务 node dist/server/index.js        │
                                    │ Fastify + better-sqlite3（单写者）      │
                                    └──┬────┬────┬──────────┬─────────────────┘
                    Unix socket JSONL  │    │    │ Node IPC │ spawn
                    ┌──────────────────▼┐  │    │  ┌───────▼──────────┐
                    │ host-helper（本地）│  │    │  │ web-carrier(s)   │
                    │ 单实例锁/socket    │  │    │  └──────────────────┘
                    └────────┬──────────┘  │    │
                             │ spawn       │    │ spawn
                    ┌────────▼─────────┐   │    │ ┌──────────────────────┐
                    │ Codex / Kimi /   │   │    │ │ Pi supervisor → Pi   │
                    │ ACP harness      │   │    │ │ 子进程               │
                    └──────────────────┘   │    │ └──────────────────────┘
                                           │    │
                          SSH (pinned key) │    │ node-pty
                    ┌──────────────────────▼┐   │ ┌──────────────────────┐
                    │ 远端主机 host-helper  │   │ │ 本地 tmux / PTY      │
                    │ + 原生 agent 进程     │   │ └──────────────────────┘
                    └───────────────────────┘   │
                                    ┌───────────▼──────────┐
                                    │ SSH 连接池（跳板/SFTP）│
                                    └──────────────────────┘
```

单实例保证：`proper-lockfile` 锁 `dataDir/service.lock`，stale 10s，12×1s 重试（`src/server/lease.ts:6-12`），并在 `index.ts:9` 启动前获取。**主服务不是单进程**：至少 5 类子进程参与（Pi supervisor/Pi 实例、本地 host-helper、web-carrier、远端 helper）。

### 3.7 契约层设计（架构上的关键决策）

| 决策 | 内容 | 证据 |
| --- | --- | --- |
| 双端同源 schema | 同一 zod schema 既做服务端输入校验，又做客户端响应校验；客户端域类型由 `z.infer` 派生 | `README.md:148`、`src/shared/service.ts:65`（`accessDescriptorSchema` 在 `app.ts:431` 输出、客户端解析）、`src/shared/transfers.ts:104` |
| 版本三元组 | `API_VERSION`、`DOMAIN_VERSION`、`schemaVersion`(DB) 独立演进 | `src/shared/contracts.ts`、`src/shared/service.ts`、`src/server/app.ts:291-301` |
| 幂等与不确定语义 | 所有变更带 UUID `requestId`；重复同参返同结果、不同参拒绝；结果可为 `applied|rejected|uncertain`，不确定态**不自动重放** | `src/shared/service.ts:134-153`、`README.md:169`、`packages/helper-protocol/src/index.ts:437-442` |
| 协议版本策略 | host-helper 用整型 `protocol` + `helperVersion` 双字面量；历史快照保留 0.5.0–0.14.0 与 protocol 1–4 的 union，`LEGACY_HELPER_PROTOCOL=2` | `packages/helper-protocol/src/index.ts:8-20,350-366` |
| 事件溯源式实时投影 | 快照 + 有序事件批次 + cursor + `storeIdentity`/`serviceInstance` 双重标识，防"旧店新实例"错配 | `src/shared/live.ts`、`README.md:152`、`src/server/app.ts:302-329` |

---

## 4. 工程实践评估

> 本节为评估者判断，非项目自评；每条判断后附支撑证据。评分 1–5，5 为最佳。

### 4.1 可维护性 — 4.5/5

**优势（有硬证据）：**
- **文档纪律罕见地严格**：`AGENTS.md` 要求"每条规则/契约/状态事实有唯一权威归属"（`AGENTS.md:7-9`），并把完成计划移入 `design/dev-history/`（68 篇），保持默认阅读路径小。`design/README.md` 是分层索引，区分"既定方向 / 工作解释 / 开放问题"（`design/README.md:25`）。
- **类型严格度到位**：`strict` + `noUncheckedIndexedAccess`（`tsconfig.json:7-8`）；`src` 内 `as any` 为 **0** 处（`as any` 25 处全在 `tests/`），`@ts-expect-error`/`@ts-ignore` 为 0。
- **架构边界自动化**：`check-boundaries.ts` 用 TypeScript 编译器 API 做真实 import 图与 AST 校验，而非文本匹配（`scripts/check-boundaries.ts:53-64` 走 AST 查 `AnyKeyword` 与 `.db/.store` 穿透）。
- **TODO 债务极低**：`rg -i '\b(TODO|FIXME|HACK|XXX)\b' src packages tests scripts` 的真实命中为 **0**（唯一命中是文件名正则 `src/client/files/text.ts:119`）。这说明团队用设计文档而非代码注释承载待办。

**减分项：**
- **27 个源文件超过 1,000 行**，前五：`agent-store.ts`(2,869)、`file-service.ts`(2,205)、`machine-runtime.ts`(2,075)、`transfers.ts`(2,012)、`client/apps/files/ResourceFiles.tsx`(2,086)。`ResourceFiles.tsx` 自持 44 个 hooks 并直接编排 fetch，属于表现层与传输层混层（`src/client/apps/files/ResourceFiles.tsx:40`）。
- **双 TypeScript 版本并存**（`^7.0.2` 与别名 `typescript-api@^6.0.3`），未在仓库内记录选择理由；升级时需同步维护两个版本面向。
- **里程碑词汇残留于标识符**：组合根变量名 `m1`/`m2`/`m3`（`src/server/app.ts:136-158`）、事件与表前缀（`store.ts:59-274`）。`design/domain-organization.md:9` 将其解释为"兼容词表"，但源码可读性确实受损。

### 4.2 可扩展性 — 4/5

**优势：**
- 外部 agent 接入走统一适配器：`SessionAdapter`/`SessionHooks` 隔离各 harness（`packages/host-helper/src/adapter.ts:23-85`），新增 harness 只需实现适配器 + 在 `applications.ts` 加目录条目（`packages/helper-protocol/src/applications.ts:55-116`）。
- 前端按 feature 切片：21 处 `createContext` / 20 个 Provider，控制器通过窄端口注入，可替换实现而无需改动视图（`src/client/machines/ports.ts:82`）。
- 文件 provider 可插拔（Local / SFTP 双实现，`file-providers.ts:471,804`）。

**限制：**
- **组合根单点**：`createApp()` 621 行以闭包服务定位器 `runtimeFor(id)` 管理"本地 + N 台远端"运行时映射（`app.ts:159-198`）；新增运行时类别或调整初始化顺序必须改此文件，且失败回滚路径是手写的嵌套 try/catch（`app.ts:139-257`）。
- **单写者 SQLite**：better-sqlite3 同步驱动 + 单进程写入者，横向扩展只能靠"多实例 + 各自数据目录"，而 `lease.ts` 明确为单实例互斥设计。这是有意的架构取舍，但构成规模上限。
- **无 schema 版本化迁移工具**：手写 20 版迁移数组（`store.ts:25-412`），缺少回滚路径与迁移测试的独立入口（`tests/migrations.test.ts` 存在，但回滚仍不可行）。

### 4.3 配置管理 — 4.5/5

**优势：**
- 环境变量全部经 zod 校验并给出显式错误（`config.ts:133-196`），非法值 fail-fast 而非静默降级。
- **来源优先级被显式建模**：`ConfigOverrides` 区分"进程显式覆盖"与"可从库中恢复的期望值"（`config.ts:56-83`），避免"启动参数悄悄改写已保存监听设置"这类常见错误。
- **私有信息零入库**：`.gitignore` 排除 `config/hosts.json`、`.citadel/`、`.env`（`.gitignore:1-10`）；示例配置为虚构值；`AGENTS.md:47-49` 明文规定真实地址/凭据/设备标识不得进版本库。
- **一次性遗留导入是事务性的**，且导入后数据库为权威（`README.md:136`、`config.ts:139-141`）。

**减分项：**
- **环境变量语义双轨**：7 个生产变量之外，仓库内出现 60+ 个 `CITADEL_*` 名称，绝大多数是测试/验证脚本的内部标记（如 `CITADEL_TEST_SSH`、`CITADEL_BROWSER_PORT`、`CITADEL_RPC_<uuid>`）。虽然代码中通过注释与位置区分，但缺少一份"生产 vs 测试"的权威清单，存在误用于生产的风险。生产清单目前只能从 `config.ts` 反推。
- **无 `.nvmrc`/`.node-version`**：Node 版本约束只在 `engines`（`package.json:6-8`），而 `npm` 对 `engines` 默认只告警；文档要求 24.22.1+（`README.md:11`），但本地开发容易用错版本。

### 4.4 安全性 — 4/5

**已确认的强化措施（证据充分）：**

| 维度 | 措施 | 证据 |
| --- | --- | --- |
| 认证模型 | 配对 + 持久 grant；服务端只存 sha256 摘要，可吊销；共享 token 路径被硬性移除（非空即启动失败） | `access.ts:778-783`、`config.ts:159-162`、`app.ts:396-402` |
| 凭据熵 | 32 字节 CSPRNG 凭据（base64url）；8 位配对码（≈26.6 bit）+ 10 分钟 TTL | `access.ts:713,778,915` |
| 暴力破解 | 创建 5 次/分、查询 20 次/分、待批准上限 500；20 次/分下猜中 1e8 空间不现实 | `access.ts:53-56,768,837` |
| Cookie | `HttpOnly` + `SameSite=Strict` + `path=/api`，`secure` 仅 https 下置位 | `access.ts:444-452` |
| CSRF | 精确 Origin + Host 白名单 + 变更请求必须带 `X-Citadel-Request: 1`；`trustProxy: false` 使 XFF 无法伪造 | `access.ts:335-352`、`app.ts:284` |
| SSH 主机密钥 | 指纹格式强校验 `^SHA256:[A-Za-z0-9+/]{43}$`，连接时全等比较，失配拒绝 | `config.ts:19`、`remote.ts:45-46`、`machine-runtime.ts:483-491` |
| 路径穿越 | 强制绝对 POSIX 路径；递归删除逐层 `realpath` + `isWithin`；发布用独占临时文件，不覆盖 | `file-providers.ts:162,1080-1150` |
| 命令注入 | 统一 POSIX `quote()`；真实 shell 执行仅 3 处且受策略/审批约束 | `shell-quote.ts:2-5`、`local-tools.ts:508,143-146` |
| 落盘权限 | 数据目录 `0o700`；私有值 `0o600` + `wx` + fsync；helper socket 目录 `0o700` 且校验 uid、拒符号链接 | `app.ts:121`、`private-values.ts:34-72`、`helper-client.ts:43-49` |
| Agent 权限 | 六套预设 + 自定义编辑器 + 目录边界 + 通用 shell 例外明示；每次操作可要求确认 | `src/server/agents/permissions.ts`、`design/agent-permissions.md` |

**已确认的缺口：**
- **主 HTTP 面缺少安全响应头**：全仓仅两处设置 `Content-Security-Policy`，且都是局部的 `default-src 'none'`（图片响应 `appearance/pictures.ts:246-247`、下载响应 `file-service.ts:2156,2189`）。主 SPA 与 API 无 CSP、无 HSTS、无 `X-Frame-Options`/`frame-ancestors`。
- **明文 HTTP 是既定现状**：README 自述"TLS、服务安装、反代信任仍属独立部署工作"（`README.md:68`）。这意味着凭据与配对码在网络上以明文传输，仅适用于可信内网。
- **loopback 即全权**：回环访问免配对且优先级最高（`access.ts:377-383`）。在单用户机器上是合理取舍，在多用户主机上等于"本机任意进程 = 管理员"。
- **`privateKeyPath` 读取未校验权限**（`remote.ts:24`），与导入密钥路径的 `0o600` 校验不一致。
- **供应链审计缺失**：无 `npm audit`、无 Dependabot、无 secret scanning、Actions 用浮动 `@v4` 而非 SHA 固定（`.github/workflows/foundations.yml:21-22`）。

> 综合判断：**认证与数据边界的设计质量高于同类个人项目**（摘要化凭据、精确 Origin/Host、幂等回执、不可信输出不自动重放）。安全短板集中在"传输层与响应头"这一部署面，而非应用逻辑面。

### 4.5 错误处理 — 4/5

| 方面 | 现状 | 证据 |
| --- | --- | --- |
| 统一 HTTP 错误映射 | 全局 `setErrorHandler`：`ZodError`→400 `validation-failed`；`AccessError`→自带状态码与 outcome；其余按 `statusCode` 归一，≥500 记为 `service-unavailable` | `app.ts:371-390` |
| 错误词表 | `outcomeSchema` 13 个受控取值，避免自由文本错误码 | `src/shared/service.ts:134-153` |
| 自定义错误类 | 27 个独立错误类，**无公共基类**（除 `AccessError`） | 全仓 `class .*Error extends Error` 统计 |
| 不确定态处理 | 显式 `uncertain` 结果，要求人工检查而非自动重试；"丢失响应可重试同一 requestId" | `README.md:169`、`packages/helper-protocol/src/index.ts:437-442` |
| 前端错误 | **无 `ErrorBoundary`**（`grep` 零命中）；改用连接状态机 + `mutationError` + 显式 Retry；不自动重放 | `src/client/sync/intents.ts:2`、`src/client/experience/live.ts:101` |
| 启动失败回滚 | 嵌套 try/catch 逐层释放已创建资源（`store.close()`、`m1.close()`、`m2.close()`） | `app.ts:139-257` |

风险：无 `ErrorBoundary` 意味着渲染期异常会整树卸载；该项目以"显式状态 + 不重放"策略规避，但对第三方 Markdown/复杂组件的异常防护偏弱。27 个无共同基类的错误类型也给集中处理带来成本。

### 4.6 日志与可观测性 — 2/5（最弱维度）

| 方面 | 现状 | 证据 |
| --- | --- | --- |
| 日志 | 仅生产入口传 `logger: true`（Fastify 默认 pino JSON）；`createApp` 默认 `logger: false` | `index.ts:12`、`app.ts:282` |
| 日志加工 | 无自定义 `serializers`、无 `redact` 脱敏配置 | `app.ts:281-285` |
| 健康检查 | `GET /api/v1/health` 返回版本/平台/启动时间/uptime/ready/schemaVersion | `app.ts:456`、`app.ts:291-301` |
| 健康检查可达性 | 该路径**不在**公开路径白名单，未授权探针无法访问 | `app.ts:91-98` |
| 诊断 | 内存 diagnostics 环（≤200 条 / 256 KiB，重启清空，仅开发检视面） | `design/implementation-status.md`、`src/server/diagnostics.ts` |
| metrics | **无**（无 prom-client / OpenTelemetry 依赖） | `package.json:59-105` 全量依赖检索 |
| tracing | **无** | 同上 |
| 审计日志 | 无独立审计通道；变更以域事件形式进 SQLite `events` 表 | `store.ts:32` |

评估：这一维度与其余维度的工程质量**明显不匹配**。对于一个长期驻留、管理多台远端主机与多个 agent 进程的常驻服务，缺少指标（内存/连接数/队列深度/传输速率）、结构化字段与脱敏规则，会使生产故障定位高度依赖人工复现。`/health` 需要鉴权虽有安全考虑，但也排除了外部探活。

### 4.7 测试与质量保障 — 4.5/5

| 指标 | 数值 | 评价 |
| --- | --- | --- |
| 测试/实现行数比 | 53,398 : 123,775 = **0.43** | 显著高于一般项目（0.1–0.3） |
| Vitest 用例文件 | 100（根 77 + client 23） | 以集成/契约测试为主：21 个文件用 `createApp`、18 个用 `.inject` |
| Playwright spec | 64 个文件 / 384 处 `test(` / 2,101 处 `expect(` | 全部走真实服务（`webServer: tsx scripts/browser-server.ts`） |
| 可访问性 | 30 个 spec、61 处 axe 断言（只拦 serious/critical） | 覆盖 15 条路由的 wcag2a/2aa |
| 测试替身 | 4 个假外部 agent peer（`tests/fixtures/*.mjs` ：fake-dsh / fake-native / m3-acp-peer / m3-codex-peer） | 用确定性 fake 隔离外部进程，符合"不把模拟当真实自主性"的自我约束（`AGENTS.md:43`） |
| 真实依赖集成 | 真实 ssh2 端点、真实 sshd、ed25519 fixture key | `tests/helpers/ssh-endpoint.ts:11`、`tests/helpers/openssh.ts:22` |
| 快照测试 | **0**（无 `toMatchSnapshot`/`toHaveScreenshot`） | 刻意选择：`test:browser:update` 脚本存在但已无对应基线（死脚本） |
| 静默跳过 | 18 处 `skipIf`（SSH/tmux/zsh 缺失时跳过） | 风险：本地"全绿"可能不含关键覆盖 |

**这是全项目最强的维度**：测试不是覆盖率填充，而是按"契约 / 不确定性 / 权限 / 恢复"语义组织（如 `m3-approval-safety`、`m2-persistence-ownership`、`agent-permissions-runtime`、`helper-force-recovery`）。`check:maintenance` 把格式、React hook lint、架构边界合成单一门禁（`package.json:36`）。

**短板：** 无覆盖率度量与门槛；无 macOS runner；`tests/browser` 368 个用例以 `toBeVisible` 为主的可见性断言，对布局回归的敏感度低于图像基线。

### 4.8 综合评分

| 维度 | 评分 | 主要依据 |
| --- | --- | --- |
| 可维护性 | 4.5 | 文档纪律 + 边界脚本 + 严格类型；扣分于巨型文件与双 TS 版本 |
| 可扩展性 | 4.0 | 适配器/端口化良好；扣分于组合根单点与单写者 SQLite |
| 配置管理 | 4.5 | zod 校验 + 来源优先级显式建模；扣分于测试变量与生产变量缺少权威清单 |
| 安全性 | 4.0 | 认证/边界/路径/权限设计扎实；扣分于无 CSP/HSTS、明文 HTTP、供应链审计缺失 |
| 错误处理 | 4.0 | 统一映射 + 不确定态语义；扣分于无 ErrorBoundary、27 个无基类错误 |
| 日志与可观测性 | **2.0** | 仅布尔 logger，无脱敏/metrics/tracing，health 需鉴权 |
| 测试与质量 | 4.5 | 0.43 测试比 + 分层语义化测试；扣分于无覆盖率、无 macOS CI |
| **加权综合** | **3.9 / 5** | 代码与工程机制优秀，**运维可观测性与交付流水线覆盖**是两块明显凹地 |

---

## 5. 问题与建议（按优先级）

> 排序依据：先"会阻断生产可用性/安全边界"，再"会持续放大维护成本"，最后"局部质量与技术债"。

### P0 — 生产可用性/安全边界必须先决策（2 项）

| # | 问题 | 证据 | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| P0-1 | **传输层无 TLS，主应用面无任何安全响应头** | `README.md:68`（自述未完成）；仅局部 CSP：`appearance/pictures.ts:247`、`file-service.ts:2156,2189` | 明文 HTTP 下配对码/Cookie 可被同网段窃听；无 CSP/XFO 使 XSS 面与点击劫持面无浏览器侧防线 | ①短期：在反向代理终止 TLS 并在代理层注入 `Content-Security-Policy`（`default-src 'self'`）、`Strict-Transport-Security`、`X-Frame-Options: DENY`；②中期：Fastify `onSend` 钩子统一注入安全头（注意与 `@fastify/static` 的兼容）；③长期：内置 TLS 或以 loopback-only + 反代为唯一网络入口，并在 README 明确"禁止直接暴露在不可信网络" |
| P0-2 | **可观测性缺失导致生产故障不可定位** | 无 metrics/tracing 依赖（`package.json:59-105`）；`logger` 仅布尔（`app.ts:282`）；`/health` 受鉴权（`app.ts:91-98`） | 常驻服务管理多台远端主机与多个 agent 子进程，异常时无法判断是队列堆积、SSH 池耗尽还是子进程僵死；`/health` 需鉴权使外部探活与容器/进程守护无法使用 | ①Pino 配 `redact`（cookie/authorization/token）+ 固定字段（`requestId`、`actor`、`machineId`、`outcome`）；②增加 `/metrics`（prom-client）或至少结构化"运维快照"端点，含：活跃 WS 数、SSH 连接池占用、`m2_dispatch_intents` 深度、传输队列长度、子进程存活；③把 `/health` 拆成两个：公开的 liveness（仅 200/503）+ 受鉴权的 readiness 详情 |

### P1 — 持续性成本与合规缺口（5 项）

| # | 问题 | 证据 | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| P1-1 | **Lint 覆盖仅约 39%**：`eslint src/client` 只检查前端，且只有 3 条规则、无 `typescript-eslint` | `eslint.config.js:5-31`、`package.json:34`；未 lint 行数约 115,506（server+shared+packages+tests+scripts） | 服务端与协议包缺少静态规则兜底，依赖评审与类型系统单独承担；`no-floating-promises`、`no-misused-promises` 等异步陷阱无检查 | 引入 `typescript-eslint` 的 type-aware 配置，优先对 `src/server`、`packages/*` 开启 `no-floating-promises`/`no-misused-promises`/`require-await`；分两阶段：先 `warn` 采集基线与存量，再 `--max-warnings 0` |
| P1-2 | **CI 只有 Linux 单 job，但产品明确承诺 macOS 支持** | `.github/workflows/foundations.yml:16-34`（仅 `ubuntu-latest`）；`AGENTS.md:33-35` 要求支持 macOS 且"Linux 测试不证明远程 Mac 支持" | macOS 路径（zsh 交互式 shell 发现、`ps`/boot_id 进程身份、`cc` 编译）长期无自动回归，与文档承诺不一致 | 增加 `macos-latest` job，至少跑 `typecheck` + `build` + `build-native`（验证 `cc` 路径）+ 非 SSH 的单元/契约测试；把"需要真实 macOS 主机"的项继续标为人工门禁 |
| P1-3 | **供应链与安全性审计全缺** | 无 Dependabot/CodeQL/secret scanning；无 `npm audit` 步骤；Actions 用浮动 `@v4`（`foundations.yml:21-22`） | 依赖漏洞、误提交凭据、易受攻击的 Action 版本均无自动发现机制 | ①GitHub 原生开启 Dependabot + secret scanning + CodeQL（零成本）；②CI 增加 `npm audit --omit=dev --audit-level=high`（或 `osv-scanner`）；③Actions 钉 SHA |
| P1-4 | **零覆盖率度量与门槛** | `vitest.config.ts:3` 无 `coverage` 配置；无 c8/istanbul 依赖 | 无法回答"哪些模块无覆盖"，也无法在重构时阻止覆盖率下降；测试量大但分布未知 | 开启 `@vitest/coverage-v8`，先只上报（`lcov` + PR 注释），稳定 2–4 周后对"新增代码行"设门槛（如 70%），不对全仓设硬门槛以免阻塞 |
| P1-5 | **单写者 SQLite + 单实例锁构成规模硬上限（架构取舍，需显式记录）** | `lease.ts:6-12` 单实例互斥；`store.ts:573` 单 `Database` 句柄；WAL（`store.ts:614`） | 无法横向扩展；大库迁移期需停机；`VACUUM INTO` 备份在库增大后耗时线性增长 | 不必改架构，但应：①在 README/设计文档把"单实例、单写者"写成**显式非目标**与容量上限；②为 `store.ts` 增加慢查询与库体量观测；③评估把审计/历史类只读表拆到独立库或冷存储的可行性 |

### P2 — 局部质量与技术债（10 项）

| # | 问题 | 证据 | 建议 |
| --- | --- | --- | --- |
| P2-1 | **27 个源文件 >1,000 行**，前五为 `agent-store.ts`(2,869)、`file-service.ts`(2,205)、`machine-runtime.ts`(2,075)、`transfers.ts`(2,012)、`ResourceFiles.tsx`(2,086) | `wc -l` 统计（`src`+`packages`，TS/TSX） | 按用例/聚合根拆分：`agent-store` 按"会话 / 回执 / 凭据投影"三段抽出；`ResourceFiles` 抽出传输编排为 controller，保留纯渲染 |
| P2-2 | **包版本与协议版本漂移**：`helper-protocol/package.json` = `0.12.0`，wire 身份 = `HELPER_VERSION 0.15.0` / `HELPER_PROTOCOL 5` | `packages/helper-protocol/package.json:3` vs `src/index.ts:8,11`；服务端只按协议号+helperVersion 判 legacy（`src/server/external-agents/runtime.ts:107`） | 单一版本来源：由构建脚本从 `HELPER_VERSION` 注入 `package.json`，或在 CI 加断言 `package.version === HELPER_VERSION` |
| P2-3 | **双 TypeScript 版本共存**（`^7.0.2` 与别名 `typescript-api@^6.0.3`） | `package.json:100-101`；`scripts/check-boundaries.ts:1` | 在 `scripts/maintenance/` 加一段注释说明锁 6.x 的原因（Compiler API 兼容性）；规划升级到单一版本 |
| P2-4 | **重复实现**：`quote()` 两份、`createHash("sha256")` 散落多个文件、`src/shared/contracts.ts` 仅 2 行兼容 re-export | `src/server/shell-quote.ts:2` 与 `src/server/machine-runtime.ts:63` 各定义一份 `quote()`；`contracts.ts` 兼容层 | 统一收敛到 `src/server/shell-quote.ts` 单一实现；哈希统一到 `src/server/digest.ts`；为兼容 re-export 标注移除条件 |
| P2-5 | **死脚本**：`test:browser:update` 存在但无任何快照/图像基线 | `package.json:17`；快照 API 计数为 0 | 删除脚本，或引入少量关键界面的图像基线（注意 `playwright.config.ts` 当前 `screenshot: off` 是出于隐私考虑，基线须用脱敏数据） |
| P2-6 | **18 处 `skipIf` 造成"本地全绿但关键覆盖缺失"** | `tests/` 中 `skipIf` 统计；CI 已安装 `openssh-server`/`tmux`（`foundations.yml:23-26`） | 在 CI 中显式断言"关键 skip 数为 0"（如 SSH/tmux 相关测试不得跳过）；本地跳过时输出显著警告 |
| P2-7 | **废弃机制残留**：`CITADEL_ACCESS_TOKEN` 硬拒、`Config.token?` 字段、`POST /api/v1/auth` 只返 410、`readLegacyHosts` 遗留导入 | `config.ts:70,139-162`、`app.ts:396-402` | 设定移除窗口：`Config.token?` 标注 `@deprecated` 并在下一里程碑删除；legacy hosts 导入给出明确终止版本 |
| P2-8 | **前端 14,469 行 fixtures/dev 与生产同目录**（fixtures 7,991 + dev 6,478） | `src/client/fixtures`、`src/client/dev`；`check-boundaries.ts:14-20` 已强制生产图不可达 | 现状可接受（有脚本兜底），但建议在 `vite build` 中加 `import.meta.env.PROD` 断言或产物扫描，确认 fixtures 未被打进 `dist/client` |
| P2-9 | **服务端非空断言 102 处** | `src/server` 中 `!` 断言统计（`pi/providers.ts` 30、`local-tools.ts` 20） | 在关键路径上用窄类型守卫替代 `!`，优先处理 `pi/*` 与 `agents/local-tools` |
| P2-10 | **前端无 `ErrorBoundary`** | 全仓 grep 零命中 | 在 `app/App` 与各窗口容器各加一层边界，异常时展示可恢复 UI 而非整树崩溃 |

### 5.1 建议实施顺序（按依赖关系）

```
第 1 批（1–2 周，低风险高收益）
  P1-3 供应链安全（开启 GitHub 原生功能 + 钉 SHA）→ 零代码改动
  P2-5 删死脚本 / P2-6 CI skip 断言
  开启 P1-4 覆盖率上报（仅观测）
  P0-2 日志脱敏 + 运维快照端点（先做 redact 与字段，metrics 次之）

第 2 批（2–4 周，需评审）
  P0-1 安全响应头（Fastify onSend 统一注入）+ 反代 TLS 部署文档
  P1-2 macOS CI job
  P1-1 typescript-eslint 分阶段接入（先 warn）

第 3 批（持续重构，随功能推进）
  P2-1 巨型文件拆分（每次触及某文件时顺手抽一层）
  P2-2/P2-3/P2-4 版本与重复实现收敛
  P2-7 废弃机制移除窗口
```

---

## 6. 未识别与待确认清单

> 严格区分"仓库内确实没有"与"静态分析无法确定"。

### 6.1 未识别（已检索确认不存在）

| 项 | 检索口径 |
| --- | --- |
| 容器化 / 编排 / 服务安装文件 | 全仓 `find`（排除 `node_modules`）匹配 `Dockerfile*`、`docker-compose*`、`*.yaml|yml`、`*.service`、`*.plist`、`Procfile`、`*.nix` → 仅命中 `.github/workflows/foundations.yml` |
| 开源许可证（项目级） | 根目录无 `LICENSE`；`package.json` 无 `license` 字段；仅第三方图标资产带 `DSH-LICENSE`/`KIMI-LICENSE` |
| 覆盖率工具与配置 | `package.json` 依赖清单 + `vitest.config.ts` + 全仓 `coverage` 检索 |
| typescript-eslint | `devDependencies` 检索 |
| metrics / tracing 实现 | `package.json` 依赖 + 全仓 `prom-client|opentelemetry|otel` 检索（零命中） |
| 依赖漏洞/密钥扫描配置 | `.github/` 仅 1 个 workflow；无 `.github/dependabot.yml`、无 CodeQL workflow |
| Node 版本管理文件 | 无 `.nvmrc` / `.node-version` |
| 生产安全响应头 | 全仓 `Content-Security-Policy|X-Frame-Options|Strict-Transport-Security|helmet` 检索；仅 2 处局部 CSP |

### 6.2 待确认（有线索但静态分析不足）

| 项 | 为何待确认 | 需要补充的验证 |
| --- | --- | --- |
| 依赖的实际解析版本与 CVE 状态 | 只有 semver 声明，`node_modules` 未提供 | `npm ci` 后执行 `npm ls --depth=0` 与 `npm audit` |
| 覆盖率数值 | 无覆盖率工具 | 接入 `@vitest/coverage-v8` 跑一次 |
| 真实运行时的并发竞态与性能 | 静态分析不覆盖运行时 | 压测：多浏览器 WS、并发传输、agent 单活队列、SSH 池耗尽场景 |
| `helper-protocol` 版本漂移是否有意 | 无发布记录、无 `git` 历史 | 询问维护者，或查上游发布流程 |
| `web-carrier` 的服务端入口完整配线 | 未定位到 `CARRIER_ENTRY_PATH` 的完整装配链 | 精读 `src/server/own-interfaces/carrier-process.ts` 与 `compose.ts` |
| esbuild 产物是否真正内联 zod 等依赖 | 未执行构建 | `npm run build` 后检查 `packages/host-helper/dist/main.js` 是否含 `node_modules` 外引用 |
| macOS 实际行为（zsh 发现、boot_id、`cc` 编译） | 无 macOS CI、无真实 Mac 证据 | 在真实 macOS 主机执行 `npm run verify:native-mac` |
| 提交历史/分支策略/评审流程 | 快照无 `.git` | 获取带历史的全量克隆 |
| 部署目标的实际基础设施 | 仓库无 IaC、无部署文档细节 | 询问维护者的实际部署拓扑（是否反代、是否内网） |
| `dist/client` 产物结构与分包情况 | 产物未入库（`.gitignore:2`） | 构建后检查产物与 chunk 划分 |

---

## 附录 A — 关键证据文件索引

| 主题 | 文件 |
| --- | --- |
| 开发规则（权威） | `AGENTS.md` |
| 仓库级运行说明 | `README.md`（227 行） |
| 设计索引 / 当前验收状态 | `design/README.md`、`design/implementation-status.md` |
| 源码归属表 | `design/domain-organization.md`、`design/module-ownership.md` |
| 依赖与脚本清单 | `package.json`、`package-lock.json` |
| 服务端入口与组合根 | `src/server/index.ts`、`src/server/app.ts` |
| 配置与校验 | `src/server/config.ts` |
| 单实例锁 | `src/server/lease.ts` |
| 数据库与迁移 | `src/server/store.ts`（20 版迁移） |
| 鉴权与配对 | `src/server/access.ts` |
| 架构边界脚本 | `scripts/check-boundaries.ts`、`scripts/maintenance/imports.ts` |
| 构建脚本 | `scripts/build-helper.ts`、`scripts/build-carrier.ts`、`scripts/build-native.ts` |
| 协议契约 | `packages/helper-protocol/src/index.ts`、`packages/carrier-protocol/src/index.ts` |
| 宿主助手 | `packages/host-helper/src/{main,core,adapter,journal,ledger}.ts` |
| CI | `.github/workflows/foundations.yml` |
| 测试配置 | `vitest.config.ts`、`playwright.config.ts`、`eslint.config.js` |
| 设计令牌与样式 | `src/client/styles/tokens.css`（284 处自定义属性声明 / 81 个唯一变量名，全站 2,521 处 `var()` 引用）、`src/client/main.tsx` |

---

## 附录 B — 分析方法与置信度说明

**方法：** 4 个分析单元按职责切分（服务端/共享层、前端/构建、协议栈/部署、质量/安全），各自以 `grep/glob/read` 静态检索并回传带 `file:line` 的结构化结论；主分析师独立复核了以下高风险断言：Fastify 装配与错误处理（`app.ts` 全文阅读）、20 版迁移计数、`check-boundaries.ts` 全部 6 类规则、Cookie 属性与配对限流、`package.json` 脚本链、依赖与测试统计口径、许可证/容器化/安全头的"不存在"检索。

**置信度分级：**

| 结论类型 | 置信度 | 说明 |
| --- | --- | --- |
| 存在性（有/无某文件、某依赖、某配置） | 高 | 全仓检索，未见即判无 |
| 代码级结构（分层、调用链、边界规则） | 高 | 逐行阅读 + AST/import 图 |
| 统计数字（LOC、文件数、测试数） | 高 | 可复现命令给出 |
| 设计意图与取舍 | 中 | 来自文档自述；文档与代码不一致处已标注 |
| 运行时行为、性能、安全性可利用性 | 低/未评估 | 静态分析不覆盖，已列入 §6.2 |

**统计口径备注：** 行数统计以 `wc -l` 计；Playwright 用例数用 `grep -o 'test('` 计调用点（含 `test.skip`/`test.describe` 内部方法不计），与"368 个用例"的报告存在口径差异，本报告采用 384 处 `test(` 调用点与 64 个 spec 文件两个可复现数字。
