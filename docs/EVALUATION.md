# 质量与评测（P2-A 骨架）

> 状态：确定性结构评测骨架已实现（2026-10-21）。**尚未运行任何真实 provider / 付费模型评测**，因此本文件与工具都不给出模型生成质量结论。
> 本工具当前**不是发布门禁**：`scripts/eval-quality.test.mjs` 的小规模工装测试随 `pnpm verify` 运行，防止脚本回归；但没有真实语料评测接入 verify / CI，也不设置发布阻断。只有在真实语料、真实基线和真实 provider 运行都建立之后，才讨论是否升级为门禁。

## 1. 目的与边界

`scripts/eval-quality.mjs` 比较两套已生成产物目录：

- `--base`：旧版本、上游或人工认可的基线；
- `--candidate`：待检查的候选版本。

它按 `scripts/eval/corpus.json` 的固定语料清单，在两边分别检查文件存在性、文本字符数、Markdown 标题、占位符、重复标题、伏笔标记和短剧五文档完整性，按 P0/P1/P2 分类回归，输出 JSON 报告与可选 Markdown 摘要。

**它明确不做什么：**

- 不调用任何模型、provider、媒体服务或网络；
- 不生成、改写、评分任何创作内容；
- 不解析 `.mp4`、图片、音频等二进制内容；
- 不评价叙事质量、事实一致性、文风、镜头可看性、美术效果或配音效果；
- 不替代人工审稿，也不把“结构通过”说成“模型质量通过”。

所有报告都带固定标签 **“结构评测，不含模型生成质量”**，并声明 `modelRuns: false`、`paidModelCalls: 0`、`networkCalls: 0`。

## 2. 确定性与需要付费运行的边界

| 能力 | 属性 | 说明 |
|---|---|---|
| 文件存在、空文件、字符数 | 确定性 | 只读本地产物，结果可重复 |
| Markdown ATX 标题存在与重复 | 确定性 | 按行解析，不做语义理解 |
| TODO / TBD / 待补等占位符 | 确定性 | 字面量、大小写不敏感匹配 |
| 伏笔标记数量 | 确定性 | 统计固定字面量出现次数，不判断伏笔质量 |
| 短剧五文档完整性 | 确定性 | 只检查五个文件名与非空 |
| badcase 数量统计 | 确定性 | 只读清单，不执行修复 |
| 报告 JSON / Markdown | 确定性 | 同一输入结构一致；`generatedAt` 除外 |
| 故事是否好看、是否连贯 | 需真实模型/人工 | 本工具不测 |
| 人物一致性、设定冲突、伏笔是否回收 | 需真实模型/人工 | 本工具只数标记，不读语义 |
| 图片/视频提示词是否可生成、成片质量 | 需真实 provider/付费运行 | 本工具只查文件存在与字符数 |
| 配音、字幕、剪辑、发布适配 | 需真实 provider/人工 | 本工具不解析媒体 |

后续如果引入模型评审，必须把“模型评审结果”和“确定性结构结果”分报告、分字段保存；不能把模型打分写进当前 JSON 的 `samples` / `verdict`，也不能在本工具里静默调用付费接口。

## 3. 文件与目录布局

```text
scripts/
  eval-quality.mjs          # CLI + 评测实现（Node 24，零依赖）
  eval-quality.test.mjs     # node:test 集成测试
  eval/
    corpus.json             # 语料清单（7 个合成样本）
    rubrics.json            # 确定性评分规则
    badcases.json           # badcase 清单（schemaVersion 1）
docs/
  EVALUATION.md             # 本文件
```

运行时目录由调用者准备，工具只读：

```text
<base>/
  novel-rain-station/
    正文/第001章_雨夜.md
    ...
  drama-ep001/
    剧本.md
    视觉设定.md
    分镜.md
    图片提示词.md
    视频提示词.md
  game-jinping-prototype/
    PRODUCT_BRIEF.md
    build/index.html
    build/app.js
    qa/verification.json
  video-recap-rain/
    narration.json
    recap_run_manifest.json
    成片/recap_demo.mp4
<case>/
  ... 同样的样本目录 ...
```

`corpus` 中的 `id` 同时是 `--base` / `--candidate` 下的样本目录名。样本目录在任一一边缺失都视为输入错误（退出码 2），不会当成“空样本”静默通过。

短剧样本把**单集目录**当作样本根：五个核心文档直接位于样本目录下。真实项目如果是 `剧集/EP001/`，请把该目录内容落到 `<root>/drama-ep001/`，不要把整个项目根直接当成样本根；长篇样本则以项目目录为样本根（`正文/`、`大纲/` 在其下）。

## 4. 语料清单 `corpus.json`

