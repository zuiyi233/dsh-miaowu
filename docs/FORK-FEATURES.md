# Fork 专有能力与边界

本文件说明 `dsh-miaowu` 相对上游 [`oh-story-dsh`](https://github.com/zenstory-ai/oh-story-dsh) 多出来的能力、各自落在哪一层，以及哪些限制是设计的一部分。当前源码对应 `@dsh-miaowu/dsh` 0.1.18；安装与版本说明见 [README](../README.md)。

上游负责四个创作工作台（小说、短剧、游戏、视频解说）以及随包的 Oh Story、Drama Skills、NovelToGame、video-recap-skills。本仓库保留这些内容，只在其上追加下列能力。

## 状态与所有权

- 检索、历史、任务、备份、伏笔、书架与保险库等 fork 状态默认写在当前工作区的 `.oh-story/` 目录下，按功能分为 `index/`、`history/`、`tasks/`、`backup/`、`vault/` 等子目录或 `shelf.json`、`foreshadows.json` 等单文件。没有 SQLite、没有 zip 依赖、没有第二套数据库。
- 不启动第二套 Agent 运行时、会话传输、Dashboard 或 SSE 服务。工作台 UI 只投影文件与插件状态；唯一的定期重列是下文约 4 秒的文件树刷新。
- DSH 仍然拥有会话持久化、模型与 Provider、Preset、权限与审批、workspace roots、runs 与 Session Log。除用户显式运行预设安装脚本外，本插件不写 `~/.dsh` 宿主状态；`喵呜小说工坊` 预设的写出目标只有 `~/.dsh/.agent-presets/dsh-miaowu/`（见下文）。
- `.oh-story/` 是否纳入你的版本控制由你决定；插件不会改写项目的 `.gitignore`。

## 能力一览

| 能力 | 形态 | 默认状态 | 状态位置 / 入口 |
| --- | --- | --- | --- |
| 全文检索（CJK + 拼音） | 小说 / 短剧工作台面板 | 随插件可用 | `.oh-story/index/`；`/oh-story/search` |
| 版本历史 / 回滚 / 审计 / 行级批注 | 小说 / 短剧编辑器面板 | 随插件可用 | `.oh-story/history/`、`audit.jsonl`、`annotations.json` |
| 候选暂存 | 小说 / 短剧面板 + `oh_story_task stage_candidate` | 随插件可用 | `.oh-story/tasks/candidates.json` |
| run / checkpoint / resume | 小说 / 短剧面板 + `oh_story_task checkpoint_run` | 随插件可用 | `.oh-story/tasks/runs.json` |
| 备份三件套 | 小说 / 短剧面板 + `/oh-story/backup/*` | 随插件可用 | `.oh-story/backup/` |
| 伏笔闭环 | 小说工作台面板 | 随插件可用 | `.oh-story/foreshadows.json`、`foreshadows-snooze.json` |
| 书架 | 小说 / 短剧工作台面板 | 随插件可用 | `.oh-story/shelf.json` |
| 可选凭据保险库 | HTTP 路由，无独立面板 | **默认关闭** | `.oh-story/vault/`；需 `DSH_MIAOWU_VAULT_ENABLED=1` |
| 自诊断 | 小说 / 短剧工作台「自诊断」面板 + `/oh-story/diagnostics` | 随插件可用 | 六组只读检查、支持包、显式修复；状态盘点见 `.oh-story/` |
| `worldbuilding` / `publishing` / `finalize` | 三个自有 Skills | 随插件可用 | 通过 Skills 目录发现，`/worldbuilding` 等入口 |
| ComfyUI 本地接入 | 短剧生产适配器 + `oh_story_comfyui` 工具 | 需外部配置 | 本机或局域网 ComfyUI 服务 + API-format 工作流 |
| 喵呜小说工坊 | DSH Agent 预设 | 需手动安装 | 源码 checkout 运行 `pnpm --filter @dsh-miaowu/dsh preset:install` |
| 文件树运行中自动刷新 | 工作台行为 | 随插件可用 | 会话运行期间约每 4 秒安静重列 |
| 布局持久化 | 工作台行为 | 随插件可用 | 浏览器存储：布局按会话、开合按工作区 |

## 自诊断与状态版本

- 工作台「自诊断」面板调用 `/oh-story/diagnostics`，按宿主、运行时、工作区、数据、凭据、集成六组给出通过 / 注意 / 失败 / 未知，并用 P0（完全不可用）、P1（核心能力受损）、P2（提示）分级。报告只读，不写会话、`workspace.json` 或 `~/.dsh`。
- 支持包必须显式确认后才导出，默认深度脱敏：只含版本、运行时、顶层结构、状态盘点和诊断结论，不含文件内容、密钥字节、会话载荷或绝对路径。宿主没有官方日志读取接口，因此 `logSummary.available` 为 `false`，不伪造日志摘要。
- 显式修复只有三类：重建检索索引、重新做全量备份、检查过期锁。锁清理在已安装的 DSH 文件系统接口没有删除能力时只报告、不代删；状态迁移另有独立的计划 / 应用 / 回滚接口，应用前先写备份。
- 启动预检只读插件与宿主清单：宿主版本未知、超出 `engines.dsh` 或 Node 低于 24 时发出明确告警，不阻断加载，也不静默降级。
- `.oh-story` 的可变 JSON 文档（书架、伏笔抑制、拆书 sidecar、批注等）写入 `schemaVersion: 1`；历史 / 审计 JSONL、任务顶层数组、检索索引、锁和备份快照保持原格式，按兼容规则读取，不参与 v1 自动迁移。迁移必须显式确认，先备份再写入，可按备份清单回滚。

## 上游同步

- `pnpm sync:upstream` 默认 dry-run：读取四套知识资产的固定 pin，与 `--latest` JSON 或 GitHub release 对比，报告 current / behind / ahead / diverged / unavailable 和 DSH 声明范围状态，不写任何文件。
- `pnpm sync:upstream --apply --upstream-root <dir>` 要求工作树干净，调用既有 `assets:sync:*` 与 `assets:check`；`--verify` 再跑 `pnpm verify` 与打包冒烟。它不提交、不推送、不打 tag、不发布，报告写到 OS 临时目录并打印回滚命令。回滚只覆盖已跟踪文件，同步新增的未跟踪文件需按报告中的提示手动清理。

## 检索与编辑

### 全文检索

- 覆盖创作白名单目录（`正文/`、`大纲/`、`设定/`、`追踪/`、`剧集/` 等）、拆文库与 `game-adaptations/`、`video-recaps/` 中的文本产物；只索引 `.md`、`.txt`、`.json`、`.jsonl`，单文件上限 2 MiB，一次检索最多检查 2000 个文件，默认返回 200 条、最多 1000 条。
- 中文按原文匹配，同时提供全拼与首字母两条拼音通道；命中带路径、行号、行内偏移与 `via`（`text` 或 `pinyin`）。
- 查询时按文件版本懒核对索引，结果落 `.oh-story/index/`；面板也提供全量重建。游戏 `build/`、视频 `sources/`、`outputs/` 与重型中间目录不索引。

### 版本历史、回滚、审计、行级批注

- 每个文件保留最近 50 个内容快照（版本、父版本、内容哈希、来源、时间）。回滚要求客户端带上当前磁盘版本，版本不一致返回 412，不覆盖并发修改。
- `audit.jsonl` 记录保存与回滚（路径、版本、来源、时间）；单个坏行会被跳过，不会让整份审计不可读。
- 行级批注绑定原文引用；文件变化后在引用附近重新定位，行号移动标 `moved`，引用消失标 `stale`，批注本身不删除。批注类型为 `note` / `todo` / `review`。

## 任务与数据安全

### 候选暂存与 run / checkpoint / resume

- Agent 用 `oh_story_task stage_candidate` 登记建议，**只登记、不写文件**；候选在「任务与候选」面板由人确认、修订、拒绝或应用，应用时才经文件写入并记录目标路径与版本。
- run 有 `pending/running/awaiting_user/paused/completed/failed/cancelled` 状态与 step 进度；`oh_story_task checkpoint_run` 为长任务落检查点。恢复入口返回最近一个 `paused` 或 `failed` 的 run，并带上它的检查点与已走步骤。
- 内置 `novel-chapter`、`drama-batch`、`game-content` 三个 recipe 只是通用底座示例；未命中 recipe 的 run 不会自动生成步骤。任务状态不替代 DSH 自己的运行记录与审批。

### 备份三件套

- `bundle`（作品包）、`snapshot`（快照）、`full`（整体备份，含 `.oh-story/` 状态但排除 `.oh-story/backup/` 自身）。前两者可以指定作品根，省略时收录创作树。
- 备份产物是 JSON 文件，含内容哈希与文件/字节计数；恢复前校验哈希，写入后核对计数。恢复一律落到新的时间戳目录（如 `恢复备份-<时间>`），**不覆盖原项目**；离线下载的 JSON 也走同一流程。
- 媒体文件只跳过、不存字节。备份不含 DSH 会话、模型配置或 DSH Provider 凭据，不能当会话迁移工具使用。保险库目录也在 `.oh-story/` 下，`full` 备份不会主动排除 `.oh-story/vault/`；启用保险库时请把 full 备份当作敏感文件保管。

### 伏笔闭环

- 伏笔有 `planned/planted/resolved/abandoned` 状态、重要度、计划回收章与证据行；可手工登记，也可从拆书结构化 sidecar 只读导入（导入不回写分析结果）。
- 提醒是查询态而不是推送：按当前书/章查询命中时返回可回收项，`snooze` 可按书、章或时间抑制。
- `finalize` Skill 在完结结算前会跑伏笔回收检查，未回收项必须列为阻塞或显式遗留。

### 书架

- 从工作区发现小说、短剧、游戏、视频作品，写入 `.oh-story/shelf.json`。
- 归档只写 `archivedAt`，从默认书架隐藏；删除写 `deletedAt` 与 30 天 `deleteAfter`，进入回收站。恢复、回收站清理与永久移除都**只改书架记录，不删除工作区内容文件**。

### 可选凭据保险库

- AES-256-GCM；主密钥与密文都在工作区 `.oh-story/vault/`，文件权限收紧为仅当前用户。
- **默认关闭**：只有启动 DSH 前设置 `DSH_MIAOWU_VAULT_ENABLED=1` 才启用；未启用时相关路由返回 403 且不落任何文件。开启后提供状态、读写密钥与原子轮换，没有独立工作台面板。
- 不接管 `MIMO_API_KEY`、`FISH_API_KEY`、ComfyUI 或 DSH 的 Provider 凭据；这些仍走环境变量或 DSH 自身配置。保险库是给创作者自管附加密钥用的，不是 DSH 凭据存储的替代品。

## 创作流程

### `worldbuilding` / `publishing` / `finalize`

三个 Skill 都是本仓库自有，随插件打包并注入 DSH 桥接说明：

- `worldbuilding`：先建世界观再开书；按世界观、势力、规则、地理等维度产出条目，落到长篇 `设定/` 结构，供 `story-long-write` 后续消费。已有条目只增量补齐，不覆盖。
- `publishing`：投稿准备、投稿包组装、发行状态跟踪与上架复盘；投稿、登录、发布动作必须由创作者在平台完成，Skill 不模拟登录、不自动代投。
- `finalize`：完结判定、伏笔回收检查、收尾资产盘点、完结结算报告与后记/番外计划；以 `追踪/_tracking-state.json` 为结构化权威，派生视图只读。

三者都只使用当前 DSH Preset 可见的工具；需要架构或一致性协助时经 `oh_story_role` 调用上游 Role，不自建子代理运行时。

### ComfyUI 本地接入

- 两个入口：短剧生产的 `comfyui` 适配器（第一版只做图片，视频/音乐/TTS 为后续预留），以及通用工具 `oh_story_comfyui`（小说封面、游戏美术等）。
- 工作流必须是 ComfyUI 的 **API-format** JSON，用 `__PROMPT__`、`__WIDTH__`、`__INPUT_IMAGE__` 等占位符替换参数；未提供必需占位符、未配置工作流、连不上服务都会显式报错，不会静默切换到其他生图通道。
- 地址、工作流与工作流目录优先读环境变量，其次读工作区 `.comfyui/config.json`；超时方面，`oh_story_comfyui` 用工具参数 `timeout_seconds`（默认 600，上限 3600），只有短剧适配器读 `COMFYUI_TIMEOUT_SECONDS`。凭据只读环境变量，永不写入配置或响应。短剧适配器只认环境变量，工作区配置文件只对 `oh_story_comfyui` 与工作台状态生效。

### 喵呜小说工坊预设

- 一个 DSH Agent 预设：标准模式的全量工具面 + 中文小说创作 persona。预设文件在 `packages/dsh-plugin/presets/dsh-miaowu/`。
- 从源码 checkout 执行 `pnpm --filter @dsh-miaowu/dsh preset:install`，只写 `~/.dsh/.agent-presets/dsh-miaowu/`，不碰 `~/.dsh` 下其他文件；卸载用 `preset:remove`。发布用 tarball 不含 `presets/`，因此装预构建包的用户需要源码目录才能安装预设。
- `agent.cordis.yml` 复制自宿主内置 `standard`；宿主升级后需要手动 diff 同步（persona 行除外）。

## 界面行为

### 文件树运行中自动刷新

角色子代理、后台任务与脚本的写入不经过当前会话自己的工具调用，整轮结束前没有事件。会话运行期间，工作台约每 4 秒安静重列一次工作区；页面隐藏或上一次请求仍在进行时跳过，列表未变化时不触发重渲染。它只刷新列表，不改变当前打开文件的未保存草稿。

### 按会话 / 工作区布局持久化

- 三栏、分屏与浮动布局按会话存于浏览器存储的 `oh-story.layout.v1.<sessionId>`，不同会话互不串用；布局设置里的「重置」清空这些键。
- 工作台开合选择按工作区路径记住，优先于「工作区里有没有创作项目」的默认判断；浏览器禁用站点数据时只在当前会话内生效。
- 布局、画布视野、选中引用等都属于界面状态，不是创作事实；项目文件仍是唯一权威。

## 明确边界

- 不新增数据库、不写会话持久化、不接管 DSH 的 `workspace.json` 或 `~/.dsh` 状态。
- 不模拟平台登录、不自动投稿或发布，不提供收益承诺。
- 备份、书架、保险库、检索都不改动 DSH 的会话、模型、Preset 或权限；这些仍由 DSH 管理。
- 可选项只有凭据保险库默认关闭；ComfyUI、预设、媒体供应商与三个自有 Skills 都需要显式配置或安装后才生效。
- 当前 npm 渠道尚未发布（`@dsh-miaowu/dsh` 在 registry 返回 404）；源码版本 0.1.18 需按 README 从源码构建，最近发布的 GitHub Release 预构建包是 v0.1.16，不含本文档记录的 0.1.17 / 0.1.18 新能力。
