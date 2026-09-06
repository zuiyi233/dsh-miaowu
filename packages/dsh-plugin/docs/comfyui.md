# ComfyUI 接入说明

> dsh-miaowu 的本地 ComfyUI 接入：第一版只做**图片**；
> 第二版再扩展视频 / 音乐 / TTS。

## 1. 这是什么

dsh-miaowu 通过本地 ComfyUI 生成图片（及后续的视频 / 音频），有两个入口：

- **短剧生产适配器**：`comfyui`（图片；第一版）/ `comfyui-video`（视频，第二版预留）/ `comfyui-music`（音乐，第二版预留）。
  `short-drama-produce` 的生产任务（job）会经由这些适配器执行，创作者只需要配好环境变量与工作流。
- **通用工具**：`oh_story_comfyui`。在对话里让 Agent 调用它，传入提示词与输出目录即可，
  可用于小说封面（`story-cover`）、游戏改编美术资源（`game-adaptations/<project>/art/`）等任何需要本地生图的场景。

工作流机制统一：两个入口都使用同一套“API-format 工作流 + 占位符替换”机制（见下文第 2–3 节）。

## 2. 工作流准备

1. 在 ComfyUI 网页界面里搭好工作流，确认能正常出图。
2. 点击工作流菜单的 **"Save (API Format)"**，导出 JSON（注意不是普通的 Save，API Format 去掉了 UI 布局信息，只保留节点与连线）。
3. 把导出的 JSON 文件放入 `COMFYUI_WORKFLOW_DIR` 指向的目录（见第 3 节），
   并在 `COMFYUI_WORKFLOW` 中指定文件名（或直接用绝对路径）。

### 占位符表

在导出的 JSON 里，把需要每次调用时动态填入的值替换为以下占位符字符串：

| 占位符 | 类型 | 说明 |
|---|---|---|
| `__PROMPT__` | 文本 | 正向提示词 |
| `__NEGATIVE__` | 文本 | 反向提示词：工作流含 `__NEGATIVE__` 时调用必须传 negative，否则显式报错（`missing_placeholder_value`）；不需要反向提示词就把占位符改成固定文本 |
| `__WIDTH__` | 数字 | 出图宽度（像素） |
| `__HEIGHT__` | 数字 | 出图高度（像素） |
| `__SEED__` | 数字 | 随机种子 |
| `__STEPS__` | 数字 | 采样步数 |
| `__CFG__` | 数字 | CFG scale |
| `__FPS__` | 数字 | 帧率（第二版视频预留，第一版可不填） |
| `__DURATION_SECONDS__` | 数字 | 时长秒数（第二版视频预留，第一版可不填） |
| `__INPUT_IMAGE__` | 文件名 | 图生图参考图：调用时上传图片到 ComfyUI，替换为服务端返回的文件名 |

### 替换规则

- 仅当 JSON 中某个**字符串值整体等于**占位符（例如 `"text": "__PROMPT__"`）时才替换；作为子串出现的值不动。
- 数字占位符替换后为 **JSON 数字类型**（例如 `"width": "__WIDTH__"` → `"width": 1024`），而不是字符串。
- `__INPUT_IMAGE__` 替换前会先把调用方提供的图片上传到 ComfyUI，替换为服务端文件名。
- 调用参数里**未提供**的占位符会在执行前**显式报错**（`missing_placeholder_value`），不会静默跳过或留空。
- 工作流 JSON 的其余内容原样不动：占位符机制只替换，不改节点结构。

## 3. 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `COMFYUI_BASE_URL` | 否 | `http://127.0.0.1:8188` | ComfyUI 服务地址。ComfyUI 装在局域网另一台机器上时改这里 |
| `COMFYUI_WORKFLOW` | 条件必填 | — | 工作流：文件名（在 `COMFYUI_WORKFLOW_DIR` 下查找）或绝对路径。未配置时任何调用都显式报错（`workflow_not_configured`），不会静默走别的生图通道 |
| `COMFYUI_WORKFLOW_DIR` | 否 | — | bare-name 工作流名的查找目录（无默认文件语义） |
| `COMFYUI_API_KEY` | 否 | — | 可选。配置后以 `Authorization: Bearer <key>` 访问需要鉴权的 ComfyUI 服务 |
| `COMFYUI_TIMEOUT_SECONDS` | 否 | `600` | 仅短剧 drama 模式生效：适配器超时秒数，上限 `3600` |

