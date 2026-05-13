/**
 * Agent Publish Hooks — thin wrappers over the generic asset publish
 * factory in `use_publish_asset.ts`. See that file for behaviour notes
 * and DropERC1155 architecture verification.
 */

import {
  agentPublishConfig,
  makeUsePublishAsset,
  makeUseUnpublishAsset,
} from "./use_publish_asset";

export const usePublishAgent = makeUsePublishAsset(agentPublishConfig);
export const useUnpublishAgent = makeUseUnpublishAsset(agentPublishConfig);
