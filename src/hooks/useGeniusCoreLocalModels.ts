import { useCallback, useMemo } from "react";
import { useAtom } from "jotai";
import {
  geniusCoreModelsAtom,
  geniusCoreModelsLoadingAtom,
  geniusCoreModelsErrorAtom,
} from "@/atoms/localModelsAtoms";
import { IpcClient } from "@/ipc/ipc_client";

/**
 * Loads the Genius Core curated base-model catalogue via IPC.
 *
 * Mirrors `useLocalModels` (Ollama) and `useLocalLMSModels` so the
 * `ModelPicker` can treat all three local providers uniformly. Returns
 * an empty list when Genius Core is disabled in settings (handler-side).
 */
export function useGeniusCoreLocalModels() {
  const [models, setModels] = useAtom(geniusCoreModelsAtom);
  const [loading, setLoading] = useAtom(geniusCoreModelsLoadingAtom);
  const [error, setError] = useAtom(geniusCoreModelsErrorAtom);

  const ipcClient = useMemo(() => IpcClient.getInstance(), []);

  const loadModels = useCallback(async () => {
    setLoading(true);
    try {
      const modelList = await ipcClient.listLocalGeniusCoreModels();
      setModels(modelList);
      setError(null);
      return modelList;
    } catch (err) {
      console.error("Error loading Genius Core models:", err);
      setError(err instanceof Error ? err : new Error(String(err)));
      return [];
    } finally {
      setLoading(false);
    }
  }, [ipcClient, setModels, setError, setLoading]);

  return { models, loading, error, loadModels };
}
