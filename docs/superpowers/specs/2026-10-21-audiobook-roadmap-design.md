# 下一阶段路线与有声剧设计（N1–N4 / P3）

- 日期：2026-10-21
- 状态：已确认方向，待实施计划拆分
- 适用仓库：`dsh-miaowu`（`@dsh-miaowu/dsh`）
- 关联：`docs/TODO-dsh-miaowu.md`、`docs/VALIDATION.md`、`docs/FORK-FEATURES.md`

## 1. 背景与目标

P0–P2 已交付：发布身份与安装路径、状态安全、自诊断、状态版本与迁移、连续性驾驶舱、确定性结构评测和原始原语性能基准。P3 仍只有边界描述，没有成文范围和验收标准。

本设计同时解决两件事：

1. 给 P3 之前的工作排出明确顺序（N1 发布收口、N2 P1-B 收尾与 G2、N3 P2 硬化），并写明 P3 的进入条件。
2. 新增有声剧（有声小说 / 有声书）子系统：把小说正文转为多角色、带 BGM/音效、带时间轴字幕与发布包的分章音频。

### 1.1 目标

- 从同工作区的小说 `正文/` 生成分章有声剧，支持旁白 + 多角色对白。
- TTS 使用 **OpenAI-compatible 通用端点**，不绑定单一厂商。
- 支持本地 BGM/音效素材库与外部音频生成 API 两类资产来源。
- 输出分章 MP3、M4B、SRT/LRC、封面与发布清单。
- 长任务可暂停、恢复、按段重生成；内容寻址缓存避免重复计费。
- 成本可见、预算可控；TTS 调用必须显式确认。
- 遵守插件边界：不写 DSH 会话、`workspace.json`、`~/.dsh`；密钥不进入工作区。

### 1.2 非目标（首期明确不做）

- 不做完整 DAW / 自由波形剪辑器；时间轴以“段落锚定 cue 列表”实现。
- 不做声音克隆；参考音频/克隆留到后续版本，且必须显式确认权利。
- 不做多端、云同步、实时协作（属于 P3 条件项）。
- 不做漫画、翻译、版权签约等改编 P3；有声由本设计的 N4 承接。
- 不默认调用 LLM 做角色识别或改写；Agent 辅助必须是显式、可关闭、可计费的独立动作。
- 不做短视频切片联动；如需，另立子项目。

## 2. 阶段路线与门禁

### 2.1 N1 发布收口（先于一切新功能）

交付：

- npm 首次发布（granular `NPM_TOKEN`）。
- 0.1.17 / 0.1.18 预构建包发布（当前只有源码）。
- 为 `main` 开启分支保护，满足 `ci-proof` 的 `branches/main.protected === true`。
- 启用当前 `disabled_manually` 的 Release 工作流。

退出条件：npm 包可安装；GitHub Release 资产可下载；Release 工作流能对 `miaowu-vX.Y.Z` 正常执行；不需要改动功能代码。

### 2.2 N2 P1-B 收尾与 G2

交付：

- 高风险写前自动快照钩子（编辑器历史快照之外的整书/整项目快照）。
- 交接清单导入 / 校验（当前只生成 manifest）。
- 连续性概览的缓存/增量，避免备份数量增长时每次全量扫描。
- 100 个项目、连续两周的 G2 实盘。

退出条件（G2）：无 P0；无宿主状态写入；诊断与驾驶舱在实盘中可用；快照/交接可恢复或可验证；性能与磁盘增长在可接受范围。

### 2.3 N3 P2 硬化

交付：

- 真 provider 质量评测（可选、付费、需显式授权，不进入默认门禁）。
- `read-hash-1m` 537.32 ms 超 500 ms 预算的定位与结论（优化或记录为已接受的原始原语上限）。
- esbuild 多入口拆包与客户端包体控制（当前 372,317 / 400,000 字节）。**2026-10-24 决策：暂不拆包，客户端预算放宽到 600,000 字节（见 `docs/TODO-dsh-miaowu.md`）。**
- 保险库 UI、短剧生产素材/分镜板浮动面板、`availableActions` 服务端下发。
- `scripts/native-dsh-smoke.ts` 的 41 个既有类型错误清零。

