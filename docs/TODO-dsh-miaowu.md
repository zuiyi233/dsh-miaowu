# dsh-miaowu 待开发清单

> 来源：参考项目（DSH-better-sidebar / NarraLume / Scriverse / oh-story-dsh 上游）借鉴分析 + `docs/小说全流程覆盖评估.md` 差距核查
> 基线：dsh-miaowu v0.1.6（oh-story-dsh fork + rebrand，2026-09-04）· 更新日期：2026-09-05
> 实施状态：✅ 已完成（2026-09-05，四个 Phase 全部落库，`pnpm verify` 全绿）· ⏳ 部分/简化交付 · ⬜ 未做
> 参考素材：`参考项目/` 目录下各调研文档（已被 git 忽略，仅本机留存）

## 第一优先（高价值，直接对应现有差距）

| # | 功能 | 借鉴来源 | 落点 | 状态 | 落点（实施后） |
|---|---|---|---|---|---|
| 1 | 全文检索 | Scriverse（FTS5 trigram + 拼音双通道） | 小说工作台 | ✅ | `src/services/search.ts` + `pinyin-map.ts`（26k 字拼音表）+ 搜索面板：行级索引落 `.oh-story/index/`，懒增量刷新，GET /oh-story/search 返回 path/line/offset/text（via text/pinyin），10 万字 <2s |
| 2 | AI 建议不自动成为决策（candidate staging） | NarraLume | 短剧生产 / 小说章节采纳 / 游戏生成 | ✅ | `src/services/tasks.ts` 候选底座：propose→confirm→apply(reject/amend 分支、幂等、file committer CAS 写入)，confirmed 产物独立于 run 生命周期；Agent 侧新增 `oh_story_task stage_candidate` 工具（skill bridge 已告知自有 skill），登记候选不写文件，确认/应用留在「任务与候选」面板由人执行 |
| 3 | 长任务可中断可恢复 | NarraLume（steps/checkpoints/runs）、Scriverse（analysis_tasks 状态机） | 短剧批次生产 / 小说长文生成 | ✅ | `src/services/tasks.ts` run/step/checkpoint：resume 返回最近 paused/failed run 含 checkpoint；内置 novel-chapter / drama-batch / game-content 三 recipe；任务中心面板；Agent 侧新增 `oh_story_task checkpoint_run` 工具，长写 agent 可在中断前落检查点，工作台按 resume 恢复 |
| 4 | 备份三件套 | NarraLume（bundle/snapshot/全库备份） | workspace 数据层 | ✅ | `src/services/backup.ts` + 备份面板：bundle/snapshot/full（hash+counts+sizeBytes），恢复一律新目录不覆盖，支持离线 JSON 导入；备份→篡改→恢复回归测试 |
| 5 | 版本化 + 审计 + 行级批注 | Scriverse（entity_versions/audit_logs/行 ID 锚定） | 小说编辑器 / 短剧五文档 | ✅ | `src/services/history.ts` + 历史面板：保存快照（≤50/文件去重）+ 回滚（CAS 412）+ audit.jsonl 留痕 + 行级批注（quote 窗口重锚 moved/stale），LCS 逐行 diff 展示 |
| 6 | 异步双面板 + 自由窗口 | DSH-better-sidebar | 游戏/视频两栏 + 素材浮动 | ✅（素材板浮动为 ⏳ 简化） | `src/client/layout/`（split-tree/split-pane/free-window）+ 会话隔离布局持久化（oh-story.layout.v1.<sessionId>）；故事/短剧 tree\|editor 递归 split、游戏/视频 Studio 浮动镜像 + 回 dock；短剧生产素材/分镜板独立浮动留后续（需 split 第三 leaf） |
| 7 | **拆书结果结构化** | NarraLume（ImportAnalysis JSON）、Scriverse | 拆文库 | ✅ | `src/services/analysis.ts` + 分析面板：拆文库 Markdown → sidecar JSON（实体/关系/时间线/伏笔/场景 + 原文证据行号），parse/query/export 路由 |
| 8 | **独立世界观构建入口** | 参考项目（世界观维度体系）+ 全流程断档① | 新建/扩展 skill 或独立 workflow | ✅ | `packages/knowledge/dsh-miaowu/skills/worldbuilding/`（自有子包 + 自建 manifest + parity）：先建世界观再开书，产物落 story-long-write Phase 2 设定/ 目录，story-architect 经 oh_story_role 协作 |

