export interface Workspace { id: string; name: string; path: string }
export interface WorkspaceFile { path: string; size: number; createdTime: number; modTime: number; md5: string; binary: boolean }
export interface HTTPRequest { url: string; method?: string; headers?: Record<string, string>; body?: string; bodyBase64?: string }
export interface HTTPResponse { status: number; headers: Record<string, string>; body: string; bodyBase64: string }

export interface WorkspaceFilesAPI {
  current(): Promise<Workspace | null>;
  inventory(): Promise<WorkspaceFile[]>;
  read(path: string): Promise<string>;
  create(path: string, content: string | ArrayBuffer): Promise<void>;
  update(path: string, content: string | ArrayBuffer): Promise<void>;
  createDirectory(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  delete(path: string): Promise<void>;
}

export interface PluginAPI {
  language: string;
  selectFile?(path: string): void;
  registerView(view: { id: string; name: string; icon?: string; location: "sidebar" | "main"; component: (props: { api: PluginAPI }) => unknown }): void;
  registerSettingsTab?(tab: { component: (props: { api: PluginAPI; onClose?: () => void }) => unknown }): void;
  workspaceFiles?: WorkspaceFilesAPI;
  storage?: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; getAll(): Promise<Record<string, unknown>> };
  network?: { request(request: HTTPRequest): Promise<HTTPResponse> };
  onFilesChanged?(callback: (change: { scope?: "workspace" | "files"; path?: string; oldPath?: string; kind: "created" | "updated" | "renamed" | "deleted" | "refresh" }) => void): () => void;
  fileTree?: {
    registerDecorationProvider(provider: (target: { scope: "workspace" | "files"; path: string; isDirectory: boolean }) => { color?: string; title?: string } | null | undefined | Promise<{ color?: string; title?: string } | null | undefined>): () => void;
    refreshDecorations(): void;
    registerContextMenuItem?(action: FileAction): () => void;
  };
  fileViewer?: { registerAction?(action: FileAction): () => void };
}

export interface FileActionTarget { scope: "workspace" | "files"; path: string; name: string; isDirectory: boolean }
export interface FileAction { id: string; label: string; when?(target: FileActionTarget): boolean; onClick(target: FileActionTarget): void | Promise<void> }

// `_sync-meta.json` schema shared with kiokuflow web and Obsidian.
export type { FileSyncMeta, SyncMeta } from "kiokuflow-sync-core/protocol";
export interface LocalSyncMeta {
  workspaceId: string;
  lastUpdatedAt: string;
  files: Record<string, { name: string; md5Checksum: string }>;
  pathToId: Record<string, string>;
}

export type ConflictKind = "edit" | "untracked" | "localEditRemoteDelete" | "localDeleteRemoteEdit";
export interface ConflictInfo {
  path: string;
  id: string;
  remoteName: string | null;
  kind: ConflictKind;
}

export interface SyncStatus {
  localChanges: string[];
  remoteChanges: string[];
  localOnly: string[];
  remoteOnly: string[];
  localDeletes: string[];
  remoteDeletes: string[];
  conflicts: ConflictInfo[];
}

export interface SyncSummary { created: number; updated: number; renamed: number; deleted: number; skipped: number }
export interface SyncProgress { phase: "pull" | "delete" | "snapshot"; completed: number; total: number; path?: string }
