// Feature panels register themselves through the workbench feature registry as an import
// side effect. `registerClientFeatures` is called from the client entry so module
// evaluation is explicit even under tree shaking.
import "./history-feature.js";
import "./search-feature.js";
import "./analysis-feature.js";
import "./tasks-feature.js";
import "./backup-feature.js";
import "./foreshadows-feature.js";
import "./bookshelf-feature.js";

export function registerClientFeatures(): void {
  // Feature modules above register themselves on import; nothing else to mount here.
}