## 第二优先（中价值，协商取舍）

| # | 功能 | 借鉴来源 | 落点 | 状态 | 落点（实施后） |
|---|---|---|---|---|---|
| 9 | 插件注册表开放（registerTab/registerFileViewer） | DSH-better-sidebar | 远期插件内核 | ✅ | `src/client/features/registry.ts` 扩展 registerFileViewer（priority/extensions/match/detect/catch-all + disposer + snapshot 订阅），编辑器「视图」tab 渲染命中 viewer；内置 source-map JSON 树形示例 |
| 10 | 密钥加密存储（AES-GCM） | Scriverse | 媒体适配器凭据 | ✅（可选模块，默认关闭） | `src/services/vault.ts` + `docs/凭据保险库评估.md`：AES-256-GCM（node:crypto 零依赖），DSH_MIAOWU_VAULT_ENABLED 显式开启，rotate 原子轮换，不改现有 DSH 环境凭据路径 |
| 11 | 声明式设置开放 / 布局推挤 / 懒加载 | DSH-better-sidebar | 工作台 UI | ✅（代码级拆包 ⏳） | `src/client/layout/layout-settings.tsx` 设置面板（重置布局/偏好切换/特性开关）；推挤语义确认（grid 挤 Chat、浮窗/抽屉不推挤）；懒加载=打开才挂载才请求；esbuild 多入口拆包留后续（单 bundle 形态） |
| 12 | 伏笔埋设→提醒→回收闭环、书架多作品管理 | Scriverse / NarraLume | 小说第二阶段 | ✅ | `src/services/foreshadows.ts`（状态机/按章提醒/snooze/A3 sidecar 导入）+ `src/services/bookshelf.ts`（发现/归档/30 天回收站/不删内容）+ 双面板 |
| 13 | P0/P1/P2 问题分类法 + 端到端链路审计方法 | 旧项目审计文档（历史基线） | VALIDATION 门禁 / 工作台链路检查表 | ✅ | `docs/VALIDATION.md` 扩展：P0/P1/P2 分类表 + 工作台链路检查表（每链路的确定性证据映射，🔒 标记 verify 强制项） |
| 14 | 出版/投稿/发行执行 | 全流程断档③ | 新 skill | ✅ | `packages/knowledge/dsh-miaowu/skills/publishing/`：投稿准备/组包/{作品}/发行/ 状态跟踪/上架复盘，投稿动作由创作者执行 |
| 15 | 完结/收尾专项结算 | 全流程断档④ | 新 skill | ✅ | `packages/knowledge/dsh-miaowu/skills/finalize/`：完结判定（含伏笔回收门禁）/资产盘点/完结结算报告/平台完结指引 |

## 明确不借鉴

- Scriverse SQLite + 127 迁移体系（dsh-miaowu 是 DSH 插件形态、无本地库）——实施中全程遵守：检索/任务/备份/保险库全部 JSON/JSONL 落 `.oh-story/` 隐藏目录
- Drama 独立 Dashboard 等上游已排除项

## 待核实项

- `story` skill 引用的 `scripts/dashboard-server.mjs` 不在 manifest/本地文件清单中（Dashboard 工作台入口依赖它）——上游同步时核实，若缺失回馈上游（实施各 Phase 未改动该基线状态）

## 工程注记（实施后）

- 扩展缝：`src/services/registry.ts`（registerWorkspaceExtension + onWorkspaceWrite）+ `src/client/features/registry.ts`（registerWorkbenchFeature + registerFileViewer），并行代理据此无冲突交付
- 客户端构建已开 esbuild 完整 minify（403KB → 266KB，预算 400KB 内重新有富余）
- 已知债务：`client/index.tsx` 约 2060 行超 900 行软上限（拆组件/多功能面板独立文件为后续重构项）；短剧生产素材板独立浮动、esbuild 多入口拆包、availableActions 服务端下发（现为前端状态表）为后续项