import { createConnection, refreshSession, unlockConnection, type Session, type StoredConnection } from "./auth";
import { conflictBackupName, createRemote, ensureFolder, isUserExcludedPath, listRootFiles, metaFromFiles, moveRemote, readRemote, readSyncMeta, renameRemote, syncablePath, updateRemote, writeSyncMeta } from "./drive";
import { guessMimeType, shouldTreatAsBinaryFile } from "gemihub-sync-core/files";
import { duplicateRemotePaths as coreDuplicateRemotePaths, syncMetaSnapshotChanged } from "gemihub-sync-core/protocol";
import type { ConflictInfo, FileSyncMeta, LocalSyncMeta, PluginAPI, Workspace, WorkspaceFile, SyncMeta, SyncProgress, SyncStatus, SyncSummary, WorkspaceFilesAPI } from "./types";
import { BACKUP_DIRECTORY, WORKSPACE_FOLDER, workspaceInventory } from "./workspace";

const CONNECTION_KEY = "connection";
const SNAPSHOT_KEY = "syncSnapshot";
export const EXCLUDE_PATTERNS_KEY = "excludePatterns";
// Text/binary classification and MIME types come from the table shared with
// kiokuflow web and Obsidian (gemihub-sync-core/files).
export function isTextPath(path: string): boolean { return !shouldTreatAsBinaryFile(path); }

export function isBinaryPath(path: string): boolean { return shouldTreatAsBinaryFile(path); }

function mimeType(path: string): string { return guessMimeType(path); }

function decodeDataURL(value: string): ArrayBuffer {
  const encoded = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function emptySnapshot(workspaceId: string): LocalSyncMeta { return { workspaceId, lastUpdatedAt: "", files: {}, pathToId: {} }; }
function sorted(values: Iterable<string>): string[] { return [...new Set(values)].sort((a, b) => a.localeCompare(b)); }
function pathKey(path: string, caseInsensitive = false): string { return caseInsensitive ? path.toLowerCase() : path; }
function isWindowsWorkspace(workspace: Workspace): boolean { return /^[a-z]:[\\/]/i.test(workspace.path) || workspace.path.startsWith("\\\\"); }

export function duplicateRemotePaths(remote: SyncMeta, caseInsensitive = false): string[] {
  return coreDuplicateRemotePaths(remote.files, caseInsensitive);
}

export interface DuplicateGroup { path: string; files: { id: string; file: FileSyncMeta }[] }

export function duplicateRemoteGroups(remote: SyncMeta, caseInsensitive = false): DuplicateGroup[] {
  const groups = new Map<string, DuplicateGroup>();
  for (const [id, file] of Object.entries(remote.files)) {
    const key = pathKey(file.name, caseInsensitive);
    const group = groups.get(key) ?? { path: file.name, files: [] };
    group.files.push({ id, file }); groups.set(key, group);
  }
  return [...groups.values()].filter((group) => group.files.length > 1);
}

export class DuplicateRemoteError extends Error {
  constructor(public groups: DuplicateGroup[]) {
    super("Google Drive has duplicate paths. Review the copies below and choose which one to keep.");
    this.name = "DuplicateRemoteError";
  }
}

export function assertCurrentDuplicate(requested: DuplicateGroup, remote: SyncMeta, caseInsensitive = false): DuplicateGroup {
  const current = duplicateRemoteGroups(remote, caseInsensitive).find((group) => pathKey(group.path, caseInsensitive) === pathKey(requested.path, caseInsensitive));
  const snapshot = (group: DuplicateGroup): SyncMeta => ({ lastUpdatedAt: "", files: Object.fromEntries(group.files.map(({ id, file }) => [id, file])) });
  if (!current || remoteSnapshotChanged(snapshot(requested), snapshot(current))) {
    throw new Error("These Drive copies changed. Run Check again before choosing.");
  }
  return current;
}

export function remoteSnapshotChanged(expected: SyncMeta, current: SyncMeta): boolean {
  return syncMetaSnapshotChanged(expected.files, current.files);
}

function resolveLocalIds(inventory: WorkspaceFile[], baseline: LocalSyncMeta, caseInsensitive = false): Map<string, string> {
  const resolved = new Map<string, string>();
  const claimedIds = new Set<string>();
  const baselinePaths = new Map(Object.entries(baseline.pathToId).map(([path, id]) => [pathKey(path, caseInsensitive), id]));

  // Exact paths are unambiguous, even when several files have the same checksum.
  for (const local of inventory) {
    const id = baselinePaths.get(pathKey(local.path, caseInsensitive));
    if (id && baseline.files[id]) { resolved.set(local.path, id); claimedIds.add(id); }
  }

  // A checksum-preserving rename is safe once the remaining old and new paths
  // form a same-size group: with equal counts every id can be paired with a
  // local file of identical content, so no delete+create churn is needed even
  // though the exact pairing (which id gets which path) is arbitrary. A
  // mismatched count is genuinely ambiguous (e.g. one of several duplicate-
  // content files really was deleted) and is left unresolved.
  const oldByChecksum = new Map<string, string[]>();
  for (const [id, previous] of Object.entries(baseline.files)) {
    if (claimedIds.has(id) || inventory.some((file) => pathKey(file.path, caseInsensitive) === pathKey(previous.name, caseInsensitive))) continue;
    const ids = oldByChecksum.get(previous.md5Checksum) ?? [];
    ids.push(id); oldByChecksum.set(previous.md5Checksum, ids);
  }
  const localByChecksum = new Map<string, WorkspaceFile[]>();
  for (const local of inventory) {
    if (resolved.has(local.path)) continue;
    const files = localByChecksum.get(local.md5) ?? [];
    files.push(local); localByChecksum.set(local.md5, files);
  }
  for (const [checksum, ids] of oldByChecksum) {
    const locals = localByChecksum.get(checksum) ?? [];
    if (ids.length === 0 || ids.length !== locals.length) continue;
    const sortedIds = [...ids].sort();
    const sortedLocals = [...locals].sort((a, b) => a.path.localeCompare(b.path));
    sortedIds.forEach((id, index) => resolved.set(sortedLocals[index].path, id));
  }
  return resolved;
}

export function computeLocalChangePaths(inventory: WorkspaceFile[], baseline: LocalSyncMeta, caseInsensitive = false): string[] {
  const localIds = resolveLocalIds(inventory, baseline, caseInsensitive);
  return sorted(inventory.flatMap((local) => {
    const id = localIds.get(local.path);
    const previous = id ? baseline.files[id] : undefined;
    return !previous || previous.md5Checksum !== local.md5 || pathKey(previous.name, caseInsensitive) !== pathKey(local.path, caseInsensitive)
      ? [local.path]
      : [];
  }));
}

export interface UnresolvedBaselineEntry { id: string; previous: LocalSyncMeta["files"][string]; currentRemote: FileSyncMeta | undefined }

/**
 * Baseline ids whose local file no longer resolves to them: either a real
 * delete, or an orphaned duplicate left over from a past rename. Grouped by
 * id (never collapsed by name) so that distinct Drive objects that happen to
 * share a `name` — including a stale duplicate sharing a name with a file
 * that is still live and synced under a different id — are never confused
 * with each other when deciding what actually gets moved to trash.
 */
export function unresolvedBaselineEntries(localIds: Map<string, string>, baseline: LocalSyncMeta, remote: SyncMeta): UnresolvedBaselineEntry[] {
  const claimedIds = new Set(localIds.values());
  return Object.entries(baseline.files)
    .filter(([id]) => !claimedIds.has(id))
    .map(([id, previous]) => ({ id, previous, currentRemote: remote.files[id] }));
}

export async function parallelForEach<T>(items: T[], worker: (item: T) => Promise<void>, concurrency = 5): Promise<void> {
  let next = 0;
  let failure: unknown;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (failure === undefined) {
      const index = next++;
      if (index >= items.length) return;
      try { await worker(items[index]); }
      catch (error) { failure = error; }
    }
  });
  await Promise.all(runners);
  if (failure !== undefined) throw failure;
}