解析优先级只有三级：调用参数显式传入的工作流 > `COMFYUI_WORKFLOW` 指定的文件（环境变量）>
工作区配置文件（工作区根 `.comfyui/config.json` 的 `workflow` 键）；
`COMFYUI_WORKFLOW_DIR`（环境变量）或配置文件的 `workflowDir` 只在按名选用时生效（作为 bare-name 工作流名的查找目录）。
没有配 `COMFYUI_WORKFLOW` 且调用也没传工作流、配置文件也没有 `workflow` 时，直接报 `workflow_not_configured`，
Agent 应如实告诉创作者“没有配置 ComfyUI 工作流”，而不是悄悄切换到别的生图方式。

## 3.1 工作区配置文件（只对 `oh_story_comfyui` 工具与工作台状态生效）

除环境变量外，ComfyUI 的三个非凭据项也可以写进**工作区根**的 `.comfyui/config.json`（三键均可选）：

```json
{ "baseUrl": "http://192.168.1.10:8188", "workflow": "portrait", "workflowDir": "/data/workflows" }
```

- 优先级：**环境变量 > 工作区配置文件 > 内置默认**（各键独立：`COMFYUI_BASE_URL` 已设时只覆盖地址，`workflow` 仍可取文件值）。
- 生效范围：`oh_story_comfyui` 工具（TS 侧在 spawn runner 前把解析出的配置值注入子进程环境变量，
  仅当同名 env 未显式设置时才注入）与工作台 `drama-preflight` 状态（`workflow.source` 新增 `"workspace-file"`）。
- 读写入口：工作台生产视图生成环境条的「编辑配置」按钮（`GET`/`POST /oh-story/comfyui-config`），
  也可以手工建文件；写盘为临时文件 + rename 原子发布。
- **短剧适配器的 ComfyUI 配置只能用环境变量；工作区配置文件只对 `oh_story_comfyui` 工具与工作台状态生效。**
  短剧链路的 runner 由上游 `production_tool` spawn，工作台侧无法把工作区配置注入进去——
  走 `comfyui` / `comfyui-video` / `comfyui-music` 适配器的生产任务仍需在启动 DSH 前 export 第 3 节的环境变量。
- 凭据（`COMFYUI_API_KEY` 等）永远只读环境变量，不进配置文件、不进任何响应。

## 4. 两个入口的用法

### 短剧侧（生产适配器）

`short-drama-produce` 的 job 会经 `comfyui` 适配器执行。创作者侧只需要：

1. 按第 2 节准备好 API-format 工作流 JSON 并放好；
2. 启动 DSH 前 export 第 3 节的环境变量（至少 `COMFYUI_WORKFLOW`，ComfyUI 不在本机时还要 `COMFYUI_BASE_URL`；只有改超时才需要 `COMFYUI_TIMEOUT_SECONDS`）；
3. 在对话里按正常流程确认生产任务即可，适配器选择与参数填充由 Agent 完成。

多集多风格需要按任务换工作流时，把 workflow 写进 job 的 parameters
（`parameters.workflow` = 工作流名或绝对路径），**不要放顶层**
（顶层 workflow 会被 production_tool 拒绝）；只有环境变量兜底时无需此参数。

### 角色一致性（图生图参考）

为某镜头生成图片时，若该镜头涉及的角色/场景在 `剧集/<EP>/视觉设定.md`
已有 `VISUAL-*` 定妆图（已生成于 `剧集/<EP>/制作成果/` 下），Agent 应把其
**项目内相对路径**写入 job `parameters` 的 `input_image`，作为图生图参考；
多个参考候选时只选主角色的一张（ComfyUI 工作流只有一个 `__INPUT_IMAGE__`
输入占位）。