退出条件：`pnpm verify` 与双宿主冒烟全绿；包体不超预算；P2 债务有明确关闭或登记。

### 2.4 N4 有声剧

分四期：A 纵向切片、B 多角色、C 完整有声剧、D 批量化与质量。详见第 8 节验收门。N4 不依赖 P3。

### 2.5 P3 条件项

P3 仍挂起，不预做。进入条件必须同时满足：

1. G2 已通过，且 N3 的 P2 债务已完成或明确登记。
2. 出现明确的业务诉求：多端、云同步或实时协作中的至少一项。
3. 单独写设计文档与实施计划，明确数据归属、冲突合并、权限与迁移方案。

任何一项不满足，不启动 P3 实现。

## 3. N4 架构选择

### 3.1 备选路线

| 路线 | 优点 | 代价 |
|---|---|---|
| A. TypeScript 宿主服务 + 路由 + 工作台面板 | 与现有媒体、备份、诊断、任务模型一致；可单测；TTS 只是 HTTP | 需要新增 ffmpeg/ffprobe 预检与混音服务 |
| B. 复用 video-recap Python 管线 | provider、缓存、幻觉校验已有经验 | 视频导向、Python 依赖重、面板集成差、职责错位 |
| C. 独立外部 worker | 隔离最好 | 部署、状态同步、跨进程恢复复杂 |

### 3.2 决策

采用 **A**。借鉴 B 的 provider 缓存、时长校验和“拒绝样本保留”思路，但不复用其 Python 管线。

组件划分：

- `services/audiobook/audiobook-contract.ts`：schemaVersion、项目/脚本/任务/发布清单类型。
- `services/audiobook/audiobook-project.ts`：项目发现、配置校验、路径安全。
- `services/audiobook/audiobook-script.ts`：正文 → 旁白/对白段的确定性切分。
- `services/audiobook/audiobook-tts.ts`：OpenAI-compatible 适配、能力探测、重试、QC、成本。
- `services/audiobook/audiobook-cache.ts`：内容寻址段缓存与回执。
- `services/audiobook/audiobook-assets.ts`：本地素材库与外部生成适配器。
- `services/audiobook/audiobook-mix.ts`：cue 时间轴、响度、混音。
- `services/audiobook/audiobook-export.ts`：MP3/M4B/SRT/LRC/发布清单。
- `services/audiobook/audiobook-jobs.ts`：章节级任务、检查点、恢复。
- `services/audiobook/audiobook-route.ts`：`/oh-story/audiobook/*` 路由。
- `client/features/audiobook-feature.tsx` + `.css`：工作台「有声剧」面板。
- 轻量 `audiobook` Skill：只做 Agent 侧脚本/角色整理，不直接持有密钥、不默认调用模型。

复用：

- `/oh-story/media` 的 Range 播放（已支持 mp3/wav/m4a/aac/flac/ogg/opus）。
- 备份 full 与状态盘点；`有声剧/` 必须加入创作目录、备份创作根和文件树白名单。
- 诊断预检的“只报告存在性、不读取密钥值”模式。
- 任务 run/checkpoint 的语义；音频任务使用独立的章节级 job 文件，避免把长任务塞进单个 HTTP 请求。

## 4. 数据布局与 schema

```text
有声剧/<书名>/
  project.json              # schemaVersion 1；源书、选章、角色、TTS 非密钥配置、cue、导出
  脚本/第0001章.json         # 段落级脚本（旁白/对白、speaker、文本、源偏移）
  音频/第0001章.mp3
  音频/全书.m4b
  字幕/第0001章.srt
  字幕/第0001章.lrc
  素材/音乐/*.mp3|wav|ogg
  素材/音效/*.mp3|wav|ogg
  素材/授权.json            # 每个素材的来源、许可证、允许用途、署名
  封面/cover.jpg
  发布/发布清单.json
.oh-story/audiobook/
  cache/<sha256>/audio.<ext>
  cache/<sha256>/meta.json  # 请求指纹与回执，不含密钥
  jobs/<jobId>.json         # 进度、检查点、失败段、成本
```

