# dsh-miaowu 全局提示词（AGENTS.md）

> 本文件是本仓库（`E:\dsh-miaowu`）内所有 Agent 协作的最高项目指令。
> 优先级：用户实时指令 > 本文件 > 仓库文档/规格（`docs/`、`README` 等）。

## 0. 遇到问题先查手册（强制）

动手排查 DSH 宿主、插件、会话、工具链问题之前，**先查本地手册**，不要凭经验猜：

- 手册位置：`参考项目/dsh-handbook-main/`
- 速查入口（按顺序看）：
  1. `参考项目/dsh-handbook-main/llms.txt` —— 全书索引，先定位章节；
  2. `参考项目/dsh-handbook-main/docs/faq.md` —— 39+ 真实问答，`unknown tool ""` 等已有根因；
  3. `参考项目/dsh-handbook-main/docs/cheatsheet.md` —— 一页速查卡；
  4. 按需读对应章节：安装 `02-quickstart.md`、profile/插件机制 `03-profiles.md`、插件开发 `04-plugin-dev.md`、工具与上下文 `08-tools-context.md`、已知缺陷 `12-limitations.md`、安全沙箱 `13-security.md`、复杂实案 `10-complex-cases.md`。
- 手册是在线文档站 + PDF 的本地克隆（`Electricitysheep/dsh-handbook`，当前 `81dbd99`），比官方文档多一层“从零上手 + 社区实测坑位”。
- 只有手册里没有、或手册方案已验证无效时，才进入宿主源码（`C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/`）实证排查，并在结论里注明“手册未覆盖”。

## 1. 项目定位（一句话）

`dsh-miaowu` 是 `oh-story-dsh`（`upstream = https://github.com/zenstory-ai/oh-story-dsh.git`）的授权 fork，
`origin = https://github.com/zuiyi233/dsh-miaowu.git` 为准，上游只作历史来源。
插件注册名 `dsh-miaowu`，npm 包 `@dsh-miaowu/dsh`。`oh-story` 前缀的路由/工具/目录是**保留的功能引用**，不要误当品牌名改掉。

## 2. 插件边界（红线）

- DSH 拥有模型、provider、preset、权限、roots、runs、sessions。**本插件只做领域贡献**：skills、roles、tools（`oh_story_*` 具名注册）、hooks（`tools/pre-execute`、`tools/post-execute` 写法守卫）、`/oh-story/*` 工作台路由、客户端 workbench。
- **绝不碰**：会话持久化（`sessionPersistence` / `borrowSession` / `session-query`）、`workspace.json` 注册表结构、`~/.dsh` 下任何宿主状态文件的写入（读可以，改必须用户明确点头且先备份）。
- 扩展走注册表缝：Host 侧 `src/services/registry.ts` 的 `registerWorkspaceExtension`，客户端 `src/client/features/registry.ts` 的 `registerWorkbenchFeature` / `registerFileViewer`。不要改 `workspace-route.ts` / `index.tsx` 主体。

## 3. 已知宿主坑（不要重复踩）

0. **空名工具 bug 已在宿主侧打补丁（2026-09-05，用户真实测试确认有效）**：病根是 `dsh-llm-deepseek` 流式解析对 `block.name`/`block.callId` 覆盖赋值（手册 `docs/faq.md` 的 `unknown tool ""` 条，根因讨论 #725）。补丁文件：`C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js:1288-1289`，改覆盖为“非空字符串才累加”，备份同目录 `index.js.bak-emptyname-fix`。注意三点：① 改的是本机全局 npm 宿主文件，不在仓库内，`git status` 看不到；② `npm i -g @deepseek-ai/dsh` 升级会覆盖补丁，升级后先看官方修没修 #725，没修则重打；③ 纯 JS 改动，重启 DSH App 即生效，不用重建。

1. **空名工具 bug（alpha.4 / rc.1 均复现）**：宿主内置 `read`/`write` 发给模型时函数名丢空 → `Error: unknown tool ""` → 400。已做三级隔离（完整 profile / 摘本插件 / 双插件全摘只剩官方底座）**均复现**，与本插件无关。手册 `docs/faq.md` 有同族根因（rc.6 SSE 流式覆盖赋值，`translate.ts` 累加 + 严格类型校验），修宿主源码前先对一下手册方案。
2. **畸形 tool 消息污染会话**：空名失败回合的 `tool/result`（`callId: ""`）会被持久化，重载时网关校验 `message must have tool source` 失败 → “历史加载失败”。纯文本会话不受影响。用户真实会话若报此错，先摘畸形消息再谈修复。
3. **`workspace.json` 是双表结构**：`tables.workspaces` 明细 + `global.workspaceIds` 顺序表。删工作区必须两处一起删，否则 `dsh web` 启动报 `registry order references missing workspace` 直接起不来。改前必备份。
4. **真实 profile 是生产环境**：`~/.dsh/profiles/web` + 全局 rc.1 CLI。对真实 profile 跑探针/冒烟必污染 `~/.dsh/sessions` 与 `workspace.json`，跑完必须清理（删探针会话目录 + 移除索引条目 + 清 `%TEMP%` 残留），或一开始就用隔离 `DSH_HOME` 跑。
5. **空目录没有 UI 是设计**：`hasCreativeProject` 为假且无报错时工作台返回 null，连按钮都不画。冷启动走对话（`story-setup` DSH 版只建小说目录）或手动建 `正文/`，不要当成“插件没加载”。
6. **Windows 命令行坑**：MSYS tar 遇 `D:/` 盘符当远程主机（加 `--force-local` 或纯 Node）；curl URL 被路径转换（`MSYS_NO_PATHCONV=1`）；`kill $PID` 只杀 wrapper，按 `netstat -ano` 找 LISTENING 真 PID 再 `taskkill //F //T`。

## 4. 验证要求

- 改码后按 `pnpm verify`（lint + typecheck + parity + boundary + 单测 + build）走；桌面/插件改完只跑 test 不算完，必须重建 + 受控冒烟。
- 无法验证 / 部分验证 / 验证失败必须明说；无真实证据不得声称“已成功”；不为“能跑”加静默降级、mock 兜底或吞错。
- 收尾必须说清：做了什么、验证了什么、限制/失败点/剩余风险是什么。

## 5. 参考项目与手册更新

- `参考项目/` 目录被 `.gitignore` 忽略，是本地对照素材，不进仓库：`DSH-better-sidebar-main`、`narralume-main`、`oh-story-dsh-main`、`scriverse-main`、`dsh-handbook-main` + 若干调研文档。
- 手册更新（`origin` 即上游本人，可直接取更新）：
  ```bash
  cd "E:/dsh-miaowu/参考项目/dsh-handbook-main"
  git fetch origin
  git log --oneline -3
  # 有落后时：git pull --ff-only
  ```
- 主仓库上游同步：`git fetch upstream && git merge upstream/main`（文档冲突用“我们的名 + 上游内容”约定）。
