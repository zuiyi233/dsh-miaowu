# dsh-miaowu 待开发清单

> 来源：参考项目（DSH-better-sidebar / NarraLume / Scriverse / oh-story-dsh 上游）借鉴分析 + `docs/小说全流程覆盖评估.md` 差距核查
> 基线：dsh-miaowu v0.1.6（oh-story-dsh fork + rebrand，2026-09-04）· 更新日期：2026-09-05 · 复核日期：2026-10-24
> 实施状态：✅ 已完成（2026-09-05，四个 Phase 全部落库，`pnpm verify` 全绿）· ⏳ 部分/简化交付 · ⬜ 未做
> 参考素材：`参考项目/` 目录下各调研文档（已被 git 忽略，仅本机留存）

## 2026-10-24 N3-2 / N2 可靠性收尾

- **N3-2 已交付**：保险库 `GET /oh-story/vault/secrets` 无 `name` 时只返回排序后的条目名（不读主密钥、不返回密文），工作台新增默认关闭说明的「保险库」面板；任务 run/step/candidate 的 `availableActions` 改由服务端状态机随响应下发，前端删除重复转移表；短剧生产视图可拖出独立浮窗并复用会话/工作区布局持久化；`read-hash-1m` 改为 5 次取中位数（预算仍 500 ms）；`native-dsh-smoke.ts` 的 41 个类型错误清零并纳入 `pnpm typecheck:lint`，冒烟新增 vault 默认关闭、短剧浮窗、availableActions 与交接校验探测；客户端包体预算按决策放宽到 600,000 字节并打印实际大小（不拆包）。
- **N2 已交付**：新增 `onWorkspaceBeforeWrite` 写前钩子并接入历史回滚与候选应用：按 `realm.fs` 10 分钟节流、并发共享 in-flight、非创作工作区与多书歧义静默跳过，快照失败以 500 阻断写入；自动快照只收创作树（不重收 `.oh-story`，避免历史 JSONL 增长把快照拖成必然 413）。`POST /oh-story/continuity/handoff/verify` 与驾驶舱「校验交接清单」对导入的 manifest 逐文件复算 SHA-256 并复算 checksum，零写入。备份摘要改为按文件 version/size 增量缓存，新增备份只解析新文件。
- **验证**：`pnpm verify` 退出 0（85 个测试文件 / 974 项；ESLint、两套 tsc、五项资产 parity、DSH boundary、release 25/25、upstream-update 3/3、sync-factory 16/16、evaluation 7/7、performance 6/6、build）；浏览器包 412,086 字节 / 600,000。`pnpm test:dsh`（DSH 0.2.1-rc.3）与 `pnpm test:dsh:rc`（DSH 0.2.0-rc.2）均 `"ok": true`。
- **未完成**：G2「100 个项目日用的 2 周实盘」未执行，不能用合成数据宣称通过；跨项目书架扫描仍不在单工作区切片内。

## 2026-10-20 复核

- **Phase A-D 已交付**：全文检索、候选暂存、长任务恢复、备份、版本/审计/批注、布局、拆书结构化、世界观、保险库等均已落库；`pnpm verify` 在代码状态 `abacaa3` 退出 0（lint、typecheck、五项资产 parity、DSH boundary、release 25/25、upstream-update、56 个测试文件 / 561 项、build）。打包冒烟 `pnpm test:dsh` 与 `pnpm test:dsh:rc` 在 DSH 0.2.1-rc.2 / 0.2.0-rc.2 上均为 `"ok": true`（2026-10-20，修复 Windows 8.3 临时路径后）。`client/index.tsx` 已拆为 16 行入口壳，仅该入口脱离 900 行软上限；`client/creative-workbench.tsx` 仍为 1347 行，软上限债务未整体关闭。
- **发布管线已适配 fork**：发布身份（仓库/包名/tarball 前缀）由 `packages/dsh-plugin/package.json` 派生；稳定 tag 为 `miaowu-vX.Y.Z`；`release.yml` 只接受该前缀，并拒绝上游 `v*` tag、缺 fork 入口或源提交不在 `main` 上（`main` 的祖先）的发布；上游专用 `recover-v0.1.13.yml` 已删除。**仍待办**：npm 首次发布（granular `NPM_TOKEN`）与 0.1.16 之后的预构建包发布，目前 0.1.17 / 0.1.18 只有源码；发布前还需在 GitHub 为 `main` 开启分支保护（`ci-proof` 要求 `branches/main.protected === true`，2026-10-20 仍为 false），并启用当前 `disabled_manually` 的 Release 工作流。
- **剩余 P2 / 延后项**：esbuild 多入口拆包（2026-10-24 决策暂不做，预算放宽到 600,000）；真 provider 质量评测仍需付费授权，未运行。
- **明确不在范围**：改编 P3（有声/漫画/翻译/版权签约）不随本轮交付，见 `docs/小说全流程覆盖评估.md`。