约束：

- 源书必须位于同工作区 `正文/`；`source.bookRoot` 由 `.active-book` 或单书检测决定，多书歧义时拒绝创建项目。
- `有声剧/` 是创作目录，但不得替代 `正文/`；纯外部文本导入不属于首期。
- `.oh-story/audiobook/` 只存派生缓存与任务状态，不是用户原稿；清理必须显式确认。
- 所有 JSON 写入 `schemaVersion: 1`，写入采用现有 CAS/原子写模式。

### 4.1 `project.json`

```json
{
  "schemaVersion": 1,
  "source": {
    "bookRoot": "正文/书名",
    "chapters": ["正文/书名/第0001章.md"]
  },
  "tts": {
    "baseUrl": "https://api.example.com/v1",
    "model": "tts-1",
    "responseFormat": "mp3",
    "speed": 1.0,
    "pricePerMillionChars": 15,
    "maxCharsPerChapter": 20000,
    "maxCharsPerBook": 400000,
    "concurrency": 2
  },
  "cast": [
    { "id": "narrator", "name": "旁白", "kind": "narrator", "voice": "alloy" },
    { "id": "role-linfan", "name": "林帆", "kind": "character", "voice": "verse" }
  ],
  "cues": [
    {
      "id": "cue-001",
      "chapter": "第0001章",
      "asset": "素材/音乐/theme.mp3",
      "startSegment": "<segment-id>",
      "offsetMs": 0,
      "fadeInMs": 500,
      "fadeOutMs": 1000,
      "gainDb": -6,
      "duckDb": -12
    }
  ],
  "export": {
    "mp3BitrateKbps": 192,
    "m4bBitrateKbps": 128,
    "sampleRate": 44100,
    "channels": 2,
    "loudnessLufs": -16,
    "truePeakDbtp": -1.5,
    "subtitles": ["srt", "lrc"]
  },
  "rights": { "voiceCloning": false }
}
```

规则：

- `baseUrl` 必须是 `https:`；仅允许 loopback 的明文 `http://127.0.0.1`、`http://localhost`、`http://[::1]`。拒绝 URL 内嵌凭证、非 http(s) 协议与跨主机重定向。
- 密钥只来自环境变量，见第 5.1 节；`project.json`、日志、发布清单、缓存回执都不得包含密钥。
- `cast` 至少一个 `narrator`；角色 `voice` 为非空字符串，由端点决定可用值。
- `source.chapters` 为空数组表示当前书全部章节；显式列表必须按源路径存在。
- `cues.startSegment` 必须引用本章脚本中的稳定 segment ID；引用不存在时 UI 标红并阻止导出。

### 4.2 章节脚本

```json
{
  "schemaVersion": 1,
  "chapter": "第0001章",
  "sourcePath": "正文/书名/第0001章.md",
  "sourceSha256": "<64-hex>",
  "segments": [
    {
      "id": "s-<12-hex>",
      "kind": "narration",
      "speakerId": "narrator",
      "text": "……",
      "sourceStart": 0,
      "sourceEnd": 42,
      "direction": { "speed": 1.0, "style": "平静" }
    }
  ]
}
```

- segment ID = `s-` + `sha256(kind|speakerId|text|sourceStart)` 的前 12 个十六进制字符。文本或说话人变化会使 ID 变化，相关 cue 变为悬空，UI 必须显示。
- 确定性切分：段落 → 中文引号对白/旁白 → 句末标点；保持源偏移。说话人默认为 `narrator` 或 `unknown`，由角色表手工指派。
- `sourceSha256` 与源文件不一致时，面板提示重新解析；重新解析不得静默覆盖手工角色指派，必须先展示差异并确认。

### 4.3 素材授权