/**
 * Snapshot of the last known synchronized state. A remote entry is adopted only
 * when the local file matches it; otherwise the previous baseline entry is kept
 * so pending local edits, renames, deletes, and unresolved conflicts survive a
 * pull or a partial conflict resolution.
 */
export function computeSnapshot(workspaceId: string, remote: SyncMeta, inventory: WorkspaceFile[], baseline: LocalSyncMeta, caseInsensitive = false): LocalSyncMeta {
  const localByPath = new Map(inventory.map((file) => [pathKey(file.path, caseInsensitive), file]));
  const localIds = resolveLocalIds(inventory, baseline, caseInsensitive);
  const localById = new Map([...localIds].map(([path, id]) => [id, localByPath.get(pathKey(path, caseInsensitive))!]));
  const liveRemotePaths = new Set(Object.values(remote.files).map((file) => pathKey(file.name, caseInsensitive)));
  const files: LocalSyncMeta["files"] = {}, pathToId: Record<string, string> = {};
  for (const [id, file] of Object.entries(remote.files)) {
    const local = localByPath.get(pathKey(file.name, caseInsensitive));
    const previous = baseline.files[id];
    let entry: LocalSyncMeta["files"][string] | undefined;
    if (local && (!file.md5Checksum || local.md5 === file.md5Checksum)) entry = { name: file.name, md5Checksum: file.md5Checksum || local.md5 };
    else if (previous) entry = previous;
    if (!entry) continue;
    files[id] = entry; pathToId[entry.name] = id;
  }

  // Keep the last synchronized identity for files deleted on Drive while the
  // corresponding local file still exists. Dropping it here turns an
  // unresolved remote deletion into an untracked local file, so the next
  // status check incorrectly offers it as a normal create-on-push action.
  // A live remote file at the same path means conflict resolution already
  // recreated/replaced the old ID; in that case the stale ID must disappear.
  for (const [id, previous] of Object.entries(baseline.files)) {
    if (remote.files[id]) continue;
    const local = localById.get(id);
    if (!local || liveRemotePaths.has(pathKey(local.path, caseInsensitive))) continue;
    files[id] = previous;
    pathToId[local.path] = id;
  }
  return { workspaceId, lastUpdatedAt: remote.lastUpdatedAt, files, pathToId };
}

export function adoptResolvedConflicts(snapshot: LocalSyncMeta, remote: SyncMeta, conflicts: ConflictInfo[], caseInsensitive = false): LocalSyncMeta {
  const files = { ...snapshot.files };
  const pathToId = { ...snapshot.pathToId };
  for (const conflict of conflicts) {
    delete files[conflict.id];
    for (const [path, id] of Object.entries(pathToId)) if (id === conflict.id) delete pathToId[path];
    const remoteEntry = remote.files[conflict.id]
      ? { id: conflict.id, file: remote.files[conflict.id] }
      : Object.entries(remote.files).map(([id, file]) => ({ id, file })).find(({ file }) =>
        [conflict.path, conflict.remoteName].some((path) => path && pathKey(path, caseInsensitive) === pathKey(file.name, caseInsensitive))
      );
    if (!remoteEntry) continue;
    files[remoteEntry.id] = { name: remoteEntry.file.name, md5Checksum: remoteEntry.file.md5Checksum };
    pathToId[remoteEntry.file.name] = remoteEntry.id;
  }
  return { ...snapshot, files, pathToId };
}