顶层为 `{ schemaVersion: 1, samples: [...] }`。每个样本字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 样本目录名，ASCII/中文均可，但不能含路径分隔符、`..`、Windows 保留字符 |
| `kind` | 是 | `novel` / `drama` / `game` / `video-recap` |
| `requiredFiles` | 是 | 相对样本目录的文件路径，使用 `/`；不能绝对路径、不能含 `..` |
| `minChars` | 否 | 数字表示所有 `requiredFiles` 的最小非空白字符数；对象表示逐文件最小字符数 |
| `requiredHeadings` | 否 | `{ "文件": ["# 标题"] }`；标题按去掉 `#` 后的文本比较 |
| `forbiddenPatterns` | 否 | 该样本额外追加的禁用字面量，与规则里的模式合并 |

示例：

```json
{
  "id": "novel-example",
  "kind": "novel",
  "requiredFiles": ["正文/第001章.md", "大纲/细纲.md"],
  "minChars": {
    "正文/第001章.md": 1200,
    "大纲/细纲.md": 300
  },
  "requiredHeadings": {
    "正文/第001章.md": ["# 第001章 雨夜"],
    "大纲/细纲.md": ["# 细纲"]
  },
  "forbiddenPatterns": ["TODO", "TBD", "待补"]
}
```

语义约定：

- **字符数**：去掉空白后的 Unicode 码点数，不等于 token 数，也不等于平台字数。
- **文本文件**：按扩展名判断（`.md`、`.txt`、`.json`、`.html`、`.js`、`.yaml` 等）；`.mp4` 等二进制只检查存在与字节大小。
- **`minChars` / `requiredHeadings` 只适用于文本文件**：对二进制文件声明这两项会按“非文本 / 标题缺失”失败，这是有意行为，不会静默跳过。
- **标题**：只识别 Markdown ATX 标题（`#` 到 `######` 加空格）；比较前去掉标题标记、行尾 `#` 并压缩空白。
- 路径统一以 `/` 表示；反斜杠会被规范化，但报告与清单应使用 `/`。

当前内置 7 个样本：

1. `novel-rain-station`：5 章正文 + 细纲，长篇连续章节骨架；
2. `novel-archive-city`：3 章正文 + 世界观；
3. `drama-ep001`：短剧五文档（剧本、视觉设定、分镜、图片提示词、视频提示词）；
4. `drama-ep002`：第二集五文档；
5. `game-jinping-prototype`：`PRODUCT_BRIEF.md` + `build/index.html`、`build/app.js` 构建标记 + `qa/verification.json`；
6. `video-recap-rain`：`narration.json` 解说稿 + 运行清单 + `成片/recap_demo.mp4` 最终成片标记；
7. `video-recap-rain-cut`：`clip_plan.json` + `narration.json` + `成片/recap_cut_demo.mp4`。

这些清单只描述结构，不附带真实作品内容；仓库里不提交真实用户产物。

### 新增语料

1. 在 `scripts/eval/corpus.json` 的 `samples` 里新增条目，选一个稳定的 `id`；
2. 在 `--base` 与 `--candidate` 两套目录下都建立同名样本目录，放入合成或已脱敏产物；
3. 确认 `requiredFiles`、`minChars`、`requiredHeadings` 指向真实存在的相对路径；
4. 用 `--no-badcases` 先跑一次，确认没有拼写错误和路径错误；
5. 把该样本加入真实回归基线前，先人工检查报告里的通过/失败是否符合预期。

## 5. 评分规则 `rubrics.json`

顶层为 `{ schemaVersion: 1, rubrics: [...] }`。每条规则字段：

| 字段 | 说明 |
|---|---|
| `id` | 规则唯一标识 |
| `name` | 人类可读名称 |
| `severity` | `P0` / `P1` / `P2`；只有 P0/P1 回归会让退出码变成 1 |
| `appliesTo` | 适用的 `kind` 列表 |
| `check` | 确定性检查定义 |

内置规则：

| id | 严重度 | 适用 | 检查 |
|---|---|---|---|
| `required-files` | P0 | 全部 | `requiredFiles` 全部存在且非空 |
| `min-chars` | P1 | 全部 | 每个声明的文件达到最小字符数 |
| `required-headings` | P1 | 全部 | 每个声明的标题存在 |
| `forbidden-placeholders` | P1 | 全部 | 不出现 TODO / TBD / 待补 / 待定 / FIXME 及样本追加模式 |
| `duplicate-headings` | P2 | novel / drama / game | 同一文件内的重复标题数不超过 1（跨文件同名标题不算重复） |
| `novel-foreshadow-markers` | P2 | novel | `伏笔` 字面量出现不少于 3 次 |
| `drama-five-doc-completeness` | P0 | drama | 五个核心文档存在且非空 |

支持的 `check.type`：

