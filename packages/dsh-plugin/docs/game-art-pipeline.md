# 游戏美术资产流（生成 → 登记 → 接入 → QA 回归）

> 范围：`oh_story_comfyui` 生成到 `game-adaptations/<项目>/art/` 的美术，
> 如何变成 Game Studio 里真实可玩、可验证的游戏内美术。
> 核心原则：**生成完毕只算素材就绪，不算接入完成**。

## 1. 流程总览

```text
oh_story_comfyui 生成 → art/ 落盘
  → ART-* 登记到 design/ART_DIRECTION.md
  → game-build 显式接入 build/app/（游戏代码引用）
  → game-qa 六项最小 QA 回归（真实渲染验证 + 证据）
```

任何一步缺失都不得声称"美术已上屏"。

## 2. 生成（素材就绪）

用 `oh_story_comfyui` 工具生成，`output_dir` 指向项目 art 目录：

```json
{
  "prompt": "ink-wash jiangnan water town title background, misty dawn, empty center for title text, no text",
  "negative": "watermark, text, low quality",
  "output_dir": "game-adaptations/ink-town/art/",
  "width": 1920,
  "height": 1080,
  "filename_prefix": "ART-TITLE-01"
}
```

约定：

- `output_dir` 固定为 `game-adaptations/<项目>/art/`（工作区内相对路径）。
- art/ 下文件名以 `ART-*` ID 开头（如 `ART-TITLE-01.png`），一个 ID 对应一个锁定用途。
- 生成工具细节（工作流、占位符、排错）见 `comfyui.md` 第 4 节"通用侧"。

## 3. 登记（ART-* 清单）

每张要接入的美术，在 `game-adaptations/<项目>/design/ART_DIRECTION.md`
维护一行稳定的 `- ID：ART-*` 清单（如 `- ID：ART-TITLE-01 —— 标题屏背景，文件 art/ART-TITLE-01.png`）。
这是短剧 `VISUAL-*` 稳定 ID 惯例在游戏侧的对齐：ID 一旦分配不再修改，
换图只换文件内容或新增 ID，不复用旧 ID 指代新图。

## 4. 接入（素材 → 可玩）

`game-build` 必须把每张定妆图显式接入 `build/app/`：

- 标题屏背景、场景卡、角色立绘位等——在游戏代码里写明引用路径
  （复制进 `build/app/` 或以项目约定的相对路径引用）。
- 引用路径同时写进游戏代码与 `ART_DIRECTION.md` 对应 `ART-*` 清单行，
  两处必须一致。
- 未接入的 art/ 文件只是素材：Game Studio 美术分组能预览它们，
  但这不代表它们已进入可玩构建。

## 5. QA 回归（美术已上屏的证据）

接入后必须重跑 `game-qa` 六项最小 QA
（`launch`、`render`、`input`、`coreLoop`、`outcome`、`restart`）：

- 引用美术的场景必须真实渲染验证（打开含该美术的界面/场景并截图或录屏取证）。
- `qa/verification.json` 仍是唯一 QA 事实源：把"美术已上屏"记进对应检查的证据
  （checks 的 evidence / `verify.suites` / limitation，三态仍只取 `NOT_RUN` / `FAIL` / `PASS`），
  不得另建第二份 QA 报告。
- 上游 `game-build` / `game-qa` 契约文件不可改，本约束由 DSH 层
  `DSH_GAME_BRIDGE` 注入（见 `packages/dsh-plugin/src/skill-provider.ts`）。

## 6. Game Studio 联动

- **美术分组**：按 `isGameArtImage` 规则展示——当前项目 `art/` 下递归 +
  项目根直属图片；`build/app/` 下的已接入图不在美术分组里（它是构建产物）。
- **QA tab**：读 `qa/verification.json`；美术回归后对应检查应有真实运行证据，
  否则仍显示未验证，Agent 不得声称已通过。