`素材/授权.json`：

```json
{
  "schemaVersion": 1,
  "assets": [
    {
      "path": "素材/音乐/theme.mp3",
      "source": "本地购买",
      "license": "CC-BY-4.0",
      "allowedUse": ["audiobook", "commercial"],
      "attribution": "作者 / 来源链接"
    }
  ]
}
```

导出前逐项核对被 cue 引用的素材；缺失、`license` 为空或 `allowedUse` 不含当前用途时阻止导出。外部生成资产记录 provider、模型、prompt 摘要与回执；无法确认权利时标为 `unverified` 并阻止发布包导出。

### 4.4 发布清单

`发布/发布清单.json` 至少包含：

- `schemaVersion`、`generatedAt`、`book`、`projectVersion`。
- `files[]`：相对路径、字节数、sha256、时长（毫秒）。
- `chapters[]`：序号、标题、音频参数、字幕文件。
- `cast[]`：角色 ID、显示名、voice（不含密钥）。
- `licenses[]`：素材路径、许可证、署名。
- `providerReceipts[]`：endpoint 主机、model、voice、字符数、请求数、估算成本；不含密钥与完整 URL 查询串。
- `cost`：估算与实际字符数、失败重试次数。
- `checksum`：按文件路径排序后，对 `path\0sha256` 拼接结果取 sha256。

清单必须可本地复算（文件 sha256 与排序后的 manifest checksum）。

## 5. TTS 契约

### 5.1 配置与密钥

环境变量：

- `OH_STORY_TTS_BASE_URL`
- `OH_STORY_TTS_API_KEY`
- `OH_STORY_TTS_MODEL`

优先级：项目 `project.json` 的 `baseUrl` / `model` 覆盖环境变量；密钥只读环境变量，不落盘。预检只报告 `present` / `missing`，不读取或回显值。

### 5.2 请求

`POST {baseUrl}/audio/speech`：

```json
{
  "model": "tts-1",
  "input": "待合成文本",
  "voice": "alloy",
  "response_format": "mp3",
  "speed": 1.0
}
```

- 标准字段固定为 `model / input / voice / response_format / speed`。
- `instructions` 等非标准字段仅当端点能力探测显式声明支持时发送；能力探测结果记录在项目状态中，不写密钥。
- 响应必须是 `audio/*` 字节流；限制最大响应字节（默认 50 MiB），超限按失败处理。
- 使用 `redirect: "error"`，避免凭证被重定向到其他主机。
- 超时：单请求默认 120 秒；连接/读取超时分别计。
- 重试：408 / 429 / 5xx 最多 3 次，指数退避 + 抖动；4xx（除 408/429）不重试。重试耗尽后把段标记失败，不写缓存。
- 错误信息记录 HTTP 状态、端点主机、模型、段 ID、重试次数；不记录 `Authorization` 与密钥。

### 5.3 切分与缓存

- 文本按句子切分到单请求上限（默认 2,000 字符）；切分保持段内顺序，拼接处插入可配置停顿。
- 缓存键 = `sha256(baseUrlOrigin|model|voice|speed|responseFormat|instructions|text)`；不含密钥、时间戳或本机路径。
- 命中缓存不发起 HTTP 请求；voice/model/speed 变化只失效相关段。
- 每段缓存保存 `audio.<ext>` 与 `meta.json`；`meta.json` 记录请求字段、响应 content-type、字节数、估算时长、回执 ID（如有）、创建时间。
- 失败或被 QC 拒绝的音频不进入可复用缓存；被拒样本单独保存在 `rejected/`，供试听与排障。

### 5.4 时长与质量校验

- 以 `chars / expectedCharsPerSecond` 估算朗读时长，默认 4.5 字/秒，可配置。
- 扣除首尾静音后，若实际时长与估算的比值低于 0.5 或高于 1.8，视为可疑：重试一次；仍可疑则段失败，保留被拒音频。
- 用 `ffprobe` 验证解码时长、采样率与声道；无法解码即失败。
- 单章完成后检查总时长与段数，缺段、重复段、空音频均阻止导出。