export interface PushAction { local: WorkspaceFile; id: string | undefined; rename: boolean; upload: "create" | "update" | null }

export interface ConflictPreview {
  binary: boolean;
  local: { exists: boolean; name: string; size?: number; md5?: string; text?: string };
  remote: { exists: boolean; name: string; size?: number; md5?: string; text?: string };
}

export function planPush(inventory: WorkspaceFile[], baseline: LocalSyncMeta, remote: SyncMeta, caseInsensitive = false): PushAction[] {
  const localIds = resolveLocalIds(inventory, baseline, caseInsensitive);
  return inventory.map((local) => {
    let id = localIds.get(local.path);
    if (!id) {
      const sameRemote = Object.entries(remote.files).filter(([, file]) => pathKey(file.name, caseInsensitive) === pathKey(local.path, caseInsensitive) && file.md5Checksum === local.md5);
      if (sameRemote.length === 1) id = sameRemote[0][0];
    }
    // For untracked files adopted through a name+checksum match the remote file
    // itself is the last known state; comparing against the (empty) baseline
    // would re-upload and re-name identical content on the first push.
    const known = id ? baseline.files[id] ?? remote.files[id] : undefined;
    const rename = !!id && !!remote.files[id] && !!known && pathKey(known.name, caseInsensitive) !== pathKey(local.path, caseInsensitive);
    const upload: PushAction["upload"] = id && known && known.md5Checksum === local.md5 ? null : id && remote.files[id] ? "update" : "create";
    return { local, id, rename, upload };
  });
}

export function computeStatus(inventory: WorkspaceFile[], baseline: LocalSyncMeta, remote: SyncMeta, caseInsensitive = false): SyncStatus {
  const localByPath = new Map(inventory.map((file) => [pathKey(file.path, caseInsensitive), file]));
  const remoteByName = new Map(Object.entries(remote.files).map(([id, file]) => [pathKey(file.name, caseInsensitive), { id, file }]));
  const localIds = resolveLocalIds(inventory, baseline, caseInsensitive);
  const localChanges: string[] = [], remoteChanges: string[] = [], localOnly: string[] = [], remoteOnly: string[] = [], localDeletes: string[] = [], remoteDeletes: string[] = [];
  const conflicts: ConflictInfo[] = [];

  for (const local of inventory) {
    const id = localIds.get(local.path);
    if (!id) {
      const samePath = remoteByName.get(pathKey(local.path, caseInsensitive));
      if (!samePath) localOnly.push(local.path);
      else if (samePath.file.md5Checksum !== local.md5) conflicts.push({ path: local.path, id: samePath.id, remoteName: samePath.file.name, kind: "untracked" });
      continue;
    }
    const previous = baseline.files[id];
    const currentRemote = remote.files[id];
    if (currentRemote && currentRemote.md5Checksum === local.md5 && pathKey(currentRemote.name, caseInsensitive) === pathKey(local.path, caseInsensitive)) continue;
    const localChanged = !previous || previous.md5Checksum !== local.md5 || pathKey(previous.name, caseInsensitive) !== pathKey(local.path, caseInsensitive);
    const remoteChanged = !!previous && !!currentRemote && (previous.md5Checksum !== currentRemote.md5Checksum || pathKey(previous.name, caseInsensitive) !== pathKey(currentRemote.name, caseInsensitive));
    if (!currentRemote) {
      if (localChanged) conflicts.push({ path: local.path, id, remoteName: null, kind: "localEditRemoteDelete" }); else remoteDeletes.push(previous.name);
    } else if (localChanged && remoteChanged) conflicts.push({ path: local.path, id, remoteName: currentRemote.name, kind: "edit" });
    else if (localChanged) localChanges.push(local.path);
    else if (remoteChanged) remoteChanges.push(currentRemote.name);
  }

  for (const { id, previous, currentRemote } of unresolvedBaselineEntries(localIds, baseline, remote)) {
    if (!currentRemote) continue;
    const remoteChanged = previous.md5Checksum !== currentRemote.md5Checksum || previous.name !== currentRemote.name;
    if (remoteChanged) conflicts.push({ path: previous.name, id, remoteName: currentRemote.name, kind: "localDeleteRemoteEdit" }); else localDeletes.push(previous.name);
  }
  for (const [id, file] of Object.entries(remote.files)) {
    if (!baseline.files[id] && !localByPath.has(pathKey(file.name, caseInsensitive))) remoteOnly.push(file.name);
  }
  return { localChanges: sorted(localChanges), remoteChanges: sorted(remoteChanges), localOnly: sorted(localOnly), remoteOnly: sorted(remoteOnly), localDeletes: sorted(localDeletes), remoteDeletes: sorted(remoteDeletes), conflicts: conflicts.sort((a, b) => a.path.localeCompare(b.path)) };
}