| type | 参数 | 行为 |
|---|---|---|
| `files-present` | `source: "sample.requiredFiles"` 或 `files: [...]`；可选 `nonEmpty` | 检查缺失/空文件 |
| `min-chars` | `source: "sample.minChars"` | 逐文件比较字符数；缺失文件或非文本文件记为失败 |
| `required-headings` | `source: "sample.requiredHeadings"` | 比较规范化标题文本 |
| `forbidden-patterns` | `patterns: [...]`、`includeSamplePatterns` | 字面量、大小写不敏感，按出现次数统计 |
| `duplicate-headings` | `maxDuplicates: N`，可选 `files` | 按文件统计重复标题（每个文件内总数 - 1 后求和）；不同文件出现同名标题是正常结构 |
| `marker-count` | `pattern`、`minCount`，可选 `files` | 统计固定字面量出现次数 |

`P0` / `P1` / `P2` 的用法约定：

- **P0**：产物不成立，例如必备文件或短剧五文档缺失；
- **P1**：明显不可交付，例如空章、必备标题缺失、占位符残留；
- **P2**：结构健康度信号，例如重复标题、伏笔标记偏少；只记录，不阻塞退出码。

### 新增规则

1. 在 `rubrics.json` 的 `rubrics` 里新增条目，`id` 唯一；
2. 选择已有 `check.type`，不要再写模型调用或网络调用；
3. 设定 `appliesTo`，避免把所有 kind 都套上不适用的规则；
4. 若规则需要新的检查类型，必须同时在 `eval-quality.mjs` 实现并补 `eval-quality.test.mjs`；
5. 回归测试要覆盖：基线通过、候选失败、报告中的严重度分类。

## 6. Badcase 清单 `badcases.json`

结构：

```json
{
  "schemaVersion": 1,
  "cases": [],
  "exampleCase": {
    "id": "EXAMPLE-2026-001",
    "kind": "novel",
    "sourceVersion": "0.1.18",
    "symptom": "候选版本的第 2 章只有标题，正文为空。",
    "evidence": ["第002章_铜钥匙.md 的字符数为 0"],
    "repro": ["准备 base/candidate 产物目录", "运行 eval-quality.mjs", "查看 min-chars 检查"],
    "expected": "第 002 章存在且非空，字符数不低于清单要求。",
    "status": "open"
  }
}
```

- `cases` 只放已经确认过的 badcase；`exampleCase` 是字段说明，不计入统计。
- 必填字段：`id`、`kind`、`sourceVersion`、`symptom`、`evidence`、`repro`、`expected`、`status`。
- `evidence` / `repro` 可以是非空字符串或非空字符串数组；工具会归一化成数组。
- 当前 `cases` 为空，报告里会显示 `total: 0` 和 `documentedExample: true`。
- 默认加载 `scripts/eval/badcases.json`；文件不存在时报告标记“未加载”，不算输入错误；显式 `--badcases <path>` 指向不存在文件则是退出码 2。
- **不要把真实用户内容、真实工作区路径、密钥或未脱敏会话写进本文件。** 证据只写最小复现信息。

### 新增 badcase

1. 复现问题，确认是候选相对基线的回归或已知缺陷；
2. 在 `cases` 里追加一条，填写八个必填字段；
3. 证据指向可复现的样本 id、规则 id 或报告字段，不贴大段正文；
4. 修复后把 `status` 从 `open` 改为 `fixed`，不要删除历史记录；
5. 跑一次工具，确认报告的 `badcases.total` 与 `byStatus` 更新。

## 7. CLI 用法

```bash
node scripts/eval-quality.mjs \
  --base   /path/to/baseline \
  --candidate /path/to/candidate \
  --out    /tmp/eval-report.json \
  --markdown /tmp/eval-report.md
```

