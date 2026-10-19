# Agent Note: DSH 0.2.1-rc.2 与 Oh Story 0.9.0 联合适配发布

Status: implemented

## Problem

0.1.16 发布后，`@deepseek-ai/dsh` 在 npm 上的 `latest` 从 `0.2.0-rc.2` 前进到 `0.2.1-rc.2`，alpha 线停在 `0.2.1-alpha.5`；README 的默认安装命令仍固定旧 rc，开发宿主还在 alpha.4。上游 Oh Story 发布 0.9.0（`agents_version` 35 → 36），按写书时刻重排 13 个 Skill 的参考资料并删除重复资料；NovelToGame 发布 0.6.0，加入预算复盘、视觉目标选择与白盒试玩代理。技能桥里写死的路径、步骤与模板需要逐条对照新版。

## Decision

开发宿主与默认打包浏览器验证使用 `0.2.1-rc.2`，Cordis / Schemastery 及 Cordis 辅助包回到稳定版（`4.0.5` / `3.18.5`、include `1.0.10`、loader `1.0.6`、group `1.0.5`、cosmokit `1.8.6`）。README、包 README 与发布文档的默认安装命令改为 `0.2.1-rc.2`；`0.2.0-rc.2` 作为更早的支持线继续由 `test:dsh:rc` 做完整打包验证。`engines.dsh` 与 DSH peer 范围不变（已覆盖 0.2.1 预发布）。不再单独宣传 alpha 线。

Oh Story 与 NovelToGame 通过既有同步命令从发布标签的干净克隆同步，不动本地开发中的 checkout。Drama 0.9.0 与 video-recap 0.6.2 维持原固定点。上游新增的宿主项目说明合并脚本 `story-setup/scripts/merge-project-instructions.py` 加入同步排除与 parity 禁入清单。

技能桥按 0.9.0 逐条更新：回复与等后台角色时都用作者的语言；`story` 入口、`story-setup` 采用上游统一的「书目录判定」与长短篇规则，多书时写 `.active-book`；导入改按 `structure-mapping-long.md` 的步骤描述并加入 `outline_view.py --check --strict`，导完给出续写说法；原生长篇扫榜一次问齐条件、推荐选题附对标书；原生短篇扫榜接收征稿要求、使用六类情绪与平台对照。游戏技能桥让白盒试玩的「新代理」走当前 Preset 可见的 DSH 子代理，`director` 模式先问真实玩家，并要求首次可玩即告知用户。

发布前按 `new-user-product-audit` 方法让四个新用户角色在全新 DSH 上使用打包候选版，真实 DeepSeek 运行；审计发现的插件缺陷在同一版本内修复，见 [随包检查脚本与短篇工作台](../bug-fix/2026-10-19-bundled-checkers-and-short-story-workbench.md)。

## Alternatives considered

- 保留 alpha.4 作为显式试用线、只把默认线改到 rc.2：多一条线能覆盖仍停在 alpha 的用户，但 rc.2 是同一 0.2.1 序列更新的版本，engines 范围已接受全部 0.2.1 预发布，继续为旧 alpha 跑完整浏览器验证收益很小。
- 默认线保持 `0.2.0-rc.2`：对已安装用户最稳，但 npm `latest` 已是 `0.2.1-rc.2`，新用户直接 `npx @deepseek-ai/dsh` 得到的就是新线，README 继续固定旧版会让说明与默认行为不一致。

## Consequences

收益：作者默认装到 npm 当前稳定预发布宿主，获得 Oh Story 0.9.0 与 NovelToGame 0.6.0；技能桥不再引用已删除的步骤编号与资料。代价：发布门禁仍需两条宿主线的完整打包浏览器验证；alpha.1–alpha.4 虽在兼容范围内，本版不再重新验证；游戏改编新增的子代理试玩会拉长 quick 模式耗时，且 DSH 原生子代理停止不连带（审计 P1，归宿主，待向上游反馈）。

## Verification

- alpha.4 → rc.2：插件引用的 20 个 `@deepseek-ai` 包类型声明逐字节一致，冒烟用到的 DOM 选择器全部仍在；全仓 typecheck、DSH boundary 与真实 Cordis 契约测试通过。
- 候选源码 `ba64b81` 在干净克隆中 `pnpm verify:release` 退出 0，打包 Chrome 在 `0.2.1-rc.2` 与 `0.2.0-rc.2` 均 `"ok": true`。
- 新用户审计（2026-10-19，四角色，真实 DeepSeek）：主任务均完成，无 P0；报告在本机审计运行目录 `report.md`。审计发现的四项插件缺陷修复后用重新打包的候选版复测通过。
- 修复后源码 `bac50b1` 运行 `pnpm test:dsh:real`：DSH `0.2.1-rc.2`、`deepseek-official/deepseek-flash` 返回 `ok: true`，2 个必需 Role 均成功，持久事件 130 / 66，项目摘要不变；凭据只在 0600 临时文件中，未出现在日志。
- 最终源码再跑一次干净克隆 `pnpm verify:release`，结果见本次 PR。