### 5.5 成本与预算

- 估算字符数 = 所有待合成段的 `text` 字符数；成本 = 字符数 / 1,000,000 × `pricePerMillionChars`。
- 启动任务前返回 dry-run 结果：章节、段数、字符数、缓存命中数、预计请求数、预计成本。
- `maxCharsPerChapter` / `maxCharsPerBook` 是硬上限；超过时拒绝启动（409），不静默缩小范围。
- 任务启动必须 `confirm: true`；响应记录实际请求数与失败重试次数。

### 5.6 并发与任务

- 并发默认 2，可配置到 4；按段串行写入缓存，按章汇总。
- 每个章节一个 job：`queued / running / paused / failed / completed`。
- 每完成一个段原子更新检查点；进程重启后 `running` 转为 `paused`，必须显式恢复。
- 取消只阻止后续请求，不删除已生成缓存；已完成段仍可复用。
- 同一项目同一章节只允许一个活动 job；冲突返回 409。

## 6. BGM / 音效

### 6.1 本地素材库

- 支持 mp3 / wav / ogg；单文件上限可配置。
- 导入时必须写 `素材/授权.json`；缺授权只能在面板试听，不能进入 cue 或导出。
- cue 以段落 ID 锚定，记录起始偏移、淡入/淡出、增益、BGM 闪避量。
- 删除被引用素材时阻止保存，并列出引用该素材的 cue。

### 6.2 外部生成

- 统一 `AudioAssetProvider` 接口：`id`、`capabilities`、`generate(request)`、`estimateCost(request)`。
- 首期实现一个本地素材 provider（无生成）与一个外部生成适配器；优先复用现有 ComfyUI music 通道，其他供应商按同一契约扩展。
- 生成前展示 prompt、时长、预计成本并确认；生成结果写入素材目录与授权记录，记录 provider receipt。
- 生成失败不写入 cue；保留错误与请求摘要（不含密钥）。
- 外部生成默认关闭，只有配置了对应 provider 才出现在面板。

## 7. 时间轴、混音、字幕与导出

### 7.1 时间轴

- 以“段落实测时长 + 插入停顿”生成章节时间轴；cue 以 segment ID 定位，不依赖绝对秒数。
- 面板提供 cue 列表、波形预览、试听和偏移/增益编辑；不做自由剪辑/多轨 NLE。
- 段落文本或说话人变化导致 segment ID 变化时，相关 cue 标为悬空，必须重新绑定后才能导出。

### 7.2 混音

- ffmpeg 混音，参数使用数组传递，不经过 shell 字符串拼接。
- 响度归一默认 -16 LUFS，true peak ≤ -1.5 dBTP；可按项目覆盖。
- BGM 在人声段按 cue 的 `duckDb` 固定衰减，淡入/淡出按 cue 设置；不引入不可复现的随机参数。
- 输出默认立体声 44.1 kHz；旁白/对白保持单声道源时可上混，导出参数写入发布清单。
- ffmpeg/ffprobe 缺失、版本不满足或解码失败时阻止导出并给出可执行修复提示，不静默降级。

### 7.3 字幕

- 用实际 TTS 段时长生成段落级 SRT 与 LRC；不使用未经端点返回的词级时间戳。
- 单条字幕过长时按标点与最大字符数拆分，时间按字符比例分配；拆分规则写入测试。
- 字幕文本与脚本段一致；重新生成音频后字幕必须同步重建，不能沿用旧时轴。

### 7.4 导出

- 分章 MP3：默认 192 kbps、44.1 kHz、立体声，文件名 `第NNNN章.mp3`。
- M4B：默认 128 kbps AAC，嵌入章节标记与封面；章节标题来自源章节标题。
- 封面：`封面/cover.jpg` 必须存在才能导出 M4B 与发布包；缺失时只允许导出分章 MP3。
- 发布包包含 MP3、M4B、SRT/LRC、封面、发布清单。
- 所有输出先写临时文件，校验成功后原子替换；失败不留下半成品。
- 导出前检查：脚本与源文件一致性、未解决 cue、未授权素材、缺失封面、缺段/空段、成本记录。