export class WorkspaceDriveSync {
  private session: Session | null = null;
  private sessionRefresh: Promise<Session> | null = null;
  constructor(private api: PluginAPI) {
    if (!api.workspaceFiles || !api.storage || !api.network) throw new Error("This plugin requires Workspace files, storage, and network APIs from kiokuflow Desktop.");
  }

  isUnlocked(): boolean { return this.session !== null; }

  private async workspaceFiles(_expected?: Workspace): Promise<WorkspaceFilesAPI> {
    return this.api.workspaceFiles!;
  }

  async connection(): Promise<StoredConnection | null> { return await this.api.storage!.get(CONNECTION_KEY) as StoredConnection | null; }
  async setup(token: string): Promise<StoredConnection> {
    const workspace = await (await this.workspaceFiles()).current();
    if (!workspace) throw new Error("Select a Workspace before connecting Google Drive.");
    const connection = await createConnection(this.api, token, workspace);
    await this.api.storage!.set(CONNECTION_KEY, connection);
    await this.api.storage!.set(SNAPSHOT_KEY, null);
    return connection;
  }
  async reset(): Promise<void> { this.session = null; this.sessionRefresh = null; await this.api.storage!.set(CONNECTION_KEY, null); await this.api.storage!.set(SNAPSHOT_KEY, null); }
  async unlock(password: string): Promise<void> {
    const connection = await this.connection();
    if (!connection) throw new Error("Google Drive is not connected.");
    await this.assertWorkspace(connection);
    this.session = await unlockConnection(this.api, connection, password);
  }
  private async assertWorkspace(connection?: StoredConnection): Promise<StoredConnection> {
    const saved = connection ?? await this.connection();
    if (!saved) throw new Error("Google Drive is not connected.");
    const current = await (await this.workspaceFiles(saved.workspace)).current();
    if (!current) throw new Error("Select a Workspace before syncing.");
    if (current.id !== saved.workspace.id || current.path !== saved.workspace.path) {
      throw new Error(`This connection belongs to Workspace “${saved.workspace.name}”. Switch back to that Workspace before syncing, or reset the connection.`);
    }
    return saved;
  }
  private async tokens(): Promise<Session> {
    await this.assertWorkspace();
    if (!this.session) throw new Error("Unlock the connection first.");
    if (!this.sessionRefresh) {
      this.sessionRefresh = refreshSession(this.api, this.session).finally(() => { this.sessionRefresh = null; });
    }
    this.session = await this.sessionRefresh;
    return this.session;
  }
  private async snapshot(workspaceId: string): Promise<LocalSyncMeta> {
    const value = await this.api.storage!.get(SNAPSHOT_KEY) as LocalSyncMeta | null;
    return value?.workspaceId === workspaceId ? value : emptySnapshot(workspaceId);
  }
  private async excludePatterns(): Promise<string[]> {
    const value = await this.api.storage!.get(EXCLUDE_PATTERNS_KEY) as string[] | null;
    return Array.isArray(value) ? value : [];
  }
  private async inventory(): Promise<WorkspaceFile[]> {
    const patterns = await this.excludePatterns();
    return (await workspaceInventory(await this.workspaceFiles())).filter((file) => syncablePath(file.path) && !isUserExcludedPath(file.path, patterns));
  }
  private async state(): Promise<{ session: Session; inventory: WorkspaceFile[]; baseline: LocalSyncMeta; remote: SyncMeta; status: SyncStatus }> {
    const connection = await this.assertWorkspace();
    const session = await this.tokens();
    const [inventory, baseline, rawRemote, patterns] = await Promise.all([this.inventory(), this.snapshot(connection.workspace.id), readSyncMeta(this.api, session.accessToken, session.rootFolderId), this.excludePatterns()]);
    // Excluded files are dropped from the working remote view so they are
    // never proposed for pull/push, but the raw Drive listing (used when
    // rewriting `_sync-meta.json`) still preserves their entries untouched.
    const remote: SyncMeta = patterns.length ? { ...rawRemote, files: Object.fromEntries(Object.entries(rawRemote.files).filter(([, file]) => !isUserExcludedPath(file.name, patterns))) } : rawRemote;
    const caseInsensitive = isWindowsWorkspace(connection.workspace);
    const duplicates = duplicateRemoteGroups(remote, caseInsensitive);
    if (duplicates.length) throw new DuplicateRemoteError(duplicates);
    return { session, inventory, baseline, remote, status: computeStatus(inventory, baseline, remote, caseInsensitive) };
  }
  async status(): Promise<SyncStatus> { return (await this.state()).status; }
  async duplicatePreview(group: DuplicateGroup): Promise<Record<string, string>> {
    const connection = await this.assertWorkspace();
    const session = await this.tokens();
    const remote = await readSyncMeta(this.api, session.accessToken, session.rootFolderId);
    const current = assertCurrentDuplicate(group, remote, isWindowsWorkspace(connection.workspace));
    const entries = await Promise.all(current.files.map(async ({ id, file }) =>
      [id, isTextPath(file.name) ? (await readRemote(this.api, session.accessToken, id)).text : "Binary file — compare size and checksum above."] as const));
    return Object.fromEntries(entries);
  }