## 2026-10-20 P1-A 自诊断 / P1-C 同步工厂骨架

- **已交付**：只读状态盘点（`state-inventory.ts` + `state-contract.ts`）、显式可回滚迁移（`state-migrations.ts`）、六组诊断引擎（`diagnostics.ts`）、宿主路由与支持包（`diagnostics-route.ts` / `support-bundle.ts`）、启动预检、小说/短剧「自诊断」面板、`pnpm sync:upstream` 骨架。
- **状态版本**：书架、伏笔/抑制、拆书 sidecar、批注写入 `schemaVersion: 1`；历史/审计 JSONL、任务顶层数组、检索索引、锁与备份快照按兼容规则读取，不参与 v1 自动迁移。迁移必须显式确认，先备份后写入，支持按清单回滚；中途失败会补偿已写文件并在错误里给出备份目录。
- **修复审计发现**：检索 `meta.json` 不再被误判为行索引；不可迁移的 legacy 文档不再显示无效迁移按钮；GET 计划可直接用于 POST apply；会话「不可读/超时/畸形」分流；密钥文件不再产生逐条 P2；Windows 路径脱敏不区分大小写；冒烟不再用 JSON 转义后的字符串做恒真路径断言。
- **验证**：`pnpm verify` 退出 0（61 个测试文件 / 650 项；sync-factory 16/16）；`pnpm test:dsh` 与 `pnpm test:dsh:rc` 在 DSH 0.2.1-rc.2 / 0.2.0-rc.2 上均 `"ok": true`，并新增诊断路由、支持包确认/脱敏、状态盘点与面板六组断言；浏览器包 392,311 字节。
- **已知限制**：DSH fs 缝没有删除 API，过期锁只报告不代删；`sessionQuery.readSession` 没有 abort 信号，5 秒超时只能分类不能取消底层读取；顶层任务数组与 JSONL 的 v2 迁移未做。P1-B 连续性驾驶舱、P2-A 质量评测、P2-B 性能规模尚未开工；P3 仍按条件触发。

## 2026-10-21 P1-B 驾驶舱 / P2-A 评测 / P2-B 基准

- **P1-B 已交付（只读纵向切片）**：`continuity.ts` 聚合书架、伏笔/snooze、run/候选、审计保存、备份、历史、状态盘点异常、章节与 `追踪/_tracking-state.json`，输出「今天」视图和确定性 P0/P1/P2 风险；`/oh-story/continuity` 只读，`/oh-story/continuity/snapshot` 需 `confirm: true` 且只经备份服务写 `.oh-story/backup/`（按当前书根收录创作树 + `.oh-story` 状态、不含 vault 主密钥；超过单文件上限或 2000 文件截断时拒绝写入），`/oh-story/continuity/handoff` 生成带排序 SHA-256 校验和的交接清单，不可读状态/创作文件列入 `skipped`，达到 2000 文件上限时拒绝而非静默截断；多书歧义时快照与交接都拒绝，要求先写 `.active-book`。章节发现支持 `正文/书名/第N章.md`、`书名/正文/` 与 `.active-book`，多书歧义、无效 `.active-book` 和非法追踪给出 P1；用户可编辑状态里的绝对路径 / `..` 会被过滤。工作台「驾驶舱」面板支持刷新、显式快照、复制交接清单、点击路径跳转与显示当前书目录。
- **P1-B 未完成（按路线图）**：高风险写前自动快照钩子（当前只有编辑器保存的历史快照与手动整体快照）、100 项目日用的 2 周实盘（G2）、项目交接的导入/校验动作（当前只生成 manifest）。跨项目（书架）扫描未纳入本切片，避免把 100 项目扫描成本塞进单工作区请求；单工作区概览仍会调用状态盘点与备份列表，备份数量很大时成本随文件数增长，尚未做缓存/增量。
- **P2-A 骨架**：`scripts/eval-quality.mjs` + 7 个固定结构样本 + 7 条确定性 rubric + badcase 清单，双版本对比输出 JSON/Markdown；`pnpm test:eval` 已入门禁，**工具本身不是发布门禁，且未运行任何真实 provider 评测**。详见 `docs/EVALUATION.md`。
- **P2-B 骨架**：`scripts/perf-scale.mjs` 合成 1000 章 / 1M 汉字 / 10k 文件 / 200 run，测遍历、章节枚举、读取+hash、状态 JSON、备份式收集；`pnpm test:perf` 已入门禁，完整基准不入门禁。本机最终复核 `read-hash-1m` 以 537.32 ms 超出 500 ms 原始预算，已如实记录；它不是插件级 UI SLO。详见 `docs/PERFORMANCE.md`。
- **构建优化**：客户端 esbuild 直接输出 UTF-8，避免默认 ASCII 将中文转成 `\uXXXX`；包体从 392,311 降到 372,317 字节，400,000 预算不变。
- **P3**：仍按路线图条件触发，默认不做多端/云/实时协作。