- 路径语义：runner 侧 `_resolve_input_file(value, project_root)`——相对路径
  相对 `project_root`（run 快照根，含本次已确认的 `source` 与 `references`），
  绝对路径按原样使用；文件必须存在且为普通文件（非 symlink），否则报错。
  因此参考图必须已是本次 job 的已确认输入（`source`/`references` 之一，
  已 pin 进 run 快照），否则 runner 在快照里找不到该文件。
- 工作流要求：所选工作流 JSON 必须含 `__INPUT_IMAGE__` 占位符；调用传了
  `input_image` 但工作流没有该占位符时，对应参数会被忽略（记入 ignored）。
  反之工作流有占位符而调用没传 `input_image` 时，报 `missing_placeholder_value`。
- 上传机制：runner 在提交 prompt 前把该文件经 ComfyUI `/upload/image`
  上传，替换为服务端返回的文件名再填入工作流。

### 通用侧（`oh_story_comfyui` 工具）

在对话里直接让 Agent 调用 `oh_story_comfyui`，示例参数：

```json
{
  "prompt": "misty jiangnan water town at dawn, ink-wash style book cover, no text",
  "negative": "watermark, text, low quality",
  "output_dir": "covers",
  "width": 1024,
  "height": 1536,
  "seed": 42
}
```

- `output_dir` 为工作区内相对路径（如小说封面写 `covers`，游戏美术写 `game-adaptations/<project>/art/`）。
- `count`（1–8，默认 1，多张时 seed 递增）、`timeout_seconds`（默认 600，上限 3600）、
  `filename_prefix`（默认 `"comfyui"`，纯文件名，禁路径分隔与前导点）。
- 输出为 `files` 数组；可能带 `warnings` 字段（= 被忽略的未知参数）。
- `width` / `height` / `seed` / `steps` / `cfg` 不传时用工作流 JSON 里的原值（即对应占位符不存在或由服务端默认处理）；
  只有工作流里写了占位符、调用又没给值时才报错。
- 工具不可见（当前 preset 没配）或没配工作流时，Agent 应明确说明限制，不虚构已出图。

## 5. 排错

| 错误码 | 含义 | 排查动作 |
|---|---|---|
| `comfyui_unreachable` | 连不上 ComfyUI 服务 | 检查 ComfyUI 是否启动、`COMFYUI_BASE_URL` 是否正确、防火墙 / 局域网地址 |
| `comfyui_timeout` | 请求超时 | 检查工作流是否过大、出图参数（尺寸 / 步数）是否过高、ComfyUI 侧是否卡住 |
| `node_error` | 工作流执行节点报错 | 到 ComfyUI 界面用同一份工作流手动跑一次，看红框节点的报错信息；确认模型 / 节点插件已安装 |
| `workflow_not_configured` | 没有配置工作流 | 配置 `COMFYUI_WORKFLOW`（或调用时传工作流），不要绕过 |
| `workflow_not_found` | 指定的工作流文件不存在 | 检查文件名 / 路径、`COMFYUI_WORKFLOW_DIR` 是否正确 |
| `missing_placeholder_value` | 工作流里的占位符没有对应参数 | 补上调用参数，或把工作流里不需要的参数占位符改回固定值 |
| `output_invalid_media` | 产物不是有效图片 | 检查工作流输出节点（SaveImage）配置，确认 ComfyUI 侧正常产图后重试 |
| `adapter_start_failed` | 本机 Python 不可用或版本过低 | 安装 Python 3.10+ 后重启 DSH；若已消费需重新确认后再重试 |
| `request_timeout` | runner 单次 HTTP 60s 超时 | 检查网络与 ComfyUI 服务是否卡住，稍后重试 |
| `empty_output` | ComfyUI 跑完但没有输出 | 检查工作流 SaveImage 类输出节点是否正确配置 |
| `upload_failed` | 参考图上传失败 | 检查输入图片是否存在，以及 ComfyUI 输入目录的写入权限 |

## 6. 第二版预告

