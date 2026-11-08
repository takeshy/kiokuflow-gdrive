import type { WorkspaceFile, WorkspaceFilesAPI } from "./types";

export const WORKSPACE_FOLDER = "KiokuFlow";
export const LEGACY_WORKSPACE_FOLDER = "GemiHub";
export const BACKUP_DIRECTORY = `${WORKSPACE_FOLDER}/conflict-backups`;

const pending = new WeakMap<WorkspaceFilesAPI, Promise<WorkspaceFile[]>>();

/** Migrate before exposing an inventory to sync. Coalesce concurrent checks. */
export function workspaceInventory(files: WorkspaceFilesAPI): Promise<WorkspaceFile[]> {
  const existing = pending.get(files);
  if (existing) return existing;
  const run = migrate(files).finally(() => pending.delete(files));
  pending.set(files, run);
  return run;
}

async function migrate(files: WorkspaceFilesAPI): Promise<WorkspaceFile[]> {
  const inventory = await files.inventory();
  const legacy = inventory.filter(file => file.path.startsWith(`${LEGACY_WORKSPACE_FOLDER}/`));
  if (!legacy.length) return inventory;
  const destinations = new Set(inventory.map(file => file.path));
  const directories = new Set<string>();
  await files.createDirectory(WORKSPACE_FOLDER);
  for (const file of legacy) {
    const destination = WORKSPACE_FOLDER + file.path.slice(LEGACY_WORKSPACE_FOLDER.length);
    const parent = destination.slice(0, destination.lastIndexOf("/"));
    await files.createDirectory(parent);
    if (destinations.has(destination)) {
      const raw = await files.read(file.path);
      let content: string | ArrayBuffer = raw;
      if (file.binary) {
        const binary = atob(raw.slice(raw.indexOf(",") + 1));
        content = Uint8Array.from(binary, char => char.charCodeAt(0)).buffer;
      }
      await files.update(destination, content);
      await files.delete(file.path);
    } else await files.rename(file.path, destination);
    destinations.add(destination);
    for (let parent = file.path.slice(0, file.path.lastIndexOf("/")); parent; parent = parent.slice(0, parent.lastIndexOf("/"))) {
      directories.add(parent);
      if (!parent.includes("/")) break;
    }
  }
  // The host only deletes empty directories; unreadable/unlisted files survive.
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    await files.delete(directory).catch(() => undefined);
  }
  return files.inventory();
}