  /** Keep the chosen Drive identity; preserve all other copies in kiokuflow trash. */
  async resolveDuplicate(group: DuplicateGroup, keepId: string): Promise<void> {
    const connection = await this.assertWorkspace();
    const session = await this.tokens();
    const remote = await readSyncMeta(this.api, session.accessToken, session.rootFolderId);
    const current = assertCurrentDuplicate(group, remote, isWindowsWorkspace(connection.workspace));
    if (!current.files.some(({ id }) => id === keepId)) throw new Error("Choose a file from this duplicate group.");
    const baseline = await this.snapshot(connection.workspace.id);
    const trash = await ensureFolder(this.api, session.accessToken, session.rootFolderId, "trash");
    for (const { id } of current.files) {
      if (id !== keepId) await moveRemote(this.api, session.accessToken, id, session.rootFolderId, trash);
    }
    // Transfer the previous synchronized content to the chosen identity. This
    // preserves local edits and lets normal conflict handling compare both sides.
    const ids = new Set(current.files.map(({ id }) => id));
    const previousId = Object.entries(baseline.pathToId).find(([path, id]) =>
      pathKey(path, isWindowsWorkspace(connection.workspace)) === pathKey(group.path, isWindowsWorkspace(connection.workspace)) && ids.has(id))?.[1];
    const previous = previousId ? baseline.files[previousId] : undefined;
    for (const id of ids) delete baseline.files[id];
    for (const [path, id] of Object.entries(baseline.pathToId)) if (ids.has(id)) delete baseline.pathToId[path];
    if (previous) { baseline.files[keepId] = previous; baseline.pathToId[previous.name] = keepId; }
    await this.api.storage!.set(SNAPSHOT_KEY, baseline);
    const next = metaFromFiles(await listRootFiles(this.api, session.accessToken, session.rootFolderId));
    await writeSyncMeta(this.api, session.accessToken, session.rootFolderId, next);
  }

  async localChangePaths(): Promise<string[]> {
    const connection = await this.connection();
    if (!connection) return [];
    await this.assertWorkspace(connection);
    const [inventory, baseline] = await Promise.all([
      this.inventory(),
      this.snapshot(connection.workspace.id),
    ]);
    return computeLocalChangePaths(inventory, baseline, isWindowsWorkspace(connection.workspace));
  }

  /** Read both sides of a current conflict without changing either side. */
  async conflictPreview(requested: ConflictInfo): Promise<ConflictPreview> {
    const connection = await this.assertWorkspace();
    const files = await this.workspaceFiles(connection.workspace);
    const { session, inventory, remote, status } = await this.state();
    const conflict = status.conflicts.find((item) => item.path === requested.path && item.kind === requested.kind);
    if (!conflict) throw new Error("This conflict is no longer current. Run Check again.");

    const local = inventory.find((file) => file.path === conflict.path);
    const remoteFile = remote.files[conflict.id];
    const binary = Boolean(local?.binary || (remoteFile && isBinaryPath(remoteFile.name)));
    const preview: ConflictPreview = {
      binary,
      local: { exists: !!local, name: conflict.path, size: local?.size, md5: local?.md5 },
      remote: {
        exists: !!remoteFile,
        name: remoteFile?.name ?? conflict.remoteName ?? conflict.path,
        size: remoteFile?.size ? Number(remoteFile.size) : undefined,
        md5: remoteFile?.md5Checksum,
      },
    };
    if (!binary) {
      if (local) preview.local.text = await files.read(conflict.path);
      if (remoteFile) preview.remote.text = (await readRemote(this.api, session.accessToken, conflict.id)).text;
    }
    return preview;
  }

  async fileComparison(path: string): Promise<ConflictPreview> {
    const connection = await this.assertWorkspace();
    const files = await this.workspaceFiles(connection.workspace);
    const { session, inventory, baseline, remote } = await this.state();
    const caseInsensitive = isWindowsWorkspace(connection.workspace);
    const local = inventory.find((file) => pathKey(file.path, caseInsensitive) === pathKey(path, caseInsensitive));
    const localIds = resolveLocalIds(inventory, baseline, caseInsensitive);
    const id = local ? localIds.get(local.path) : baseline.pathToId[path];
    const remoteEntry = id && remote.files[id]
      ? { id, file: remote.files[id] }
      : Object.entries(remote.files).map(([remoteId, file]) => ({ id: remoteId, file }))
        .find(({ file }) => pathKey(file.name, caseInsensitive) === pathKey(path, caseInsensitive));
    const remoteFile = remoteEntry?.file;
    const binary = Boolean(local?.binary || (remoteFile && isBinaryPath(remoteFile.name)));
    const comparison: ConflictPreview = {
      binary,
      local: { exists: !!local, name: local?.path ?? path, size: local?.size, md5: local?.md5 },
      remote: { exists: !!remoteFile, name: remoteFile?.name ?? path, size: remoteFile?.size ? Number(remoteFile.size) : undefined, md5: remoteFile?.md5Checksum },
    };
    if (!binary) {
      if (local) comparison.local.text = await files.read(local.path);
      if (remoteEntry) comparison.remote.text = (await readRemote(this.api, session.accessToken, remoteEntry.id)).text;
    }
    return comparison;
  }

