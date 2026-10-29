# 需求规格 v1.0 — DSH 服务器管理插件

| 项 | 内容 |
| --- | --- |
| 定位 | **DeepSeek Harness 插件**：管理远端服务器并暴露操作协议（工具）。不做独立 UI、不做多 agent 会话协同、不做项目内核 |
| 契约基线 | DSH `0.2.1-rc.2` 及以上（已在桌面端 `0.2.1-rc.3` 与 npm CLI `0.2.1-rc.2` 验证） |
| 形态 | 一个 bundle 包 `dsh-multiservers`：Host 半（Config + 工具 + 凭据）＋ Client 半（设置卡片，下一片） |
| 包管理器/语言 | TypeScript / Node ≥ 24 |

## 1. 目标与非目标

**目标**：让 DSH 的 agent 能像操作本地文件一样操作远端机器——连接测试、能力探测、执行命令、列目录、上传下载；服务器与凭据集中管理。

**非目标**（明确排除）：Web 工作台、窗口承载、carrier、项目内核、会话存储、跨 harness 协同、作业调度抽象（调度交给 agent 用 `run` 自行提交）。

## 2. 架构

```
DSH 进程
 └─ dsh-multiservers（Host 半，本切片）
     ├─ Config（Schemastery）：servers[] + 超时
     ├─ ctx.credentials：密码存 .credentials.yaml（与 provider API key 同一套）
     ├─ Settings 服务：server_add / server_remove 写回 profile patch
     └─ ctx.tools.register：12 个工具
```

**凭据**：密码不进配置文件，用 `ctx.credentials.set(credentialRef('MSS_<ID>_PASSWORD'))` 写入 DSH 凭据库；配置里只出现引用名。私钥认证时只记录本地 `keyPath`，不读入配置。

**主机密钥**：首次 `server_test` 可 `pin=true` 记录指纹；已 pin 时指纹不符直接拒绝连接（TOFU + 拒绝漂移）。

## 3. 工具面（当前 12 个）

| 组 | 工具 | 说明 |
| --- | --- | --- |
| server | `server_list` | 列出已配置服务器与凭据/指纹状态 |
| | `server_test` | 连接、认证、返回延迟与主机指纹；可 pin |
| | `server_probe` | 只读能力画像：OS、Slurm/PBS 客户端、tmux/rsync/python/conda/module/docker、存储 |
| | `server_add` | 注册服务器；密码写入凭据库；需 Settings 服务 |
| | `server_remove` | 移除配置；默认同时清除密码凭据 |
| exec | `run` | 经 `bash -lc` 执行，带超时与取消信号，返回 exit/stdout/stderr |
| fs | `ls` / `stat` / `mkdir` / `rm` | SFTP 列目录与元数据；删除需绝对路径，递归需 `confirm=true` |
| transfer | `upload` / `download` | SFTP 传单文件（大文件留在服务器上） |

## 4. 已完成的验证

| 验证 | 结果 |
| --- | --- |
| 工具级集成测试（`npm test`，真实主机） | **16/16 通过**：注册 12 工具、连接 3.7s、指纹匹配、Slurm/rsync 探测、login shell 执行、cwd、列目录 65 项、上传/下载往返一致、stat（44B）、删除 |
| 真实 DSH 加载 | `dsh --profile mss --dump-config` 出现 `# == dsh-multiservers` 层；`--dump-config-schema` 读出 `hostKey/connectTimeoutMs/passwordRef` |
| 网页端运行 | `dsh --profile mss --port 4400` 启动成功，无本插件报错，页面可达 |

## 5. 安装与测试

```bash
# 构建
npm run build

# 装进一个 profile（推荐新建，避免污染既有 profile）
dsh --profile mss --from-default-profile web --dump-config
dsh plugin --profile mss add <仓库路径>/packages/dsh-multiservers

# 启动网页端
dsh --profile mss --port 4400
```

## 6. 后续切片

1. **Client 半**：Settings → Plugins 里的「Servers」卡片，增删改 IP/端口/账户/密码（`settings.plugins.tab` 槽，lazy-CJS 产物，`exports['./client']` + `dsh.client`）
2. 凭据写入路径从「工具」扩展到「设置卡片」；密码字段使用 `role('secret')` + 凭据引用
3. 传输增强：rsync 优先、断点续传、sha256 校验
4. 后台长任务：`ctx.jobs.start` + `run_in_background`
5. 打包分发：`npm pack` / 发布，桌面端接入

## 7. 已知限制

- 每次工具调用新建 SSH 连接（无连接池）；延迟可接受，后续补池化
- `rm` 递归经远端 `rm -rf -- <quoted>`，仅有 `confirm=true` 一道门
- 设置卡片未实现，目前添加服务器需通过 `server_add` 工具
- 传输为 SFTP，无 rsync/续传
