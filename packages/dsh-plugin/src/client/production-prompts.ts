import type { DramaEpisodeProduction } from "./drama-production.js";
import type { ProductionJob, ProductionMediaVersion } from "./production-runtime.js";

const authorityBoundary = "只使用当前 DSH Preset 可见的工具；所有文件、网络、生成和命令操作继续遵守 DSH 权限与审批。";
const adapterGuidance = "按生成环境条当前已配置的适配器选择：本地 ComfyUI 适配器（comfyui/comfyui-video/comfyui-music）无需凭据但需已配置工作流；云适配器需对应环境变量已导出。适配器能力与凭据状态见预检";
// 审查结论机器可读格式见 skill-provider.ts 的 DSH_DRAMA bridge 注入;解析器 client/drama-review.ts。
const reviewGate = "投产前先读 审查/ 目录下本 EP 的审查文档「## 审查结论」段（- 结论：通过 / 有阻塞）;结论为有阻塞时,必须先逐条列出未清 Blocker 并得到创作者处理确认,才能继续 prepare。";
// 成片合成的确定性契约:参数固定可复现,不留给 Agent 自由发挥;响度目标 -16 LUFS(流媒体口播常规)。
const compositionStandard = "音视频标准化固定为:输出 mp4（H.264 + yuv420p + movflags faststart）；分辨率与帧率以分镜文档镜头规格为准并全程一致；音频重采样 44100 Hz；响度 loudnorm=I=-16:LRA=11:TP=-1.5。合成完成后必须列出生成文件确认存在并报告路径，不得伪造成功。";

export function nativeProductionPrompt(
  production: DramaEpisodeProduction,
  job: ProductionJob,
  references: readonly ProductionMediaVersion[]
): string {
  const referenceText = references.length === 0
    ? "无"
    : references.map((item) => `${item.targetId}: ${item.path ?? item.url}`).join("\n");
  return `/short-drama-produce

只准备当前单项生产任务，不运行 Provider。
- 任务 ID：${job.id}
- 任务类型：${job.kind === "image" ? "图片/关键帧" : "镜头视频"}
- 适配器选择：${adapterGuidance}
- 投产对象：${job.targetId}
- 审查闸门：${reviewGate}
- 创作文档目录：${production.episodeDirectory}
- 参考素材：
${referenceText}
- 输出目录：${production.episodeDirectory}/制作成果/${job.targetId}
- 输出文件名必须同时包含投产对象 ID 与任务 ID ${job.id}，以便 DSH 工作台关联版本。

待预检提示词：
${job.prompt}

按 short-drama-produce 的硬闸门建立临时 job 并执行 prepare，在 Chat 中完整展示 adapter、模型/profile、数量、参数、references、outputs 与 overwrite。此按钮只表达“准备预览”，不构成看到预览后的生产确认；不得 confirm 或 run。用户在后续消息明确确认这份预览后，才可调用 oh_story_production track_job 登记同一个任务 ID，并运行 Provider。${authorityBoundary}`;
}

export function nativeBatchPrompt(
  production: DramaEpisodeProduction,
  job: ProductionJob,
  candidates: readonly { readonly id: string; readonly prompt: string }[]
): string {
  return `/short-drama-produce

只准备当前批量生产任务，不运行 Provider。
- 批次任务 ID：${job.id}
- 任务类型：${job.kind === "image" ? "批量关键帧" : "批量镜头视频"}
- 适配器选择：${adapterGuidance}
- 审查闸门：${reviewGate}
- 创作文档目录：${production.episodeDirectory}
- 输出根目录：${production.episodeDirectory}/制作成果
- 每个输出文件名必须包含对应镜头 ID 与批次任务 ID ${job.id}。

${candidates.map((item) => `## ${item.id}\n${item.prompt}`).join("\n\n")}

把数量、逐项输出和成本边界完整展示给创作者。此按钮只表达“准备预览”，不构成看到预览后的生产确认；不得 confirm 或 run。用户在后续消息明确确认这份预览后，才可调用 oh_story_production track_job 登记同一个批次任务 ID，并运行 Provider。${authorityBoundary}`;
}

export function nativeCompositionPrompt(
  production: DramaEpisodeProduction,
  job: ProductionJob,
  orderedPaths: readonly string[]
): string {
  return `/short-drama-produce

执行创作者已明确确认的成片合成任务。
- 任务 ID：${job.id}
- 剧集：${production.episodeDirectory}
- 按以下顺序合成，不得自行换序：
${orderedPaths.map((path, index) => `${String(index + 1)}. ${path}`).join("\n")}
- 输出：${production.episodeDirectory}/制作成果/成片-${job.id}.mp4

先验证输入均存在且可读，再使用当前 DSH Preset 可见的媒体/命令工具执行。${compositionStandard} 所有命令和写入继续遵守 DSH 权限与审批。`;
}
