// Feature modules register their workspace extensions and audit hooks as an import side
// effect. `registerWorkspaceServices` is called from the plugin entry so module evaluation
// is explicit even under tree shaking.
import "./history.js";
import "./search.js";
import "./analysis.js";
import "./tasks.js";
import "./backup.js";
import "./foreshadows.js";
import "./bookshelf.js";
import "./vault.js";
import "./diagnostics-route.js";
import "./continuity-route.js";
import "./audiobook-route.js";
import { registerContinuityPreWriteGuard } from "./continuity-route.js";

export function registerWorkspaceServices(options: { readonly maxBytes?: number } = {}): void {
  // 高风险写前快照使用与编辑器一致的单文件上限，避免配置不同导致误拒。
  registerContinuityPreWriteGuard(options.maxBytes ?? 2_097_152);
}