  /** Replace one local file with its current Drive state (or delete it if Drive has no copy). */
  async resetFileToDrive(path: string): Promise<"updated" | "created" | "deleted" | "unchanged"> {
    const connection = await this.assertWorkspace();
    const files = await this.workspaceFiles(connection.workspace);
    const { session, inventory, baseline, remote } = await this.state();
    const caseInsensitive = isWindowsWorkspace(connection.workspace);
    const local = inventory.find((file) => pathKey(file.path, caseInsensitive) === pathKey(path, caseInsensitive));
    const localIds = resolveLocalIds(inventory, baseline, caseInsensitive);
    const baselineId = local ? localIds.get(local.path) : Object.entries(baseline.pathToId)
      .find(([candidate]) => pathKey(candidate, caseInsensitive) === pathKey(path, caseInsensitive))?.[1];
    const remoteEntry = baselineId && remote.files[baselineId]
      ? { id: baselineId, file: remote.files[baselineId] }
      : Object.entries(remote.files).map(([id, file]) => ({ id, file }))
        .find(({ file }) => pathKey(file.name, caseInsensitive) === pathKey(path, caseInsensitive));
    let result: "updated" | "created" | "deleted" | "unchanged" = "unchanged";
    if (!remoteEntry) {
      if (local) { await files.delete(local.path); result = "deleted"; }
    } else {
      const content = await readRemote(this.api, session.accessToken, remoteEntry.id);
      const value = isBinaryPath(remoteEntry.file.name) ? content.buffer : content.text;
      const target = inventory.find((file) => pathKey(file.path, caseInsensitive) === pathKey(remoteEntry.file.name, caseInsensitive));
      if (local && pathKey(local.path, caseInsensitive) !== pathKey(remoteEntry.file.name, caseInsensitive)) await files.delete(local.path);
      if (target) { await files.update(target.path, value); result = "updated"; }
      else { await files.create(remoteEntry.file.name, value); result = "created"; }
    }
    await this.saveSnapshot(connection.workspace, remote, await this.inventory(), baseline);
    return result;
  }

  private async saveSnapshot(workspace: Workspace, remote: SyncMeta, inventory: WorkspaceFile[], baseline: LocalSyncMeta): Promise<void> {
    await this.api.storage!.set(SNAPSHOT_KEY, computeSnapshot(workspace.id, remote, inventory, baseline, isWindowsWorkspace(workspace)));
  }

  async push(allowDeletes = false): Promise<SyncSummary> {
    const connection = await this.assertWorkspace();
    const files = await this.workspaceFiles(connection.workspace);
    const { session, inventory, baseline, remote, status } = await this.state();
    if (status.conflicts.length) throw new Error(`Resolve conflicts first: ${status.conflicts.map((conflict) => conflict.path).join(", ")}`);
    if (status.remoteChanges.length || status.remoteOnly.length || status.remoteDeletes.length) throw new Error("Google Drive has pending changes. Pull before pushing.");
    if (status.localDeletes.length && !allowDeletes) throw new Error(`Push will move ${status.localDeletes.length} remote file(s) to kiokuflow trash. Confirm deletion first.`);

    // Re-list Drive once immediately before applying the batch. This catches
    // edits/deletes/moves made after state() without adding one request per file.
    const patterns = await this.excludePatterns();
    const latestFiles = (await listRootFiles(this.api, session.accessToken, session.rootFolderId))
      .filter((file) => !isUserExcludedPath(file.name, patterns));
    const latestRemote = metaFromFiles(latestFiles);
    const caseInsensitive = isWindowsWorkspace(connection.workspace);
    const duplicates = duplicateRemoteGroups(latestRemote, caseInsensitive);
    if (duplicates.length) throw new DuplicateRemoteError(duplicates);
    if (remoteSnapshotChanged(remote, latestRemote)) throw new Error("Google Drive changed after the sync check. Run Check again before pushing.");

    const summary: SyncSummary = { created: 0, updated: 0, renamed: 0, deleted: 0, skipped: 0 };
    const renamedIds = new Set<string>();
    // Keep rename -> upload ordered within each file, while processing
    // independent files concurrently to avoid one Drive round trip at a time.
    await parallelForEach(planPush(inventory, baseline, remote, caseInsensitive), async (action) => {
      const activeSession = await this.tokens();
      const { local, id } = action;
      if (action.rename && id) {
        await renameRemote(this.api, activeSession.accessToken, id, local.path);
        renamedIds.add(id); summary.renamed++;
      }
      if (!action.upload) {
        if (!id || !renamedIds.has(id)) summary.skipped++;
        return;
      }
      const raw = await files.read(local.path);
      const content = local.binary ? decodeDataURL(raw) : raw;
      if (action.upload === "update" && id) { await updateRemote(this.api, activeSession.accessToken, id, content, mimeType(local.path)); summary.updated++; }
      else { await createRemote(this.api, activeSession.accessToken, activeSession.rootFolderId, local.path, content, mimeType(local.path)); summary.created++; }
    }, 5);
    if (status.localDeletes.length) {
      // Resolve delete targets by id, not by looking `pathToId[name]` back up:
      // when several Drive objects share a name (a stale duplicate left over
      // from a past rename, alongside the file still live under a different
      // id), a name-based lookup can resolve to the wrong — still current —
      // id and move it to trash instead of the actual orphan.
      const deleteSession = await this.tokens();
      const trash = await ensureFolder(this.api, deleteSession.accessToken, deleteSession.rootFolderId, "trash");
      const localIds = resolveLocalIds(inventory, baseline, caseInsensitive);
      const deletions = unresolvedBaselineEntries(localIds, baseline, remote).filter(({ id, previous, currentRemote }) => {
        if (!currentRemote || renamedIds.has(id)) return false;
        return previous.md5Checksum === currentRemote.md5Checksum && previous.name === currentRemote.name;
      });
      await parallelForEach(deletions, async ({ id }) => {
        const activeSession = await this.tokens();
        await moveRemote(this.api, activeSession.accessToken, id, activeSession.rootFolderId, trash);
        summary.deleted++;
      }, 5);
    }
    const finalSession = await this.tokens();
    const nextRemote = metaFromFiles(await listRootFiles(this.api, finalSession.accessToken, finalSession.rootFolderId));
    const writtenRemote = await writeSyncMeta(this.api, finalSession.accessToken, finalSession.rootFolderId, nextRemote);
    await this.saveSnapshot(connection.workspace, writtenRemote, await this.inventory(), baseline);
    return summary;
  }