## 2026-10-21 有声剧 N4-A 交付

- **N4-A 已交付（单章单旁白纵向切片）**：`audiobook-*` 服务（项目发现/持久化、确定性切分、内容寻址缓存、OpenAI-compatible TTS、章节 job、ffmpeg 导出、二进制存储）、`/oh-story/audiobook/*` 路由、小说工作台「有声剧」面板；项目/脚本/音频写 `有声剧/`，缓存与任务写 `.oh-story/audiobook/`，不写 DSH 会话、`workspace.json` 或 `~/.dsh`。启动任务、恢复任务与导出都必须 `confirm: true`；`OH_STORY_TTS_API_KEY` 只从宿主环境读取，密钥不入项目、缓存、响应或日志。
- **N4-A 验证**：`pnpm verify` 退出 0（lint、typecheck、五项资产 parity、DSH boundary、release 25/25、upstream-update 3/3、sync-factory 16/16、eval 7/7、perf 6/6、72 个测试文件 / 834 通过 + 1 跳过、build），浏览器包 386,196 字节（预算 400,000）；`pnpm test:dsh` 与 `pnpm test:dsh:rc` 在 DSH `0.2.1-rc.2` / `0.2.0-rc.2` 上均 `"ok": true`。打包冒烟新增只读 overview 探测（`ttsKey` 必须为 `present`、`sources` 非空且至少一个来源有章节、密钥与绝对路径不泄漏）和「有声剧」面板探测（`TTS 密钥已配置` 文案、无错误、不建项目、不调 TTS）。本机没有 ffmpeg/ffprobe，真实 MP3 编码未验证。详见 [VALIDATION.md](VALIDATION.md) 的 2026-10-21 有声剧审计。
- **N4-B 已交付（多角色）**：`cast` 恰好一个旁白 + 若干角色，音色映射随项目保存/加载恢复；新增 `GET|PUT /oh-story/audiobook/script` 读取脚本与逐段指派，PUT 用 `baseVersion` CAS 并在改说话人后重算片段 id；重新解析覆盖时按 `(kind, text, sourceStart)` 保留手工指派并返回 `preserved`/`dropped`；成本预估、任务执行与导出按每段角色音色组缓存键，改一段或改单个角色音色只失效相关段；未指派/指向已删除角色的对白会显示计数，并让预估、新建、恢复与导出返回 409。工作台新增角色编辑器与「分段」指派面板。验证与限制见 `docs/VALIDATION.md` 的 2026-10-22 有声剧 N4-B 审计。
- **N4-C 待交付（完整有声剧）**：本地 BGM/音效与可编辑 cue 时间轴、响度 -16 LUFS ±1 与 true peak ≤ -1.5 dBTP、SRT/LRC、M4B 章节与封面、发布包与授权清单校验。（2026-10-24 已交付，见下方「2026-10-24 有声剧 N4-C 交付」。）
- **N4-D 待交付（批量化与质量）**：≥20 章整书批量、成本报告可审计、无孤儿文件、两周实盘或等效样本。**DSH 重启后的自动续跑也延后到 N4-D**（N4-B 只支持显式恢复排队/进行中/暂停/失败任务，不会在启动时自动继续计费）。
- **P3**：仍按路线图条件触发（漫画/翻译/版权签约等改编能力不随 N4-A 解锁；有声由 N4 承接）。

