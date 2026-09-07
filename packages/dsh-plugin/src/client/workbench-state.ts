// 从 src/client/index.tsx 原样迁移的状态/类型层(签名、注释、逻辑逐字保持,仅加 export 并调整 import 来源)。
import { defineStore } from "@deepseek-ai/dsh-client-store";
import type { WorkbenchMode } from "./file-activity.js";
import type { GameQaSummary } from "./game-qa.js";
import type { VideoProject } from "./video-studio.js";
import type { DramaProductionSection } from "./drama-production.js";
import type {
  CanvasPoint,
  ProductionJob,
  ProductionSequenceItem
} from "./production-runtime.js";
import type { WorkbenchPreference } from "./workbench-presence.js";
import { defaultSplitTree, type SplitTree } from "./layout/split-tree.js";
import type { FloatGeometry } from "./layout/free-window.js";

export interface WorkspaceFile {
  readonly path: string;
  readonly bytes: number;
  readonly version: string;
  readonly kind: "text" | "media";
  readonly mimeType?: string | undefined;
}
export interface WorkspacePayload {
  readonly cwd: string;
  readonly files: readonly WorkspaceFile[];
  readonly bookDirectories?: readonly string[] | undefined;
  readonly games: readonly GameProject[];
  readonly videos: readonly VideoProject[];
  readonly shortDrama: Record<string, unknown> | null;
  readonly metadataErrors: readonly string[];
  readonly mode: "dsh-session";
}
export interface GameProject {
  readonly id: string;
  readonly root: string;
  readonly title: string;
  readonly source: "workspace" | "example";
  readonly previewReady: boolean;
  readonly previewUrl?: string | undefined;
  readonly previewVersion: string;
  readonly qa?: GameQaSummary | undefined;
  /** ART-* 三方对账诊断(登记/art//build);服务端随 games 列表下发,旧宿主无此字段。 */
  readonly gameArtDiagnostics?: readonly { readonly level: "error" | "warning"; readonly code: string; readonly message: string }[] | undefined;
}
export interface FilePayload {
  readonly path: string;
  readonly content: string;
  readonly bytes: number;
  readonly version: string;
}
export interface FileBuffer {
  readonly content: string;
  readonly saved: string;
  readonly source: "disk" | "human" | "agent";
  readonly version: string;
  readonly saving?: boolean | undefined;
  readonly error?: string | undefined;
  readonly missing?: boolean | undefined;
  readonly conflict?: {
    readonly message: string;
    readonly theirs?: string | undefined;
    readonly theirsVersion?: string | undefined;
  } | undefined;
}

export interface WorkbenchMemory {
  buffers: Record<string, FileBuffer>;
  workbenchPreference: WorkbenchPreference | undefined;
  editorMode: "preview" | "source" | "production" | "view";
  expanded: Record<string, boolean>;
  selected: string | undefined;
  workbench: WorkbenchMode;
  gameTab: "preview" | "design" | "qa";
  gameProjectId: string | undefined;
  gamePane: "studio" | "chat";
  videoTab: "preview" | "artifacts";
  videoProjectId: string | undefined;
  videoPane: "studio" | "chat";
  productionSection: DramaProductionSection;
  productionSelectedIds: Record<string, string | undefined>;
  productionJobs: Record<string, ProductionJob[]>;
  productionSelections: Record<string, Record<string, string>>;
  productionReferences: Record<string, Record<string, string[]>>;
  productionSequence: Record<string, ProductionSequenceItem[]>;
  productionCanvas: Record<string, Record<string, CanvasPoint>>;
  productionZoom: Record<string, number>;
  productionIntentCalls: Record<string, boolean>;
  featurePane: string | undefined;
  /** Phase C layout: story/drama split tree (tree|editor pair). */
  splitTree: SplitTree;
  /** Phase C free windows: keyed by panel id, absolute viewport geometry. */
  floats: Record<string, FloatGeometry>;
}

export type Update<T> = T | ((current: T) => T);

export function applyUpdate<T>(current: T, update: Update<T>): T {
  return typeof update === "function" ? (update as (value: T) => T)(current) : update;
}