  /** Make syncable local files match Drive, rebuilding identities after migration. */
  async fullPull(allowDeletes = false, onProgress?: (progress: SyncProgress) => void): Promise<SyncSummary> {
    const connection = await this.assertWorkspace();
    const files = await this.workspaceFiles(connection.workspace);
    const { inventory, remote } = await this.state();
    const caseInsensitive = isWindowsWorkspace(connection.workspace);
    const key = (path: string) => pathKey(path, caseInsensitive);
    const localByPath = new Map(inventory.map(file => [key(file.path), file]));
    const remotePaths = new Set(Object.values(remote.files).map(file => key(file.name)));
    const deletes = inventory.filter(file => !remotePaths.has(key(file.path)));
    if (deletes.length && !allowDeletes) throw new Error(`Full pull will delete ${deletes.length} local file(s). Confirm deletion first.`);
    const summary: SyncSummary = { created: 0, updated: 0, renamed: 0, deleted: 0, skipped: 0 };
    const entries = Object.entries(remote.files);
    let completed = 0;
    onProgress?.({ phase: "pull", completed, total: entries.length });
    await parallelForEach(entries, async ([id, file]) => {
      try {
        const local = localByPath.get(key(file.name));
        if (local && file.md5Checksum && local.md5 === file.md5Checksum) summary.skipped++;
        else {
          const session = await this.tokens();
          const content = await readRemote(this.api, session.accessToken, id);
          const value = isBinaryPath(file.name) ? content.buffer : content.text;
          if (local) { await files.update(local.path, value); summary.updated++; }
          else { await files.create(file.name, value); summary.created++; }
        }
        completed++;
        onProgress?.({ phase: "pull", completed, total: entries.length, path: file.name });
      } catch (error) {
        throw new Error(`Full pull failed for ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    // A failed download never proceeds to deletion or replaces the baseline.
    let deleted = 0;
    onProgress?.({ phase: "delete", completed: deleted, total: deletes.length });
    for (const file of deletes) {
      await files.delete(file.path); summary.deleted++; deleted++;
      onProgress?.({ phase: "delete", completed: deleted, total: deletes.length, path: file.path });
    }
    onProgress?.({ phase: "snapshot", completed: 0, total: 1 });
    await this.saveSnapshot(connection.workspace, remote, await this.inventory(), emptySnapshot(connection.workspace.id));
    onProgress?.({ phase: "snapshot", completed: 1, total: 1 });
    return summary;
  }

  async pull(allowDeletes = false, onProgress?: (progress: SyncProgress) => void): Promise<SyncSummary> {
    const connection = await this.assertWorkspace();
    const workspaceFiles = await this.workspaceFiles(connection.workspace);
    const { session, inventory, baseline, remote, status } = await this.state();
    if (status.conflicts.length) throw new Error(`Resolve conflicts first: ${status.conflicts.map((conflict) => conflict.path).join(", ")}`);
    if (status.remoteDeletes.length && !allowDeletes) throw new Error(`Pull will delete ${status.remoteDeletes.length} local file(s). Confirm deletion first.`);
    const summary: SyncSummary = { created: 0, updated: 0, renamed: 0, deleted: 0, skipped: 0 };
    const caseInsensitive = isWindowsWorkspace(connection.workspace);
    const localByPath = new Map(inventory.map((file) => [pathKey(file.path, caseInsensitive), file]));
    const files = Object.entries(remote.files);
    let completed = 0;
    onProgress?.({ phase: "pull", completed, total: files.length });
    await parallelForEach(files, async ([id, file]) => {
      try {
        const previous = baseline.files[id];
        // A remote file unchanged since the baseline has nothing to pull;
        // leave the local side alone so pending local edits, renames, and
        // deletes survive until the next push.
        if (previous && previous.md5Checksum === file.md5Checksum && previous.name === file.name) {
          summary.skipped++;
          completed++;
          onProgress?.({ phase: "pull", completed, total: files.length, path: file.name });
          return;
        }
        let local = localByPath.get(pathKey(file.name, caseInsensitive));
        if (previous && pathKey(previous.name, caseInsensitive) !== pathKey(file.name, caseInsensitive) && localByPath.has(pathKey(previous.name, caseInsensitive)) && !local) {
          await workspaceFiles.rename(previous.name, file.name); summary.renamed++;
          local = localByPath.get(pathKey(previous.name, caseInsensitive));
        }
        if (local?.md5 === file.md5Checksum) summary.skipped++;
        else {
          const activeSession = await this.tokens();
          const content = await readRemote(this.api, activeSession.accessToken, id);
          const value = isBinaryPath(file.name) ? content.buffer : content.text;
          if (local) { await workspaceFiles.update(file.name, value); summary.updated++; }
          else { await workspaceFiles.create(file.name, value); summary.created++; }
        }
        completed++;
        onProgress?.({ phase: "pull", completed, total: files.length, path: file.name });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Pull failed for ${file.name}: ${detail}`);
      }
    });
    if (status.remoteDeletes.length) {
      let deleted = 0;
      onProgress?.({ phase: "delete", completed: deleted, total: status.remoteDeletes.length });
      for (const path of status.remoteDeletes) {
        await workspaceFiles.delete(path); summary.deleted++; deleted++;
        onProgress?.({ phase: "delete", completed: deleted, total: status.remoteDeletes.length, path });
      }
    }
    onProgress?.({ phase: "snapshot", completed: 0, total: 1 });
    await this.saveSnapshot(connection.workspace, remote, await this.inventory(), baseline);
    onProgress?.({ phase: "snapshot", completed: 1, total: 1 });
    return summary;
  }

