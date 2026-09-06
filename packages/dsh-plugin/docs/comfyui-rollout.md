# ComfyUI 真机联调检查单（V2：视频 / 音乐 / TTS）

> 范围：用户自有 ComfyUI 部署就绪后的一次端到端联调。代码侧已备齐的内容：
> `comfyui-video` / `comfyui-music` 适配器（`src/drama-adapters.ts`）、runner 的 mp4 签名
> 与 gifs 容器输出（`python/comfyui_runner.py`）、三份最小 API-format 工作流样例
> （`tests/fixtures/comfyui-video.json` / `comfyui-music.json` / `comfyui-tts.json`）、
> e2e 的 video/mp4 与 music/tts/wav 场景（`tests/comfyui-runner-e2e.test.ts`）。
> 排错表以 `docs/comfyui.md` 第 5 节为准，本单只做步骤级引用，不重复。
>
> 注意：`oh_story_comfyui` 工具与工作台状态另支持工作区配置文件
> （工作区根 `.comfyui/config.json`，见 `docs/comfyui.md` 3.1 节）；
> 短剧生产适配器（`comfyui` / `comfyui-video` / `comfyui-music`）仍只走环境变量。

## 1. 前置

- [ ] ComfyUI 已部署可访问（本机默认 `http://127.0.0.1:8188`，局域网改对 `COMFYUI_BASE_URL`）。
- [ ] 所需模型与自定义节点已安装：视频（文生视频模型 + VHS 视频输出节点）、
> - [ ] 环境变量：`COMFYUI_BASE_URL`（非本机时）、`COMFYUI_WORKFLOW`（默认工作流文件绝对路径）、
>   按需 `COMFYUI_WORKFLOW_DIR`（按名查工作流时）、`COMFYUI_TIMEOUT_SECONDS`（默认 600，视频建议调大）、
>   按需 `COMFYUI_API_KEY`。
- [ ] 三份样例工作流已按真实部署改造：把 `tests/fixtures/` 下 `comfyui-video.json` /
>   `comfyui-music.json` / `comfyui-tts.json` 中与本地不一致的 `class_type` 替换为真实节点类型，
>   保留全部 `__PROMPT__` / `__FPS__` / `__DURATION_SECONDS__` / `__SEED__` 占位符写法
>   （runner 只做整值替换，见 `docs/comfyui.md` 第 2 节替换规则）。

## 2. 分步联调（图片 → TTS → 音乐 → 视频）

| 步骤 | 动作 | 预期产物 |
|---|---|---|
| 1 图片基线 | 用现有 `comfyui-txt2img.json` 经 `oh_story_comfyui` 生成 1 张（`output_dir` 如 `covers`） | `covers/<prefix>-1.png` 落盘，工具返回 `files` + `prompt_ids` |
| 2 TTS | `oh_story_comfyui` 配语音工作流（改造后的 `comfyui-tts.json`），`prompt` 为一句解说词 | `tts/<prefix>-1.wav`，RIFF/WAVE 头，可播放；桥接进 `video-recap` 时须满足 mono / 16-bit PCM / 44100 Hz（见 `docs/comfyui.md` 第 7 节） |
| 3 音乐 | `oh_story_comfyui` 配音乐工作流（改造后的 `comfyui-music.json`），传 `prompt` + `duration_seconds` | `music/<prefix>-1.wav` 落盘；游戏 BGM 写入 `game-adaptations/<项目>/audio/` 后可在 Game Studio「项目文件 → 音频」分组试听 |
| 4 视频 | `oh_story_comfyui` 配视频工作流（改造后的 `comfyui-video.json`），传 `prompt` + `fps` + `duration_seconds` | `video/<prefix>-1.mp4` 落盘，`ftyp` 签名通过（runner 按目标扩展名校验） |

每步失败先记下工具返回的结构化错误（`category` / `code`），再对照第 4 节。

## 3. 两条路径分别怎么验

- **工具路径**（`oh_story_comfyui`）：按第 2 节四步直接在对话里调 Agent 生成；
>   验证点是 `output_dir` 落盘文件 + 工具结果卡片（成功展示文件列表，失败回退原文）。
- **短剧适配器路径**（`comfyui` / `comfyui-video` / `comfyui-music`）：走 `short-drama-produce`
>   正常生产流程，Agent 按 job 模态选适配器；调用前 export 对应工作流环境变量
>   （`COMFYUI_WORKFLOW` 或 job `parameters.workflow` 按名/绝对路径指定，顶层 `workflow`
>   会被 production_tool 拒绝，见 `docs/comfyui.md` 4 节）。
>   验证点是 `制作成果/` 下目标文件落盘 + `provider_job_id`（= ComfyUI `prompt_id`）。

## 4. 常见故障对照（明细见 `docs/comfyui.md` 第 5 节排错表）

| 现象 | 错误码 | 先查 |
|---|---|---|
| 连不上 | `comfyui_unreachable` | ComfyUI 进程、`COMFYUI_BASE_URL`、防火墙 |
| 一直转圈 | `comfyui_timeout` / `request_timeout` | 尺寸/步数/时长是否过高、ComfyUI 是否卡住 |
| 红框节点报错 | `node_error` | 同一份工作流在 ComfyUI 界面手动跑一次 |
| 没配工作流 | `workflow_not_configured` / `workflow_not_found` | `COMFYUI_WORKFLOW` / `COMFYUI_WORKFLOW_DIR`、文件名 |
| 占位符报错 | `missing_placeholder_value` | 调用参数是否覆盖工作流里全部占位符 |
| 产物校验失败 | `output_invalid_media` | 输出节点类型（SaveImage / SaveAudio / VHS 输出）与目标扩展名是否一致 |
| 跑完没输出 | `empty_output` | Save 类输出节点配置 |
| 参考图失败 | `upload_failed` | 输入图片存在性与 ComfyUI 输入目录写入权限 |

## 5. V2 遗留项清单（真机联调时逐项确认）

- [ ] 一致性参考图自动装配验证：图生图 `input_image`（`__INPUT_IMAGE__`）在真实多参考场景下只选主角色一张的约定是否成立（见 `docs/comfyui.md` 4 节角色一致性）。
- [ ] 串播带声验证：视频 + TTS/音乐合成后的串播带是否有声、音画是否同步。
- [ ] 音频工作流默认输出多为 mp3/flac 段：runner 的 `_collect_media` 只收 `images` / `gifs` 键、
>   `_media_ok` 只认 `.png/.jpg/.webp/.mp4/.wav` —— 真机若输出键名或扩展名不在此列，
>   先记为 V2 缺口再改 runner，不要在 ComfyUI 侧硬凑。
