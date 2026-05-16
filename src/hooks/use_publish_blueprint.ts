/**
 * Blueprint Publish Hooks — thin wrapper over the generic asset publish
 * factory. Blueprints have no DB row and no unpublish path yet (each
 * publish mints a fresh DropERC1155 token), so the unpublish stub throws.
 *
 * The blueprint YAML body MUST be passed via `payload.metadata.yamlText`.
 * The handler reads it from there to build the IPFS content buffer.
 */

import {
  makeUsePublishAsset,
  type PublishAssetConfig,
} from "./use_publish_asset";
import { IpcClient } from "../ipc/ipc_client";

const client = IpcClient.getInstance();

export const blueprintPublishConfig: PublishAssetConfig<string> = {
  queryKey: "blueprints",
  publish: (payload) => client.blueprintPublishToMarketplace(payload),
  unpublish: async () => {
    throw new Error(
      "Blueprint unpublish is not implemented — each publish mints a new on-chain token.",
    );
  },
};

export const usePublishBlueprint = makeUsePublishAsset(blueprintPublishConfig);
