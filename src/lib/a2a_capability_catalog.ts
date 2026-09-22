/**
 * Which A2A capability names map to which IPC channels.
 *
 * Deliberately a leaf module with no imports. The executors that use this table
 * pull in the whole economy engine — and through it Celestia, DID and Electron
 * `app` paths that are read at module load — so anything that only wants to
 * *describe* the catalogue (the MCP tool, the UI, a test) reads it from here
 * instead and stays cheap to import.
 */

export const CAPABILITY_CHANNELS: Record<string, string> = {
  "image.generate": "image-studio:generate",
  "video.generate": "video-studio:generate",
  "video.process": "media-pipeline:process-video",
  "document.create": "libreoffice:create",
  "document.export": "libreoffice:export",
  "dataset.create": "dataset-studio:create-dataset",
  "dataset.generate": "dataset-studio:create-generation-job",
  "skill.create": "skill:create",
};

/** True when a capability is backed by a handler rather than the echo stub. */
export function isRealCapability(capability: string): boolean {
  return capability in CAPABILITY_CHANNELS;
}
