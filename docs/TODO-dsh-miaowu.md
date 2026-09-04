# dsh-miaowu 待开发清单

> 来源：参考项目（DSH-better-sidebar / NarraLume / Scriverse / oh-story-dsh 上游）借鉴分析 + `docs/小说全流程覆盖评估.md` 差距核查
> 基线：dsh-miaowu v0.1.6（oh-story-dsh fork + rebrand，2026-09-04）· 更新日期：2026-09-05
> 参考素材：`参考项目/` 目录下各调研文档（已被 git 忽略，仅本机留存）

## 第一优先（高价值，直接对应现有差距）

| # | 功能 | 借鉴来源 | 落点 | 说明 |
|---|---|---|---|---|
| 1 | 全文检索 | Scriverse（FTS5 trigram + 拼音双通道） | 小说工作台 | 当前无跨文档检索能力，最明显缺口；先做章节/段落级检索 + 行号跳转，后扩 12 类实体 RRF 统一搜索 |
| 2 | AI 建议不自动成为决策（candidate staging） | NarraLume | 短剧生产 / 小说章节采纳 / 游戏生成 | 与短剧"creator 确认后才执行"契约同源，推广为"候选→确认→落库"两步流 |
| 3 | 长任务可中断可恢复 | NarraLume（steps/checkpoints/runs）、Scriverse（analysis_tasks 状态机） | 短剧批次生产 / 小说长文生成 | 先立 run/step 底座 + 恢复演练回归 |
| 4 | 备份三件套 | NarraLume（bundle/snapshot/全库备份） | workspace 数据层 | 作品包导出/快照恢复（恢复为新项目） |
| 5 | 版本化 + 审计 + 行级批注 | Scriverse（entity_versions/audit_logs/行 ID 锚定） | 小说编辑器 / 短剧五文档 | 已有 PUT 版本前置条件，补版本历史查看/回滚 + 操作留痕；审稿输出行级引用卡片 |
| 6 | 异步双面板 + 自由窗口 | DSH-better-sidebar | 游戏/视频两栏 + 素材浮动 | 递归 split、FreeWindow 拖出浮动、会话隔离持久化；对照现有 `workbench-ui.ts` |
| 7 | **拆书结果结构化** | NarraLume（ImportAnalysis JSON）、Scriverse | 拆文库 | 拆书产物目前是 Markdown 文档树、不可查询；参考项目已验证"实体/关系/时间线可查询 + 证据引用可追溯"价值；与 #1/#5 同组实施 |
| 8 | **独立世界观构建入口** | 参考项目（世界观维度体系）+ 全流程断档① | 新建/扩展 skill 或独立 workflow | 当前世界观构建并入建书 Phase 2，无独立入口；目标"先建世界观再开书"的独立工作流 |

## 第二优先（中价值，协商取舍）

| # | 功能 | 借鉴来源 | 落点 | 说明 |
|---|---|---|---|---|
| 9 | 插件注册表开放（registerTab/registerFileViewer） | DSH-better-sidebar | 远期插件内核 | 轻量视图注册表，短期不接 |
| 10 | 密钥加密存储（AES-GCM） | Scriverse | 媒体适配器凭据 | 当前由 DSH 环境/项目外配置决定，暂不自建；未来自管第三方 key 时照搬 |
| 11 | 声明式设置开放 / 布局推挤 / 懒加载 | DSH-better-sidebar | 工作台 UI | 低风险增量 |
| 12 | 伏笔埋设→提醒→回收闭环、书架多作品管理 | Scriverse / NarraLume | 小说第二阶段 | 与 #2/#5 共用 review_items / candidate 基础设施 |
| 13 | P0/P1/P2 问题分类法 + 端到端链路审计方法 | 旧项目审计文档（历史基线） | VALIDATION 门禁 / 工作台链路检查表 | 把审计方法固化为回归检查 |
| 14 | 出版/投稿/发行执行 | 全流程断档③ | 新 skill | 现仅参考资料无执行入口 |
| 15 | 完结/收尾专项结算 | 全流程断档④ | 新 skill | 长篇收尾无完结结算流程 |

## 明确不借鉴

- Scriverse SQLite + 127 迁移体系（dsh-miaowu 是 DSH 插件形态、无本地库）
- Drama 独立 Dashboard 等上游已排除项

## 待核实项

- `story` skill 引用的 `scripts/dashboard-server.mjs` 不在 manifest/本地文件清单中（Dashboard 工作台入口依赖它）——上游同步时核实，若缺失回馈上游。
