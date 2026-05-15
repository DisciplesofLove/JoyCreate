/**
 * Quick Start cockpit atoms — shared between the workspace home Quick Start
 * tab and the embedded App Builder Studio so a build started from chips
 * shows up pre-configured in the Studio panel.
 */

import { atom } from "jotai";
import type {
  BuildBrief,
  QuickStartConfig,
  QuickStartProjectType,
} from "@/ipc/app_clarification_client";

export type { BuildBrief, QuickStartConfig, QuickStartProjectType };

/** Tap-target chip that biases the agent + template choice. */
export const quickStartIntentAtom = atom<QuickStartProjectType | null>(null);

/** Full Quick Start config (chips + advanced disclosure values). */
export const quickStartConfigAtom = atom<QuickStartConfig>({
  buildMode: "chat",
  uiLibrary: "shadcn",
  framework: "react",
  deploymentTargets: ["web"],
  features: [],
  styleHints: {},
});

/** The most recent build brief produced by the clarification agent.
 *  Studio seeds its mode / category / knowledge from this when its own
 *  state is empty. */
export const lastBuildBriefAtom = atom<BuildBrief | null>(null);