export function createWorkbenchStore() {
  return defineStore({
    init: (): WorkbenchMemory => ({
      buffers: {},
      workbenchPreference: undefined,
      editorMode: "preview",
      expanded: {},
      selected: undefined,
      workbench: "story",
      gameTab: "preview",
      gameProjectId: undefined,
      gamePane: "studio",
      videoTab: "preview",
      videoProjectId: undefined,
      videoPane: "studio",
      productionSection: "shots",
      productionSelectedIds: {},
      productionJobs: {},
      productionSelections: {},
      productionReferences: {},
      productionSequence: {},
      productionCanvas: {},
      productionZoom: {},
      productionIntentCalls: {},
      featurePane: undefined,
      splitTree: defaultSplitTree(),
      floats: {}
    }),
    actions: {
      setBuffers: (draft, update: Update<Record<string, FileBuffer>>) => {
        draft.buffers = applyUpdate(draft.buffers, update);
      },
      setWorkbenchPreference: (draft, update: Update<WorkbenchPreference | undefined>) => {
        draft.workbenchPreference = applyUpdate(draft.workbenchPreference, update);
      },
      setEditorMode: (draft, update: Update<WorkbenchMemory["editorMode"]>) => {
        draft.editorMode = applyUpdate(draft.editorMode, update);
      },
      setExpanded: (draft, update: Update<Record<string, boolean>>) => {
        draft.expanded = applyUpdate(draft.expanded, update);
      },
      setSelected: (draft, update: Update<string | undefined>) => {
        draft.selected = applyUpdate(draft.selected, update);
      },
      setWorkbench: (draft, update: Update<WorkbenchMode>) => {
        draft.workbench = applyUpdate(draft.workbench, update);
      },
      setGameTab: (draft, update: Update<WorkbenchMemory["gameTab"]>) => {
        draft.gameTab = applyUpdate(draft.gameTab, update);
      },
      setGameProjectId: (draft, update: Update<string | undefined>) => {
        draft.gameProjectId = applyUpdate(draft.gameProjectId, update);
      },
      setGamePane: (draft, update: Update<WorkbenchMemory["gamePane"]>) => {
        draft.gamePane = applyUpdate(draft.gamePane, update);
      },
      setVideoTab: (draft, update: Update<WorkbenchMemory["videoTab"]>) => {
        draft.videoTab = applyUpdate(draft.videoTab, update);
      },
      setVideoProjectId: (draft, update: Update<string | undefined>) => {
        draft.videoProjectId = applyUpdate(draft.videoProjectId, update);
      },
      setVideoPane: (draft, update: Update<WorkbenchMemory["videoPane"]>) => {
        draft.videoPane = applyUpdate(draft.videoPane, update);
      },
      setProductionSection: (draft, update: Update<DramaProductionSection>) => {
        draft.productionSection = applyUpdate(draft.productionSection, update);
      },
      setProductionSelectedIds: (draft, update: Update<Record<string, string | undefined>>) => {
        draft.productionSelectedIds = applyUpdate(draft.productionSelectedIds, update);
      },
      setProductionJobs: (draft, update: Update<Record<string, ProductionJob[]>>) => {
        draft.productionJobs = applyUpdate(draft.productionJobs, update);
      },
      setProductionSelections: (draft, update: Update<Record<string, Record<string, string>>>) => {
        draft.productionSelections = applyUpdate(draft.productionSelections, update);
      },
      setProductionReferences: (draft, update: Update<Record<string, Record<string, string[]>>>) => {
        draft.productionReferences = applyUpdate(draft.productionReferences, update);
      },
      setProductionSequence: (draft, update: Update<Record<string, ProductionSequenceItem[]>>) => {
        draft.productionSequence = applyUpdate(draft.productionSequence, update);
      },
      setProductionCanvas: (draft, update: Update<Record<string, Record<string, CanvasPoint>>>) => {
        draft.productionCanvas = applyUpdate(draft.productionCanvas, update);
      },
      setProductionZoom: (draft, update: Update<Record<string, number>>) => {
        draft.productionZoom = applyUpdate(draft.productionZoom, update);
      },
      setProductionIntentCalls: (draft, update: Update<Record<string, boolean>>) => {
        draft.productionIntentCalls = applyUpdate(draft.productionIntentCalls, update);
      },
      setFeaturePane: (draft, update: Update<string | undefined>) => {
        draft.featurePane = applyUpdate(draft.featurePane, update);
      },
      setSplitTree: (draft, update: Update<SplitTree>) => {
        draft.splitTree = applyUpdate(draft.splitTree, update);
      },
      setFloat: (draft, panelId: string, geometry: FloatGeometry | undefined) => {
        if (geometry === undefined) delete draft.floats[panelId];
        else draft.floats[panelId] = geometry;
      },
      setFloats: (draft, update: Update<Record<string, FloatGeometry>>) => {
        draft.floats = applyUpdate(draft.floats, update);
      }
    }
  });
}

export class WorkspaceRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export const GROUP_ORDER: Readonly<Record<WorkbenchMode, readonly string[]>> = {
  story: ["正文", "大纲", "设定", "追踪", "对标", "参考资料"],
  drama: ["项目", "输入", "项目开发", "设定集", "剧集", "审查", "创作者决策", "交付"],
  game: ["game-adaptations"],
  video: ["video-recaps"]
};

export const WORKBENCH_MODES = ["story", "drama", "game", "video"] as const;
export const EDITOR_MODES = ["preview", "source", "production"] as const;
export const GAME_FLOAT_ID = "game-studio";
export const VIDEO_FLOAT_ID = "video-studio";

export function groupForPath(path: string): string {
  return path === "short-drama.json" ? "项目" : path.split("/", 1)[0] ?? "其他";
}

export async function json<T>(response: Response): Promise<T> {
  const value = await response.json() as T & { readonly error?: string };
  if (!response.ok) throw new WorkspaceRequestError(response.status, value.error ?? `HTTP ${String(response.status)}`);
  return value;
}