## 8. 路由与工作台

### 8.1 路由

- `GET /oh-story/audiobook`：项目列表与预检状态（只读）。
- `GET /oh-story/audiobook/project?path=...`：项目、章节、角色、cue 与导出状态（只读）。
- `PUT /oh-story/audiobook/project`：保存项目配置，带 `baseVersion` CAS；密钥字段拒绝。
- `POST /oh-story/audiobook/script`：解析/重新解析章节并写脚本；重新解析必须带 `confirm: true`。
- `POST /oh-story/audiobook/jobs`：启动 TTS 章节任务；支持 `dryRun: true`，实际启动要求 `confirm: true`。
- `GET /oh-story/audiobook/jobs/:id`：进度、失败段、成本。
- `POST /oh-story/audiobook/jobs/:id/cancel`：取消后续请求。
- `POST /oh-story/audiobook/export`：导出；要求 `confirm: true`。
- 所有路由走 `WorkspaceHttpError` 映射；未知路径 404；越界路径 403；输入错误 400；冲突 409。

### 8.2 工作台

新增 feature：`id: "audiobook"`、`label: "有声剧"`、`workbenches: ["story"]`。项目门禁为 `有声剧/<书名>/project.json`。

面板区块：

- 章节：源章节列表、脚本状态、生成状态、时长、试听。
- 角色：角色表、音色、试听、未指派对白计数。
- 脚本：段落列表、说话人修正、悬空 cue 提示。
- 音乐/音效：素材库、授权状态、生成入口、cue 列表。
- 时间轴：段落锚点、偏移/增益/闪避、波形预览。
- 导出：预估成本、MP3/M4B/字幕/发布包选项、预检结果。

交互：

- TTS 启动前显示 dry-run 与成本；确认后调用。
- 单段重生成只影响该段；失败段可单独重试。
- 所有写操作显示成功/失败原因；不吞错。
- 面板不显示密钥、完整 URL 查询串或绝对路径；路径均为工作区相对路径。

## 9. 安全与插件边界

- 不写 DSH 会话持久化、`sessionPersistence` / `borrowSession` / `session-query`、`workspace.json` 结构或 `~/.dsh` 状态。
- 密钥只来自环境变量；日志、错误、缓存、清单均不得包含密钥。
- 所有工作区路径经过 `safeBundlePath` 同类校验；TTS 产物、字幕、封面、发布包只能写入 `有声剧/<书名>/` 与 `.oh-story/audiobook/`。
- TTS 端点校验：只允许 https 或 loopback http；拒绝 URL 凭证、跨主机重定向、非 http(s) 协议；防止 SSRF。
- ffmpeg 只接受数组参数，不拼接 shell；素材路径不接受绝对路径或 `..`。
- 付费调用一律显式确认；无密钥、无预算、缺授权时提前失败，不发请求。
- 诊断与支持包只报告配置存在性和端点主机，不报告密钥、完整请求或用户正文。
- 新增 `有声剧/` 必须进入 `CREATIVE_DIRECTORIES`、备份创作根和文件树；不得让连续性驾驶舱把它误判为小说书目录。

## 10. 测试策略

- 单元：切分与源偏移、segment ID 稳定性、缓存键、成本估算、cue 时间计算、字幕拆分、授权校验、路径安全、SSRF 校验。
- 适配器：本地 fake OpenAI-compatible 服务覆盖成功、429、500、4xx、超时、畸形响应、超大响应、重定向拒绝、无密钥；断言请求字段与脱敏。
- 缓存：同段重跑 0 请求；voice/model/speed 变化只失效相关段；失败/被拒音频不进入缓存。
- 任务：并发冲突、取消、重启后 paused、按段恢复、原子写入、无孤儿输出。
- 路由：GET 零写入；`confirm` 门禁；CAS 冲突；越界路径；未知 job。
- 音频：用合成 WAV 与 ffmpeg 验证混音、响度、淡入淡出、M4B 章节/封面；缺 ffmpeg 时测试明确 skip 并在发布门禁机器上强制运行。
- 界面：纯组件测试覆盖空态、错误、成本确认、悬空 cue、授权阻断；打包冒烟用 fake TTS，不产生真实费用。
- 门禁：`pnpm verify` 加 audiobook 单测与 harness；双宿主冒烟增加项目/预检/无密钥泄漏断言；包体保持 400,000 字节预算。

