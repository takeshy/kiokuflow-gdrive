import { request } from "./transport";
import { createDriveClient, headersFromRecord, type DriveFile, type DriveHttpResponse } from "gemihub-sync-core/drive";
import { buildConflictBackupName } from "gemihub-sync-core/conflict";
import { isGoogleWorkspaceMimeType, isSyncExcludedPath } from "gemihub-sync-core/paths";
import { reconcileSyncMetaWithListing, syncMetaFromDriveFiles } from "gemihub-sync-core/protocol";
import { createSyncMetaStore } from "gemihub-sync-core/sync-meta";
import type { PluginAPI, SyncMeta } from "./types";

// System names/folders, exclusion patterns and conflict names are shared with
// kiokuflow web and Obsidian through gemihub-sync-core.
export { SYNC_EXCLUDED_FILE_NAMES as SYSTEM_NAMES, SYNC_EXCLUDED_PREFIXES as SYSTEM_PREFIXES, isUserExcludedPath } from "gemihub-sync-core/paths";

export type { DriveFile };

export function isGoogleWorkspaceFile(file: Pick<DriveFile, "mimeType">): boolean {
  return isGoogleWorkspaceMimeType(file.mimeType);
}

export function syncableDriveFile(file: Pick<DriveFile, "name" | "mimeType">): boolean {
  return syncablePath(file.name) && !isGoogleWorkspaceFile(file);
}

/** Desktop keeps workspace state in `.llm-hub/`; everything else is the shared rule. */
export function syncablePath(path: string): boolean {
  return !isSyncExcludedPath(path, { extraSegments: [".llm-hub"] });
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// The Drive REST client (requests, retries, pagination, multipart, errors) is
// shared with kiokuflow web and Obsidian; Desktop's network API is the transport.
const clients = new WeakMap<PluginAPI, ReturnType<typeof createDriveClient>>();

function driveClient(api: PluginAPI) {
  let client = clients.get(api);
  if (!client) {
    client = createDriveClient(async (req): Promise<DriveHttpResponse> => {
      const response = await request(api, req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body instanceof Uint8Array ? toArrayBuffer(req.body) : req.body,
      });
      return {
        status: response.status,
        headers: headersFromRecord(response.headers),
        text: () => Promise.resolve(response.text),
        json: () => Promise.resolve(response.json),
        arrayBuffer: () => Promise.resolve(response.arrayBuffer),
      };
    });
    clients.set(api, client);
  }
  return client;
}

export async function listRootFiles(api: PluginAPI, accessToken: string, rootFolderId: string): Promise<DriveFile[]> {
  return (await driveClient(api).listFiles(accessToken, rootFolderId)).filter(syncableDriveFile);
}

export async function findByName(api: PluginAPI, accessToken: string, rootFolderId: string, name: string): Promise<DriveFile | null> {
  return (await findAllByName(api, accessToken, rootFolderId, name))[0] ?? null;
}

function findAllByName(api: PluginAPI, accessToken: string, rootFolderId: string, name: string): Promise<DriveFile[]> {
  return driveClient(api).findFilesByExactName(accessToken, name, rootFolderId);
}

export async function readRemote(api: PluginAPI, accessToken: string, id: string): Promise<{ text: string; buffer: ArrayBuffer }> {
  const response = await driveClient(api).readFileResponse(accessToken, id);
  return { text: await response.text(), buffer: await response.arrayBuffer() };
}

export function createRemote(api: PluginAPI, accessToken: string, rootFolderId: string, name: string, content: string | ArrayBuffer, mimeType: string): Promise<DriveFile> {
  const drive = driveClient(api);
  return typeof content === "string"
    ? drive.createFile(accessToken, name, content, rootFolderId, mimeType)
    : drive.createFileBinary(accessToken, name, content, rootFolderId, mimeType);
}

export function updateRemote(api: PluginAPI, accessToken: string, id: string, content: string | ArrayBuffer, mimeType: string): Promise<DriveFile> {
  const drive = driveClient(api);
  return typeof content === "string"
    ? drive.updateFile(accessToken, id, content, mimeType)
    : drive.updateFileBinary(accessToken, id, content, mimeType);
}