## 2026-10-22 有声剧 N4-B 交付

- **N4-B 已交付（多角色）**：`audiobook-cast.ts` 统一解析旁白/角色并判定未指派；项目保存/加载校验 `cast`（恰好一个旁白、id 唯一、保留值 `unknown` 不可用）；脚本服务新增 CAS 说话人指派与按文本/源偏移迁移的重新解析保留；成本预估、任务执行、恢复与导出统一按每段音色组缓存键；项目视图新增 `unassignedSegments`，四道付费/导出入口对未指派对白返回 409。工作台新增角色编辑器、分段指派面板、未指派高亮与按钮禁用。
- **N4-B 验证**：`pnpm verify` 退出 0（73 个测试文件 / 855 通过 + 1 跳过；lint、typecheck、五项资产 parity、DSH boundary、release 25/25、upstream-update 3/3、sync-factory 16/16、eval 7/7、perf 6/6、build），浏览器包 394,416 字节（预算 400,000）；有声剧 9 个测试文件 168 通过 + 1 跳过（新增 cast 校验、指派 CAS、重解析保留、逐段音色缓存键、只重生成受影响段、未指派四道门禁与 10 章 + 旁白 + 3 角色样本）。`pnpm test:dsh` 与 `pnpm test:dsh:rc` 在 DSH `0.2.1-rc.2` / `0.2.0-rc.2` 上均 `"ok": true`。
- **限制**：本机仍无 ffmpeg/ffprobe，真实 MP3 编码/拼接/时长未验证；未发起真实付费 TTS。N4-C（BGM/音效、cue 时间轴、响度、SRT/LRC、M4B、封面、发布包）与 N4-D（整书批量、成本审计、重启自动续跑）仍待交付。

## 2026-10-24 有声剧 N4-C 交付

- **N4-C 已交付（完整有声剧）**：`audiobook-assets.ts` 扫描 `素材/音乐`、`素材/音效`，用 CAS 读写 `素材/授权.json` 并以 `assertCuesAuthorized` 拒绝未授权素材挂到 cue；`audiobook-timeline.ts` 用 `DEFAULT_PAUSE_MS = 120` 排出片段时间轴，`buildTimeline`/`cueWindow`/`assertCueWindow` 供混音与字幕共用；`audiobook-duration.ts` 把 ffprobe 实测时长按内容寻址缓存在 `.oh-story/audiobook/durations/`；`audiobook-mix.ts` 生成 concat/apad/amix filter graph 与两遍 loudnorm（目标 −16 LUFS / TP −1.5 / LRA 11）参数并解析测量 JSON；`audiobook-subtitles.ts` 输出 SRT/LRC，按 42 字贪心拆行；`audiobook-m4b.ts` 写 ffmetadata 章节表与 M4B/封面参数（封面缺位在导出前 409）；`audiobook-package.ts` 写 `发布/发布清单.json`（逐文件 sha256 + 可复算 checksum）；`audiobook-asset-provider.ts` 提供 `LocalAssetProvider` 与复用 `oh_story_comfyui` 工具的 `ComfyUiMusicProvider`，生成回执写回授权文档。`audiobook-binary.ts` 增加 `hash`/`copy`。路由新增 `GET|PUT /oh-story/audiobook/assets` 与 `POST /oh-story/audiobook/assets/generate`（生成需 `confirm: true`、`preview` 零写入、ComfyUI 未配置 503、素材越界 403、授权保存失败回滚本次生成文件），`POST /oh-story/audiobook/export` 兼容旧单章 MP3 调用并新增 `formats`（mp3/m4b/subtitles/package）与 `preview`（预检零写入），完整导出按 staging → promote → package → 清单最后写。工作台「有声剧」面板新增 `AssetPanel` 与 `ExportPanel`：未授权素材不能加入 cue，预检未就绪时禁用完整导出，生成/导出前 `window.confirm`，不显示密钥与绝对路径。数据仍在 `有声剧/<书>/`（`素材/`、`封面/`、`字幕/`、`发布/`）与 `.oh-story/audiobook/`（时长缓存、任务、导出临时目录），不写 DSH 会话、`workspace.json` 或 `~/.dsh`。
- **N4-C 验证**：`pnpm verify` 退出 0（84 个测试文件 / 956 项通过；lint、typecheck、五项资产 parity、DSH boundary、release 25/25、upstream-update 3/3、sync-factory 16/16、eval 7/7、perf 6/6、build），浏览器包 399,864 字节（预算 400,000）。真实 ffmpeg 验收（`tests/audiobook-ffmpeg.test.ts`，ffmpeg/ffprobe 9.0.2 实跑、非伪造）：两遍 loudnorm 后母带实测综合响度 −16.0 LUFS（落在 −16±1 门限内）、真峰值 −10.6 dBFS；混音母带时长 920 ms，与时间轴长度一致；M4B 产出 2 个章节并带 `attached_pic` 封面流。响度读数取自 ffmpeg 9 的 ebur128 `Summary:` 块（`Integrated loudness: I: … LUFS`、`True peak: Peak: … dBFS`）。如实说明：`TP=-1.5` 写死在 loudnorm 第二遍参数里，真峰值上限的判别力有限，该用例是混音/章节/封面嵌入链路的验收，不是独立的限幅器证明。`pnpm test:dsh` 与 `pnpm test:dsh:rc` 在隔离 `DSH_HOME` 下于 DSH `0.2.1-rc.2` / `0.2.0-rc.2` 均 `"ok": true`、退出 0。详见 [VALIDATION.md](VALIDATION.md) 的 2026-10-24 有声剧 N4-C 审计。
- **N4-C 有意偏离设计文档之处**：cue 与素材路径统一为**工作区相对**（`有声剧/<书>/素材/...`），不是 spec 4.3 示例里的书内相对；发布清单的 `providerReceipts` 收录素材生成回执 + `cost`，spec 4.4 的 TTS endpoint/voice 级回执本切片未做；外部素材生成默认依赖 ComfyUI 配置，未配置时路由返回 503。
- **N4-D 待交付（批量化与质量）**：≥20 章整书批量与进程中断后的自动续跑、成本与实际请求数审计与孤儿文件治理、TTS 时长 QC 的 0.5–1.8 比值复检、波形预览、真实付费 provider、连续两周实盘。另：本切片未发起真实付费 TTS，也没连真实 ComfyUI（provider 测试注入假 `oh_story_comfyui` 端口），特定 provider 的音色、延迟与价格仍未验证。
- **P3**：仍按路线图条件触发。

