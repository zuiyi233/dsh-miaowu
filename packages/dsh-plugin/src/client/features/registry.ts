import type { ComponentType } from "react";

/** A light structural view of the workspace the feature panels consume. */
export interface FeatureWorkspace {
  readonly cwd: string;
  readonly files: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly version: string;
    readonly kind: "text" | "media";
    readonly mimeType?: string | undefined;
  }[];
  readonly metadataErrors: readonly string[];
}

export interface WorkbenchFeatureProps {
  readonly sessionId: string;
  readonly workspace: FeatureWorkspace | undefined;
  readonly selected: string | undefined;
  /** Open a file in the editor at a 1-based line and character offset. */
  readonly onReveal: (path: string, line: number, offset: number) => void;
  readonly onClose: () => void;
}

export interface WorkbenchFeature {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  /** Workbenches that show the toggle button for this feature. */
  readonly workbenches: readonly ("story" | "drama")[];
  readonly component: ComponentType<WorkbenchFeatureProps>;
}

const features: WorkbenchFeature[] = [];

export function registerWorkbenchFeature(feature: WorkbenchFeature): void {
  if (feature.id === "" || features.some((existing) => existing.id === feature.id)) {
    throw new Error(`workbench feature already registered: ${feature.id}`);
  }
  features.push(feature);
}

export function workbenchFeatures(): readonly WorkbenchFeature[] {
  return features;
}