- `__FPS__` / `__DURATION_SECONDS__` 占位符已预留，第一版可忽略；第二版视频工作流启用。
- 视频 / 音乐 / TTS 适配器（`comfyui-video` / `comfyui-music`）与语音桥接将沿用同一机制扩展：
  同一款“API-format 工作流 + 占位符”写法，换模态只需换工作流 JSON 与对应参数。

## 7. 视频解说配音走 ComfyUI（第二版桥接）

上游 `video-recap` 管线的配音脚本只支持 MiMo / Fish 两家（生成服务白名单写死，无适配器缝隙），
所以本地 ComfyUI 配音（GPT-SoVITS / IndexTTS 等语音工作流）走**桥接约定**，不改上游脚本：

1. 逐段取 `work/narration.json` 的 `narration` 文本，先做与上游 `voiceover.py` 相同的清洗
   （去掉 markdown 记号、「」引用、[舞台指示]、(旁白) 标注、emoji、重复标点），否则语音模型会把标注读出来。
2. 用 `oh_story_comfyui`（配置好语音工作流）逐段生成音频，硬性格式要求：
   **mono（单声道）、16-bit PCM WAV、44100 Hz**，响度对齐约 **-20 dBFS**；
   采样率不符会触发合成阶段全量 ffmpeg 重采样，非单声道/非 16-bit 会被整段跳过。
3. 按 `tts_segments/narr_<序号三位>.wav` 命名落盘（如 `narr_000.wav`），并手写完整 `work/tts_meta.json`：
   顶层 `{segments, engine: "comfyui-local", narration, partial: false, failures: []}`；
   每段必须含 `index / start / end / narration / spoken_text / audio_path / audio_duration（实测秒数）/
   pause_after_ms / overlaps_speech / tts_rate_offset: 0` 全部字段——缺字段会让字幕、闪避（ducking）退化。
4. 直接调用合成步骤（`video-assemble` 的 `assemble.py`，`--work-dir` 指向同一 work 目录），
   **不要**走一键 recap 链——一键链会重跑上游配音并覆盖刚生成的 ComfyUI 音频。
5. 时长注意：合成阶段对超窗段落只做温和变速，放不下会阻断（不裁尾）。ComfyUI 语音语速偏慢时
   应在解说文案侧缩短句子，而不是指望合成阶段修。

未配置语音工作流时，Agent 应说明配音仍走上游 MiMo / Fish 通路，不虚构已生成音频。

## 8. 短剧台词配音（TTS 语音工作流占位）

短剧每镜头的台词配音走**通用工具** `oh_story_comfyui`（创作者配置的 TTS 语音工作流，
模态无关提交/下载），不走生产适配器：

1. 逐镜头取台词文本（分镜.md 该镜头的对白/旁白），用 `oh_story_comfyui` 逐个生成，
   落盘 `剧集/<EP>/配音/<SHOT-ID>.wav`（配音解析接受 wav/mp3/m4a/flac）——**文件名必须含镜头 ID**（如
   `SHOT-EP001-001.wav`、`SHOT-EP001-001-take2.wav`），串播视图按文件名 token
   自动关联到对应镜头（`SHOT-EP001-0010.wav` 不会误关联到 `SHOT-EP001-001`）。
2. 硬性格式：**mono（单声道）、16-bit、44100 Hz**，与第 7 节解说配音同规。
3. TTS 工作流占位符用法：语音工作流 JSON 里文本用 `__PROMPT__`（整值替换），
   时长秒数用 `__DURATION_SECONDS__`（JSON 数字替换）；其余占位符规则见第 2 节
   （整值匹配才替换、缺值显式报错 `missing_placeholder_value`）。
4. 与 video-recap 配音契约的区别：短剧**无需手写 `tts_meta.json`**，也不走
   `assemble.py` 合成——配音文件直接由串播视图按镜头播放（图片镜头停留期间
   自动播其配音，视频镜头只播视频自带声音）。
5. 工具不可见（当前 preset 没配 `oh_story_comfyui`）或没配语音工作流时，
   Agent 应明确说明限制，不虚构已生成音频。