## 2026-10-24 客户端包体门禁放宽（N3 决策）

- **决策**：客户端不做 esbuild 多入口拆包。宿主 `dsh-client-modules` 原生支持包内懒加载 chunk（`require.async("./client.xxx.js")` + `__ModuleLoader__.load({ chunk })`），官方插件已有先例；本轮按用户决策直接放宽预算，保留单 bundle 形态。
- **变更**：`scripts/build-dsh-plugin.ts` 的浏览器包预算从 400,000 提到 600,000，构建成功时打印实际字节。当前 `client.js` 为 399,864 字节。
- **影响**：每次启动仍加载整包；600,000 是上限不是目标，后续 UI 增长需继续盯住。N3 其余项（保险库 UI、短剧生产素材/分镜板浮动面板、`availableActions` 服务端下发、`read-hash-1m` 结论）按原路线推进。

## 2026-10-24 N3-1 工程债清零

- **类型门禁**：`scripts/native-dsh-smoke.ts` 在 `tsc -p tsconfig.lint.json --noEmit` 下的 41 个既有类型错误已清零（`topBox` / `editorBox` / `editorCellBox` / `chatFlowBox` 的 null 收窄，textarea / iframe 断言，紧凑布局六元组断言）；新增 `pnpm typecheck:lint` 并加入 `pnpm verify` / `pnpm verify:portable`。
- **验证**：`pnpm verify` 退出 0（84 个测试文件 / 956 项通过；lint、typecheck、typecheck:lint、五项资产 parity、DSH boundary、release 25/25、upstream-update 3/3、sync-factory 16/16、eval 7/7、perf 6/6、build）；浏览器包 399,864 字节（预算 600,000）。`pnpm test:dsh` 在隔离 `DSH_HOME`、DSH `0.2.1-rc.3` 上 `"ok": true`，退出 0；`pnpm test:dsh:rc` 在 DSH `0.2.0-rc.2` 上 `"ok": true`，退出 0。

## 第一优先（高价值，直接对应现有差距）