## 11. N4 验收门

### N4-A 纵向切片

- 单章、单旁白音色，从正文解析到 MP3 试听/导出。
- 同一章重跑缓存全命中，TTS 请求数为 0。
- dry-run 成本可见；无密钥泄漏；GET 零写入。
- 失败端点返回结构化错误，不写半成品。

### N4-B 多角色

- 10 章样本、旁白 + 至少 3 个角色，音色映射可保存与恢复。
- 手工修正说话人后重新生成，只有受影响段重新计费。
- 未指派对白可见且阻止整章完成。

### N4-C 完整有声剧

- 一章带本地 BGM/音效，cue 时间轴可编辑；至少一个外部生成 provider 通过 fake provider 测试（真实 provider 可选、付费且需授权），生成资产走确认与回执。
- 响度 -16 LUFS ±1，true peak ≤ -1.5 dBTP（以 ffmpeg 测量为准）。
- SRT/LRC 与实际音频时点一致；M4B 章节与封面正确。
- 缺授权素材、缺封面、悬空 cue 时阻止发布包导出。
- 发布清单可本地复算 checksum。

### N4-D 批量化与质量

- ≥20 章整书批量，进程中断后可恢复，不重复计费。
- 成本报告与实际请求数可审计；无孤儿文件。
- 连续两周实盘或等效样本量，无 P0；磁盘增长与缓存清理有记录。

## 12. 风险与对策

| 风险 | 对策 |
|---|---|
| 长文 TTS 费用失控 | dry-run、章节/整书预算、内容寻址缓存、失败重试上限、确认门禁 |
| TTS 幻觉/截断 | 时长比值 QC、拒绝样本保留、单段重试、整章缺段检查 |
| OpenAI-compatible 端点差异 | 只发标准字段；能力探测；非标准参数显式开关 |
| 角色识别不准 | 确定性拆分 + 人工指派；LLM 辅助显式、付费、可关闭 |
| BGM/音效版权 | 授权清单强制、cue 引用校验、导出前阻断、发布清单记录 |
| 声音克隆权利 | 首期不做；未来必须显式确认并记录授权 |
| 长任务中断 | 章节 job + 段检查点 + 原子写；重启转 paused |
| 磁盘增长 | 缓存/输出保留策略；清理显式确认；发布清单记录 |
| SSRF/凭证泄漏 | 端点协议/重定向/凭证校验；密钥只读环境变量；日志脱敏 |
| 包体增长 | 面板按 feature 懒加载/拆包；维持 400KB 预算 |
| ffmpeg 缺失/版本差异 | 启动与导出前预检；失败阻断并给出修复提示 |

## 13. 决策记录

1. 有声剧目录用 `有声剧/<书名>/`，源书必须在同工作区 `正文/`。
2. TTS 采用 OpenAI-compatible `/audio/speech`；首期只发标准字段。
3. 密钥只走 `OH_STORY_TTS_*` 环境变量；项目文件只存端点/模型/音色。
4. BGM/音效同时支持本地授权素材库与外部生成适配器；外部生成默认关闭。
5. 交付分章 MP3 + M4B + SRT/LRC + 封面 + 发布清单。
6. 时间轴为段落锚定 cue 列表，不做完整 DAW。
7. v1 不做声音克隆；任何参考音频必须显式确认权利。
8. N4 在 N1–N3 之后；P3 保持条件触发，不预做。