  /**
   * Resolve conflicts per file by choosing the surviving side, the same way the
   * kiokuflow Obsidian plugin does: the losing side is backed up to the local,
   * sync-excluded `KiokuFlow/conflict-backups/` folder first.
   */
  async resolveConflicts(resolutions: Array<{ conflict: ConflictInfo; choice: "local" | "remote"; backup?: boolean }>): Promise<number> {
    const connection = await this.assertWorkspace();
    const files = await this.workspaceFiles(connection.workspace);
    const { session, inventory, baseline, remote, status } = await this.state();
    const current = new Map(status.conflicts.map((conflict) => [conflict.path, conflict]));
    const localByPath = new Map(inventory.map((file) => [file.path, file]));
    let touchedRemote = false;
    let resolved = 0;
    const resolvedConflicts: ConflictInfo[] = [];
    const backupDirectory = BACKUP_DIRECTORY;

    const readLocal = async (path: string): Promise<string | ArrayBuffer> => {
      const raw = await files.read(path);
      return localByPath.get(path)?.binary ? decodeDataURL(raw) : raw;
    };
    const writeLocal = async (path: string, value: string | ArrayBuffer): Promise<void> => {
      if (localByPath.has(path)) await files.update(path, value);
      else await files.create(path, value);
    };
    let backupSequence = 0;
    const saveLocalBackup = async (path: string, value: string | ArrayBuffer): Promise<void> => {
      // Backups are deliberately local and excluded from sync. A sequence
      // suffix prevents two resolutions in the same millisecond overwriting.
      await files.createDirectory(WORKSPACE_FOLDER).catch(() => undefined);
      await files.createDirectory(backupDirectory).catch(() => undefined);
      const base = conflictBackupName(path, new Date());
      const dot = base.lastIndexOf(".");
      const suffix = `-${backupSequence++}`;
      const name = dot > 0 ? `${base.slice(0, dot)}${suffix}${base.slice(dot)}` : `${base}${suffix}`;
      await files.create(`${backupDirectory}/${name}`, value);
    };

    await parallelForEach(resolutions, async ({ conflict: requested, choice, backup = true }) => {
      const conflict = current.get(requested.path);
      if (!conflict || conflict.kind !== requested.kind) return;
      const remoteFile = remote.files[conflict.id];

      if (conflict.kind === "localEditRemoteDelete") {
        if (choice === "local") {
          await createRemote(this.api, session.accessToken, session.rootFolderId, conflict.path, await readLocal(conflict.path), mimeType(conflict.path));
          touchedRemote = true;
        } else {
          if (backup) await saveLocalBackup(conflict.path, await readLocal(conflict.path));
          await files.delete(conflict.path);
        }
      } else if (conflict.kind === "localDeleteRemoteEdit") {
        if (!remoteFile) return;
        if (choice === "local") {
          const trash = await ensureFolder(this.api, session.accessToken, session.rootFolderId, "trash");
          await moveRemote(this.api, session.accessToken, conflict.id, session.rootFolderId, trash);
          touchedRemote = true;
        } else {
          const content = await readRemote(this.api, session.accessToken, conflict.id);
          await writeLocal(remoteFile.name, isBinaryPath(remoteFile.name) ? content.buffer : content.text);
        }
      } else { // "edit" | "untracked": both sides exist
        if (!remoteFile) return;
        if (choice === "local") {
          if (backup) {
            const losingRemote = await readRemote(this.api, session.accessToken, conflict.id);
            await saveLocalBackup(remoteFile.name, isBinaryPath(remoteFile.name) ? losingRemote.buffer : losingRemote.text);
          }
          if (remoteFile.name !== conflict.path) await renameRemote(this.api, session.accessToken, conflict.id, conflict.path);
          await updateRemote(this.api, session.accessToken, conflict.id, await readLocal(conflict.path), mimeType(conflict.path));
          touchedRemote = true;
        } else {
          if (backup) await saveLocalBackup(conflict.path, await readLocal(conflict.path));
          const content = await readRemote(this.api, session.accessToken, conflict.id);
          if (remoteFile.name !== conflict.path) await files.delete(conflict.path);
          await writeLocal(remoteFile.name, isBinaryPath(remoteFile.name) ? content.buffer : content.text);
        }
      }
      resolvedConflicts.push(conflict);
      resolved++;
    }, 5);

    let finalRemote = remote;
    if (touchedRemote) {
      const nextRemote = metaFromFiles(await listRootFiles(this.api, session.accessToken, session.rootFolderId));
      finalRemote = await writeSyncMeta(this.api, session.accessToken, session.rootFolderId, nextRemote);
    }
    const nextSnapshot = computeSnapshot(connection.workspace.id, finalRemote, await this.inventory(), baseline, isWindowsWorkspace(connection.workspace));
    await this.api.storage!.set(SNAPSHOT_KEY, adoptResolvedConflicts(nextSnapshot, finalRemote, resolvedConflicts, isWindowsWorkspace(connection.workspace)));
    return resolved;
  }
}
