import { useState } from "react";
import { readFeatureEnabled, writeFeatureEnabled } from "../workbench-ui.js";
import {
  clearWorkbenchLayouts,
  readWorkbenchPreference,
  workbenchPreferenceStorage,
  writeWorkbenchPreference,
  type WorkbenchPreference
} from "../workbench-presence.js";
import { registerWorkbenchFeature, workbenchFeatures } from "../features/registry.js";

export const SETTINGS_FEATURE_ID = "settings";

/** C2 settings panel. The registry stays read-only: toggles use separate
`oh-story.feature.<id>` keys and the workbench filters at render time. Live
state arrives through `settingsBridge`, refreshed every render by index.tsx. */
export const settingsBridge: { current: {
  layoutReset: () => void;
  workbenchOpen: boolean;
  onWorkbenchPreference: (preference: WorkbenchPreference) => void;
  cwd: string | undefined;
} } = {
  current: { layoutReset: () => undefined, workbenchOpen: false, onWorkbenchPreference: () => undefined, cwd: undefined }
};

function SettingsPanel() {
  const bridge = settingsBridge.current;
  const storage = workbenchPreferenceStorage();
  const [preference, setPreference] = useState<WorkbenchPreference | undefined>(() => readWorkbenchPreference(storage, bridge.cwd));
  const [switches, setSwitches] = useState<Readonly<Record<string, boolean>>>(() => {
    const entries: Record<string, boolean> = {};
    for (const feature of workbenchFeatures()) {
      if (feature.id !== SETTINGS_FEATURE_ID) entries[feature.id] = readFeatureEnabled(storage, feature.id);
    }
    return entries;
  });
  const toggleWorkbench = (): void => {
    const next: WorkbenchPreference = bridge.workbenchOpen ? "closed" : "open";
    bridge.onWorkbenchPreference(next);
    writeWorkbenchPreference(storage, bridge.cwd, next);
    setPreference(next);
  };
  const toggleFeature = (featureId: string): void => {
    setSwitches((current) => {
      const next = !(current[featureId] ?? true);
      writeFeatureEnabled(storage, featureId, next);
      return { ...current, [featureId]: next };
    });
  };
  const storedLabel = preference === undefined ? "跟随 workspace" : preference === "open" ? "打开" : "收起";
  return <div className="oh-settings-panel">
    <div className="oh-settings-section">
      <h4>工作台</h4>
      <p>当前{bridge.workbenchOpen ? "打开" : "收起"} · 偏好{storedLabel}</p>
      <button type="button" onClick={toggleWorkbench}>{bridge.workbenchOpen ? "收起工作台" : "打开工作台"}</button>
    </div>
    <div className="oh-settings-section">
      <h4>布局</h4>
      <p>清除所有会话的分栏与浮窗位置，回到默认。</p>
      <button type="button" onClick={() => { clearWorkbenchLayouts(storage); bridge.layoutReset(); }}>重置布局</button>
    </div>
    <div className="oh-settings-section">
      <h4>特性面板</h4>
      {workbenchFeatures().filter((feature) => feature.id !== SETTINGS_FEATURE_ID).map((feature) => <label key={feature.id} className="oh-settings-toggle">
        <input type="checkbox" checked={switches[feature.id] ?? true} onChange={() => { toggleFeature(feature.id); }} aria-label={`启用${feature.label}`} />
        {feature.label}
      </label>)}
    </div>
  </div>;
}

/** Called once from apply(); duplicate registration under HMR is ignored. */
export function registerSettingsFeature(): void {
  try {
    registerWorkbenchFeature({
      id: SETTINGS_FEATURE_ID,
      label: "设置",
      icon: "⚙",
      workbenches: ["story", "drama"],
      component: () => <SettingsPanel />
    });
  } catch (error) {
    if (!(error instanceof Error) || !/already registered/u.test(error.message)) throw error;
  }
}