| # | 功能 | 借鉴来源 | 落点 | 状态 | 落点（实施后） |
|---|---|---|---|---|---|
| 1 | 全文检索 | Scriverse（FTS5 trigram + 拼音双通道） | 小说工作台 | ✅ | `src/services/search.ts` + `pinyin-map.ts`（26k 字拼音表）+ 搜索面板：行级索引落 `.oh-story/index/`，懒增量刷新，GET /oh-story/search 返回 path/line/offset/text（via text/pinyin），10 万字 <2s |
| 2 | AI 建议不自动成为决策（candidate staging） | NarraLume | 短剧生产 / 小说章节采纳 / 游戏生成 | ✅ | `src/services/tasks.ts` 候选底座：propose→confirm→apply(reject/amend 分支、幂等、file committer CAS 写入)，confirmed 产物独立于 run 生命周期；Agent 侧新增 `oh_story_task stage_candidate` 工具（skill bridge 已告知自有 skill），登记候选不写文件，确认/应用留在「任务与候选」面板由人执行 |
| 3 | 长任务可中断可恢复 | NarraLume（steps/checkpoints/runs）、Scriverse（analysis_tasks 状态机） | 短剧批次生产 / 小说长文生成 | ✅ | `src/services/tasks.ts` run/step/checkpoint：resume 返回最近 paused/failed run 含 checkpoint；内置 novel-chapter / drama-batch / game-content 三 recipe；任务中心面板；Agent 侧新增 `oh_story_task checkpoint_run` 工具，长写 agent 可在中断前落检查点，工作台按 resume 恢复 |
| 4 | 备份三件套 | NarraLume（bundle/snapshot/全库备份） | workspace 数据层 | ✅ | `src/services/backup.ts` + 备份面板：bundle/snapshot/full（hash+counts+sizeBytes），恢复一律新目录不覆盖，支持离线 JSON 导入；备份→篡改→恢复回归测试 |
| 5 | 版本化 + 审计 + 行级批注 | Scriverse（entity_versions/audit_logs/行 ID 锚定） | 小说编辑器 / 短剧五文档 | ✅ | `src/services/history.ts` + 历史面板：保存快照（≤50/文件去重）+ 回滚（CAS 412）+ audit.jsonl 留痕 + 行级批注（quote 窗口重锚 moved/stale），LCS 逐行 diff 展示 |
| 6 | 异步双面板 + 自由窗口 | DSH-better-sidebar | 游戏/视频两栏 + 素材浮动 | ✅ | `src/client/layout/`（split-tree/split-pane/free-window）+ 会话隔离布局持久化（oh-story.layout.v1.<sessionId>）；故事/短剧 tree\|editor 递归 split、游戏/视频 Studio 浮动镜像 + 回 dock；短剧生产视图整体浮窗（含素材/镜头 tab） |
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

- ✅ 已核实（2026-09-05）：`story` skill 引用的 `scripts/dashboard-server.mjs` 在**上游 `oh-story-dsh@main` 全树同样不存在**（`packages/knowledge/oh-story/skills/story/scripts/` 仅含 `author_memory_commit.py`），本地 fork 该目录与上游 diff 为空；`build-dsh-plugin.ts` / `knowledge-assets.ts` 显式排除、`check-upstream-parity.ts` 跳过——系上游刻意不随包分发 Dashboard 服务，但 `SKILL.md`「Dashboard 工作台」引用未同步清除（短剧侧 `dashboard_server.py` 同模式）。处置：回馈上游（issue 文案已备，本机 `gh` 未装待手动贴出），本地保持基线不改。

## 工程注记（实施后，2026-09-05，历史）

- 扩展缝：`src/services/registry.ts`（registerWorkspaceExtension + onWorkspaceWrite）+ `src/client/features/registry.ts`（registerWorkbenchFeature + registerFileViewer），并行代理据此无冲突交付
- 客户端构建已开 esbuild 完整 minify，并自 2026-10-20 起对 `?inline` CSS 做构建期 minify；2026-10-21 起直接输出 UTF-8；`client.js` 386,196 字节（2026-10-21，预算 400,000），2026-10-24 N4-C 后为 399,864 字节；同日预算放宽到 600,000（余量 200,136 字节）
- 历史债务（2026-09-05）：`client/index.tsx` 约 2060 行超 900 行软上限；该债务已于 Phase A-D 拆为 16 行入口壳（见 2026-10-20 复核）。仍延后：esbuild 多入口拆包（2026-10-24 决策暂不做）