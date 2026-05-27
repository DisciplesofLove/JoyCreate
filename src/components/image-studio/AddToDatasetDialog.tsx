import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Plus, Database } from "lucide-react";

import { IpcClient } from "@/ipc/ipc_client";
import { getDatasetStudioClient, type StudioDataset } from "@/ipc/dataset_studio_client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const NEW_DATASET_VALUE = "__create_new__";

function inferMimeType(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    default: return "image/png";
  }
}

export function AddToDatasetDialog({
  open,
  onOpenChange,
  imageIds,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  imageIds: number[];
}) {
  const queryClient = useQueryClient();
  const dsClient = getDatasetStudioClient();

  const [selectedDatasetId, setSelectedDatasetId] = useState<string>("");
  const [newDatasetName, setNewDatasetName] = useState("");
  const [newDatasetDescription, setNewDatasetDescription] = useState("");
  const [newDatasetLicense, setNewDatasetLicense] = useState("CC-BY-4.0");

  const { data: datasets = [], isLoading: loadingDatasets } = useQuery<StudioDataset[]>({
    queryKey: ["dataset-studio", "list", "image"],
    queryFn: () => dsClient.listDatasets(),
    enabled: open,
  });

  const imageDatasets = datasets.filter((d) =>
    !d.supportedModalities?.length || d.supportedModalities.includes("image"),
  );

  const addMutation = useMutation({
    mutationFn: async () => {
      let datasetId = selectedDatasetId;

      if (datasetId === NEW_DATASET_VALUE) {
        const name = newDatasetName.trim();
        if (!name) throw new Error("Dataset name is required");
        const created = await dsClient.createDataset({
          name,
          description: newDatasetDescription.trim() || undefined,
          datasetType: "custom",
          license: newDatasetLicense,
          supportedModalities: ["image"],
        });
        datasetId = created.datasetId;
      }

      if (!datasetId) throw new Error("Select a dataset");

      let added = 0;
      const failures: string[] = [];
      for (const imageId of imageIds) {
        try {
          const img = await IpcClient.getInstance().getImage(imageId);
          await dsClient.addItemFromFile({
            datasetId,
            filePath: img.filePath,
            mimeType: inferMimeType(img.filePath),
            sourceType: "generated",
            license: newDatasetLicense,
            labels: img.prompt ? { caption: img.prompt } : undefined,
          });
          added += 1;
        } catch (err) {
          failures.push(err instanceof Error ? err.message : String(err));
        }
      }

      await dsClient.refreshStats(datasetId);
      return { added, failures, datasetId };
    },
    onSuccess: ({ added, failures }) => {
      queryClient.invalidateQueries({ queryKey: ["dataset-studio"] });
      if (failures.length > 0) {
        toast.warning(`Added ${added}/${imageIds.length} images. ${failures.length} failed.`);
      } else {
        toast.success(`Added ${added} image${added === 1 ? "" : "s"} to dataset`);
      }
      onOpenChange(false);
      setSelectedDatasetId("");
      setNewDatasetName("");
      setNewDatasetDescription("");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const isCreatingNew = selectedDatasetId === NEW_DATASET_VALUE;
  const canSubmit =
    !addMutation.isPending &&
    imageIds.length > 0 &&
    (isCreatingNew ? newDatasetName.trim().length > 0 : selectedDatasetId.length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Database className="w-4 h-4" /> Add to Image Dataset
          </DialogTitle>
          <DialogDescription>
            Bundle {imageIds.length} image{imageIds.length === 1 ? "" : "s"} into a Dataset Studio
            dataset. You can then publish the dataset to the marketplace.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label className="text-xs">Dataset</Label>
            <Select value={selectedDatasetId} onValueChange={setSelectedDatasetId}>
              <SelectTrigger>
                <SelectValue placeholder={loadingDatasets ? "Loading…" : "Choose a dataset"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NEW_DATASET_VALUE}>
                  <span className="flex items-center gap-2">
                    <Plus className="w-3 h-3" /> Create new dataset…
                  </span>
                </SelectItem>
                {imageDatasets.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name} <span className="text-muted-foreground">({d.itemCount} items)</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isCreatingNew && (
            <div className="space-y-3 rounded-md border border-dashed p-3">
              <div className="space-y-1">
                <Label className="text-xs">Name</Label>
                <Input
                  value={newDatasetName}
                  onChange={(e) => setNewDatasetName(e.target.value)}
                  placeholder="My AI image collection"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Description (optional)</Label>
                <Input
                  value={newDatasetDescription}
                  onChange={(e) => setNewDatasetDescription(e.target.value)}
                  placeholder="What this dataset is for…"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">License</Label>
                <Select value={newDatasetLicense} onValueChange={setNewDatasetLicense}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CC0-1.0">CC0 (Public Domain)</SelectItem>
                    <SelectItem value="CC-BY-4.0">CC BY 4.0</SelectItem>
                    <SelectItem value="CC-BY-SA-4.0">CC BY-SA 4.0</SelectItem>
                    <SelectItem value="CC-BY-NC-4.0">CC BY-NC 4.0</SelectItem>
                    <SelectItem value="commercial">Commercial (custom)</SelectItem>
                    <SelectItem value="proprietary">Proprietary</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={addMutation.isPending}>
            Cancel
          </Button>
          <Button onClick={() => addMutation.mutate()} disabled={!canSubmit}>
            {addMutation.isPending && <Loader2 className="w-3 h-3 mr-2 animate-spin" />}
            Add to Dataset
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
