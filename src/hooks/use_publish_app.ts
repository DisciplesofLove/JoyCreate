/**
 * App Publish Hooks — thin wrapper over the generic asset publish factory.
 *
 * Apps are licensed to our JoyMarketplace store via the on-chain
 * `app:publish-to-marketplace` channel (publishAndForget mint + EditionController
 * store drop on Arbitrum). There is no app-unpublish path yet (each publish
 * mints a fresh DropERC1155 token), so the unpublish stub throws.
 */

import {
  makeUsePublishAsset,
  type PublishAssetConfig,
} from "./use_publish_asset";
import { IpcClient } from "../ipc/ipc_client";

const client = IpcClient.getInstance();

export const appPublishConfig: PublishAssetConfig<number> = {
  queryKey: "apps",
  publish: (payload) => client.appPublishToMarketplace(payload),
  unpublish: async () => {
    throw new Error(
      "App unpublish is not implemented — each publish mints a new on-chain token.",
    );
  },
};

export const usePublishApp = makeUsePublishAsset(appPublishConfig);
