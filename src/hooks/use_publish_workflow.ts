/**
 * Workflow Publish Hooks — thin wrappers over the generic asset publish
 * factory in `use_publish_asset.ts`. See that file for behaviour notes
 * and DropERC1155 architecture verification.
 */

import {
  makeUsePublishAsset,
  makeUseUnpublishAsset,
  workflowPublishConfig,
} from "./use_publish_asset";

export const usePublishWorkflow = makeUsePublishAsset(workflowPublishConfig);
export const useUnpublishWorkflow = makeUseUnpublishAsset(workflowPublishConfig);