export async function renameRemote(api: PluginAPI, accessToken: string, id: string, name: string): Promise<void> {
  await driveClient(api).renameFile(accessToken, id, name);
}

export function ensureFolder(api: PluginAPI, accessToken: string, rootFolderId: string, name: string): Promise<string> {
  return driveClient(api).ensureSubFolder(accessToken, rootFolderId, name);
}

/** Shared, reversible conflict backup name (gemihub-sync-core/conflict). */
export function conflictBackupName(path: string, now = new Date()): string {
  return buildConflictBackupName(path, now);
}

export async function moveRemote(api: PluginAPI, accessToken: string, id: string, from: string, to: string): Promise<void> {
  await driveClient(api).moveFile(accessToken, id, to, from);
}

export function metaFromFiles(files: DriveFile[]): SyncMeta {
  return syncMetaFromDriveFiles(files, syncableDriveFile);
}

/**
 * Treat the Drive folder listing as authoritative while retaining metadata
 * fields that are not returned by the listing request. kiokuflow may briefly
 * have duplicate or stale _sync-meta.json files after concurrent operations;
 * relying on one of those files alone hides newly-created and deleted files.
 */
export function reconcileSyncMeta(meta: SyncMeta | null, files: DriveFile[]): SyncMeta {
  return reconcileSyncMetaWithListing(meta, files, syncableDriveFile);
}

function syncMetaSignature(value: SyncMeta): string {
  return JSON.stringify(Object.entries(value.files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, file]) => [id, file.name, file.mimeType, file.md5Checksum, file.modifiedTime, file.size]));
}

function syncMetaStore(api: PluginAPI) {
  return createSyncMetaStore(driveClient(api));
}

/**
 * Registry reconciled with the root listing by the rules shared with kiokuflow
 * web and Obsidian: duplicate `_sync-meta.json` files are consolidated,
 * missing entries are verified by ID before removal, drifted entries adopt the
 * Drive state and untracked syncable files are registered. The result only
 * contains files this workspace syncs.
 */
export async function readSyncMeta(api: PluginAPI, accessToken: string, rootFolderId: string): Promise<SyncMeta> {
  const { meta } = await syncMetaStore(api).readReconciled(accessToken, rootFolderId, { isAdoptable: syncableDriveFile });
  return {
    lastUpdatedAt: meta?.lastUpdatedAt || new Date().toISOString(),
    files: Object.fromEntries(Object.entries(meta?.files ?? {}).filter(([, item]) => syncableDriveFile(item))),
  };
}

export async function writeSyncMeta(api: PluginAPI, accessToken: string, rootFolderId: string, meta: SyncMeta): Promise<SyncMeta> {
  const store = syncMetaStore(api);
  let expected = meta;
  for (let attempt = 0; attempt < 2; attempt++) {
    const liveFiles = await listRootFiles(api, accessToken, rootFolderId);
    expected = reconcileSyncMeta(expected, liveFiles);
    expected.lastUpdatedAt = new Date().toISOString();
    // Consolidates duplicate _sync-meta.json files into one before writing.
    const { meta: current, fileId } = await store.readWithFile(accessToken, rootFolderId);
    const nativeFiles: SyncMeta["files"] = {};
    const previousEntries: SyncMeta["files"] = {};
    for (const [id, item] of Object.entries(current?.files ?? {})) {
      if (isGoogleWorkspaceFile(item)) nativeFiles[id] = item;
      else previousEntries[id] = item;
    }
    // kiokuflow keeps sharing state (shared/webViewLink/publicPath) only inside
    // _sync-meta.json, so entries rebuilt from the Drive listing must carry the
    // current fields over.
    const files = Object.fromEntries(Object.entries(expected.files).map(([id, file]) => [id, { ...previousEntries[id], ...file }]));
    await store.write(accessToken, rootFolderId, { ...expected, files: { ...nativeFiles, ...files } }, { knownFileId: fileId });

    const after = metaFromFiles(await listRootFiles(api, accessToken, rootFolderId));
    if (syncMetaSignature(after) === syncMetaSignature(expected)) return expected;
    expected = after;
  }
  throw new Error("Google Drive changed while writing sync metadata. Check changes and retry.");
}
