// Feature modules register their workspace extensions and audit hooks as an import side
// effect. `registerWorkspaceServices` is called from the plugin entry so module evaluation
// is explicit even under tree shaking.
import "./history.js";
import "./search.js";
import "./analysis.js";
import "./tasks.js";
import "./backup.js";

export function registerWorkspaceServices(): void {
  // Feature modules above register themselves on import; nothing else to mount here.
}