参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--base <dir>` | 必填 | 基线产物根目录 |
| `--candidate <dir>` | 必填 | 候选产物根目录 |
| `--corpus <path>` | `scripts/eval/corpus.json` | 语料清单 |
| `--rubrics <path>` | `scripts/eval/rubrics.json` | 评分规则 |
| `--badcases <path>` | `scripts/eval/badcases.json` | badcase 清单；显式路径缺失报错 |
| `--no-badcases` | 关闭 | 跳过 badcase 加载 |
| `--out <path>` | `-`（stdout） | JSON 报告输出路径 |
| `--markdown <path>` | 不生成 | Markdown 摘要输出路径；`-` 表示 stdout |
| `--help` | - | 打印帮助 |

注意：

- `--out -` 与 `--markdown -` 不能同时使用（两者都抢 stdout）；
- 默认 JSON 直接写 stdout，适合管道；写文件时会自动创建父目录；
- 工具只读 `--base` / `--candidate`，不会修改、删除或重排产物。

## 8. 退出码

| 退出码 | 含义 |
|---|---|
| `0` | 没有候选侧 P0/P1 回归 |
| `1` | 候选侧出现至少一条 P0/P1 回归 |
| `2` | 用法错误或输入错误 |

输入错误包括：缺 `--base` / `--candidate`；根目录或样本目录不存在；语料/规则/badcase JSON 非法；语料路径含 `..` 或绝对路径；规则类型未知等。

两个容易误解的点：

1. **P2 回归不改变退出码。** 报告会记录 `verdict.status: "regressed-p2-only"` 和 P2 明细，但退出码仍为 0。
2. **基线本身失败、候选同样失败，不算回归。** 这种情况退出码仍为 0，但 `verdict.status` 会显示 `no-regression-baseline-failures`，并给出候选 P0/P1 未通过数量。报告不会把这种情况称为 clean。

## 9. 报告内容

JSON 顶层字段：

- `label` / `disclaimer` / `deterministic` / `modelRuns` / `paidModelCalls` / `networkCalls`：诚实性元数据；
- `inputs`：本次使用的绝对路径；
- `corpus` / `rubrics` / `badcases`：输入摘要与计数；
- `samples`：逐样本检查结果；
- `aggregate`：聚合与回归分类；
- `verdict`：结论与退出码。

每个样本包含：

- `summary.base` / `summary.candidate` / `summary.delta`：通过数、失败数、字符数、缺失文件/标题数、空文件数、禁用词命中数；
- `charCounts`：总字符数与逐文件字符数；
- `missingFiles` / `missingHeadings`：`base`、`candidate`、`added`、`removed`；
- `forbiddenHits`：基线、候选、增量；
- `checks`：每条规则的 `pass` / `persistent` / `regression` / `fixed` 状态与两侧原始结果；
- `regressions` / `improvements` / `skippedRubrics`。

聚合字段包括 `aggregate.delta`（passCount、failCount、charCount、missingFileCount、emptyFileCount、missingHeadingCount、forbiddenHitCount）以及 `regressionsBySeverity` / `improvementsBySeverity`。

Markdown 摘要包含结论、聚合表、样本表、回归明细、改进明细、badcase 计数和“未覆盖范围”。摘要同样带“结构评测，不含模型生成质量”标签。

## 10. 当前限制

- **没有真实 provider 运行。** 本轮只验证了工具本身和临时合成 fixture，没有调用模型，也没有付费媒体任务。
- **没有真实全量语料。** `corpus.json` 是 7 个结构样本清单，不包含真实作品；仓库内没有可用的真实基线与候选产物。
- **不是发布门禁。** 没有真实语料评测接入 `pnpm verify`、GitHub Actions 或发布脚本；只有 `scripts/eval-quality.test.mjs` 的小规模工装测试随 `pnpm verify` 运行，防止脚本本身回归。在真实语料和真实运行建立之前，不应据此阻止发布。
- **结构信号不等于质量。** 字符数多不代表写得好；标题齐全不代表内容连贯；伏笔标记数量不代表伏笔有效。
- **文本统计有边界。** 只识别 Markdown ATX 标题；字符数不是 token 数；禁用词是字面量匹配，不做同义词或语义识别。
- **媒体未解析。** `.mp4` 等二进制只检查存在与字节大小，空文件拦截也不代表成片可播放。
- **报告可能含文本摘录。** 禁用词命中会在报告里带上命中行的 160 字摘录；对真实产物运行后，不要把报告直接提交到仓库或公开渠道，除非已脱敏。
- **P2 不阻塞。** 这是有意设计，避免结构健康度信号阻断发布；需要阻塞时应在规则文件里改成 P1，而不是在代码里偷偷加条件。

## 11. 升级为门禁的条件

至少满足以下条件后，才讨论把本工具接入门禁：

1. 四类产物（长篇、短剧、游戏、视频解说）都有真实、稳定、已脱敏的语料与基线；
2. 每类至少有多个真实版本可用于校准阈值，字符数/标题/占位符规则不会产生大量误报；
3. 真实 provider 运行有独立记录、预算与清理流程，且不与确定性报告混在一起；
4. 人工评审与模型评审的结果有独立 schema，可追溯到具体样本与版本；
5. `pnpm verify` 的接入方式、失败回滚和跨平台路径行为都经过验证。

在这些条件满足前，本工具只作为开发期的结构回归辅助信号。

## 12. 本轮验证

```bash
node --test scripts/eval-quality.test.mjs
```

覆盖：干净基线/候选通过、缺失必备文件触发 P0、禁用占位符触发 P1、仅 P2 回归仍退出 0、CLI 用法/输入错误退出 2、默认 stdout JSON、报告含聚合增量。测试使用 `os.tmpdir()` 下的临时目录，测试结束自动清理。

限制：测试使用的是按 `corpus.json` 生成的合成 fixture，不是真实模型产物；**没有进行任何真实 provider 或付费模型评测**。
