/// <reference lib="deno.ns" />
import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert";
import { assertCurrentDuplicate, duplicateRemoteGroups, DuplicateRemoteError, WorkspaceDriveSync, adoptResolvedConflicts, computeLocalChangePaths, computeSnapshot, computeStatus, duplicateRemotePaths, isBinaryPath, isTextPath, parallelForEach, planPush, remoteSnapshotChanged, unresolvedBaselineEntries } from "./sync.ts";
import { isGoogleWorkspaceFile, reconcileSyncMeta, syncableDriveFile } from "./drive.ts";
import type { HTTPResponse, PluginAPI, LocalSyncMeta, WorkspaceFile, SyncMeta } from "./types.ts";

const local = (path: string, md5: string): WorkspaceFile => ({ path, md5, size: 1, createdTime: 0, modTime: 0, binary: false });
const baseline = (md5 = "a"): LocalSyncMeta => ({ workspaceId: "p", lastUpdatedAt: "", files: { id: { name: "notes/a.md", md5Checksum: md5 } }, pathToId: { "notes/a.md": "id" } });
const remote = (md5 = "a"): SyncMeta => ({ lastUpdatedAt: "", files: { id: { name: "notes/a.md", md5Checksum: md5, mimeType: "text/markdown", modifiedTime: "" } } });

Deno.test("finds local files that need to be pushed for FileTree decorations", () => {
  assertEquals(computeLocalChangePaths([local("notes/a.md", "a")], baseline()), []);
  assertEquals(computeLocalChangePaths([
    local("notes/a.md", "changed"),
    local("notes/new.md", "new"),
  ], baseline()), ["notes/a.md", "notes/new.md"]);
  assertEquals(computeLocalChangePaths([local("notes/renamed.md", "a")], baseline()), ["notes/renamed.md"]);
});

Deno.test("classifies only known text extensions as text", () => {
  // Shared kiokuflow rule: extensionless files are text, SVG is an image.
  for (const path of ["notes/readme.md", "data/view.yaml", "boards/work.dashboard", "scores/song.audioscore", "src/main.tsx", "unknown"]) {
    assertEquals(isTextPath(path), true, path);
    assertEquals(isBinaryPath(path), false, path);
  }
  for (const path of ["scores/song.mid", "scores/song.midi", "docs/file.pdf", "audio/track.wav", "image.svg", "archive.custom"]) {
    assertEquals(isTextPath(path), false, path);
    assertEquals(isBinaryPath(path), true, path);
  }
});

Deno.test("classifies local, remote, delete, and conflict changes", () => {
  assertEquals(computeStatus([local("notes/a.md", "b")], baseline(), remote()).localChanges, ["notes/a.md"]);
  assertEquals(computeStatus([local("notes/a.md", "a")], baseline(), remote("b")).remoteChanges, ["notes/a.md"]);
  assertEquals(computeStatus([local("notes/a.md", "b")], baseline(), remote("c")).conflicts, [
    { path: "notes/a.md", id: "id", remoteName: "notes/a.md", kind: "edit" },
  ]);
  assertEquals(computeStatus([], baseline(), remote()).localDeletes, ["notes/a.md"]);
  assertEquals(computeStatus([local("notes/a.md", "a")], baseline(), { lastUpdatedAt: "", files: {} }).remoteDeletes, ["notes/a.md"]);
});

Deno.test("classifies an untracked file that differs from a same-named remote file", () => {
  const empty: LocalSyncMeta = { workspaceId: "p", lastUpdatedAt: "", files: {}, pathToId: {} };
  assertEquals(computeStatus([local("notes/a.md", "b")], empty, remote()).conflicts, [
    { path: "notes/a.md", id: "id", remoteName: "notes/a.md", kind: "untracked" },
  ]);
});

Deno.test("classifies a checksum-preserving local rename without a delete", () => {
  const status = computeStatus([local("notes/renamed.md", "a")], baseline(), remote());
  assertEquals(status.localChanges, ["notes/renamed.md"]);
  assertEquals(status.localDeletes, []);
});

Deno.test("does not mistake a duplicate-content file for a deleted file rename", () => {
  const sameContentBaseline: LocalSyncMeta = {
    workspaceId: "p", lastUpdatedAt: "",
    files: { a: { name: "a.md", md5Checksum: "same" }, b: { name: "b.md", md5Checksum: "same" } },
    pathToId: { "a.md": "a", "b.md": "b" },
  };
  const sameContentRemote: SyncMeta = {
    lastUpdatedAt: "",
    files: {
      a: { name: "a.md", md5Checksum: "same", mimeType: "text/markdown", modifiedTime: "" },
      b: { name: "b.md", md5Checksum: "same", mimeType: "text/markdown", modifiedTime: "" },
    },
  };
  const status = computeStatus([local("b.md", "same")], sameContentBaseline, sameContentRemote);
  assertEquals(status.localDeletes, ["a.md"]);
  assertEquals(status.localChanges, []);
});

Deno.test("resolves a same-size group of duplicate-content renames without flagging false deletes", () => {
  // Two files share identical content, both get renamed, then renamed back to
  // their original names. The renamed (pushed) state is no longer a 1-to-1
  // match, but the counts on each side still agree, so this must not be
  // treated as "old files deleted, new files created".
  const sameContentBaseline: LocalSyncMeta = {
    workspaceId: "p", lastUpdatedAt: "",
    files: { a: { name: "renamed-a.md", md5Checksum: "same" }, b: { name: "renamed-b.md", md5Checksum: "same" } },
    pathToId: { "renamed-a.md": "a", "renamed-b.md": "b" },
  };
  const sameContentRemote: SyncMeta = {
    lastUpdatedAt: "",
    files: {
      a: { name: "renamed-a.md", md5Checksum: "same", mimeType: "text/markdown", modifiedTime: "" },
      b: { name: "renamed-b.md", md5Checksum: "same", mimeType: "text/markdown", modifiedTime: "" },
    },
  };
  const status = computeStatus([local("a.md", "same"), local("b.md", "same")], sameContentBaseline, sameContentRemote);
  assertEquals(status.localDeletes, []);
  assertEquals(status.localOnly, []);
  assertEquals(status.localChanges, ["a.md", "b.md"]);
});

Deno.test("never resolves a stale duplicate's delete target to a different id that is still live", () => {
  // Drive can end up with several objects sharing one `name` (leftover from
  // past rename churn). One id ("live") still matches the current local
  // file; two others ("orphan1", "orphan2") share that same name but no
  // longer correspond to anything local. Deletion must be decided per id,
  // never by looking a deduped name back up to a single id — otherwise a
  // name-based lookup could resolve to "live" and move the still-current
  // file to trash instead of the actual orphans.
  const sharedName = "Dashboards/Kanbans/tasks.kanban";
  const testBaseline: LocalSyncMeta = {
    workspaceId: "p", lastUpdatedAt: "",
    files: {
      live: { name: sharedName, md5Checksum: "current" },
      orphan1: { name: "Dashboards/Kanbans/Tasks.kanban", md5Checksum: "old1" },
      orphan2: { name: sharedName, md5Checksum: "old2" },
    },
    // pathToId can only ever remember one id per exact name — the live one.
    pathToId: { [sharedName]: "live" },
  };
  const testRemote: SyncMeta = {
    lastUpdatedAt: "",
    files: {
      live: { name: sharedName, md5Checksum: "current", mimeType: "text/plain", modifiedTime: "" },
      orphan1: { name: "Dashboards/Kanbans/Tasks.kanban", md5Checksum: "old1", mimeType: "text/plain", modifiedTime: "" },
      orphan2: { name: sharedName, md5Checksum: "old2", mimeType: "text/plain", modifiedTime: "" },
    },
  };
  // The live id is claimed by the current local file (as resolveLocalIds
  // would do via the exact-path match); orphan1/orphan2 are not claimed by
  // anything.
  const localIds = new Map([[sharedName, "live"]]);
  const unresolved = unresolvedBaselineEntries(localIds, testBaseline, testRemote);
  const ids = unresolved.map((entry) => entry.id).sort();
  assertEquals(ids, ["orphan1", "orphan2"]);
  assertEquals(ids.includes("live"), false);
});

Deno.test("treats rename-delete races as conflicts", () => {
  const localRenameRemoteDelete = computeStatus([local("renamed.md", "a")], baseline(), { lastUpdatedAt: "", files: {} });
  assertEquals(localRenameRemoteDelete.conflicts, [
    { path: "renamed.md", id: "id", remoteName: null, kind: "localEditRemoteDelete" },
  ]);

  const localDeleteRemoteRename = computeStatus([], baseline(), {
    lastUpdatedAt: "",
    files: { id: { name: "notes/renamed.md", md5Checksum: "a", mimeType: "text/markdown", modifiedTime: "" } },
  });
  assertEquals(localDeleteRemoteRename.conflicts, [
    { path: "notes/a.md", id: "id", remoteName: "notes/renamed.md", kind: "localDeleteRemoteEdit" },
  ]);
});

Deno.test("recognizes already-applied remote state after an interrupted pull", () => {
  const currentRemote: SyncMeta = {
    lastUpdatedAt: "",
    files: { id: { name: "notes/a.md", md5Checksum: "current", mimeType: "text/markdown", modifiedTime: "" } },
  };
  const status = computeStatus([local("notes/a.md", "current")], baseline("old"), currentRemote);
  assertEquals(status.conflicts, []);
  assertEquals(status.localChanges, []);
  assertEquals(status.remoteChanges, []);
});

Deno.test("snapshot preserves an unresolved remote deletion", () => {
  const snapshot = computeSnapshot("p", { lastUpdatedAt: "remote", files: {} }, [local("notes/a.md", "a")], baseline());
  assertEquals(snapshot.files, baseline().files);
  assertEquals(snapshot.pathToId, { "notes/a.md": "id" });
  assertEquals(computeStatus([local("notes/a.md", "a")], snapshot, { lastUpdatedAt: "", files: {} }).remoteDeletes, ["notes/a.md"]);
});

Deno.test("snapshot preserves an unresolved edit-delete conflict", () => {
  const snapshot = computeSnapshot("p", { lastUpdatedAt: "remote", files: {} }, [local("notes/a.md", "b")], baseline());
  assertEquals(computeStatus([local("notes/a.md", "b")], snapshot, { lastUpdatedAt: "", files: {} }).conflicts, [
    { path: "notes/a.md", id: "id", remoteName: null, kind: "localEditRemoteDelete" },
  ]);
});

Deno.test("adopting a resolved keep-remote edit removes the conflict baseline", () => {
  const currentRemote = remote("remote");
  const staleSnapshot = computeSnapshot("p", currentRemote, [local("notes/a.md", "local")], baseline());
  const adopted = adoptResolvedConflicts(staleSnapshot, currentRemote, [
    { path: "notes/a.md", id: "id", remoteName: "notes/a.md", kind: "edit" },
  ]);
  assertEquals(adopted.files.id.md5Checksum, "remote");
  assertEquals(computeStatus([local("notes/a.md", "remote")], adopted, currentRemote).conflicts, []);
});

Deno.test("adopting a resolved Drive deletion drops the deleted identity", () => {
  const noRemote: SyncMeta = { lastUpdatedAt: "remote", files: {} };
  const staleSnapshot = computeSnapshot("p", noRemote, [local("notes/a.md", "local")], baseline());
  const adopted = adoptResolvedConflicts(staleSnapshot, noRemote, [
    { path: "notes/a.md", id: "id", remoteName: null, kind: "localEditRemoteDelete" },
  ]);
  assertEquals(adopted.files, {});
  assertEquals(adopted.pathToId, {});
});

Deno.test("snapshot drops a remote deletion after its local file is removed", () => {
  const snapshot = computeSnapshot("p", { lastUpdatedAt: "remote", files: {} }, [], baseline());
  assertEquals(snapshot.files, {});
  assertEquals(snapshot.pathToId, {});
});

Deno.test("snapshot replaces a deleted ID after keep-local recreates the remote file", () => {
  const recreated: SyncMeta = {
    lastUpdatedAt: "remote",
    files: { replacement: { name: "notes/a.md", md5Checksum: "b", mimeType: "text/markdown", modifiedTime: "" } },
  };
  const snapshot = computeSnapshot("p", recreated, [local("notes/a.md", "b")], baseline());
  assertEquals(snapshot.files, { replacement: { name: "notes/a.md", md5Checksum: "b" } });
  assertEquals(snapshot.pathToId, { "notes/a.md": "replacement" });
});

Deno.test("push adopts identical untracked files without re-upload or rename", () => {
  const empty: LocalSyncMeta = { workspaceId: "p", lastUpdatedAt: "", files: {}, pathToId: {} };
  assertEquals(planPush([local("notes/a.md", "a")], empty, remote()), [
    { local: local("notes/a.md", "a"), id: "id", rename: false, upload: null },
  ]);
});

Deno.test("push plans renames, updates, creates, and skips from the tracked baseline", () => {
  assertEquals(planPush([local("notes/renamed.md", "a")], baseline(), remote()), [
    { local: local("notes/renamed.md", "a"), id: "id", rename: true, upload: null },
  ]);
  assertEquals(planPush([local("notes/a.md", "b")], baseline(), remote()), [
    { local: local("notes/a.md", "b"), id: "id", rename: false, upload: "update" },
  ]);
  assertEquals(planPush([local("new.md", "x")], baseline("other"), remote("other")), [
    { local: local("new.md", "x"), id: undefined, rename: false, upload: "create" },
  ]);
  assertEquals(planPush([local("notes/a.md", "a")], baseline(), remote()), [
    { local: local("notes/a.md", "a"), id: "id", rename: false, upload: null },
  ]);
});

Deno.test("excludes Google Workspace native files but keeps exported binary files", () => {
  assertEquals(isGoogleWorkspaceFile({ mimeType: "application/vnd.google-apps.presentation" }), true);
  assertEquals(syncableDriveFile({ name: "Planning", mimeType: "application/vnd.google-apps.document" }), false);
  assertEquals(syncableDriveFile({ name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet" }), false);
  assertEquals(syncableDriveFile({ name: "Planning.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), true);
});

Deno.test("reconciles stale sync metadata against the live Drive listing", () => {
  const stale: SyncMeta = {
    lastUpdatedAt: "2026-01-01T00:00:00.000Z",
    files: {
      deleted: { name: "deleted.md", mimeType: "text/markdown", md5Checksum: "old", modifiedTime: "old" },
      kept: { name: "kept.md", mimeType: "text/markdown", md5Checksum: "stale", modifiedTime: "stale", size: "12" },
    },
  };
  const reconciled = reconcileSyncMeta(stale, [
    { id: "kept", name: "kept.md", mimeType: "text/markdown", md5Checksum: "current", modifiedTime: "current" },
    { id: "created", name: "created.md", mimeType: "text/markdown", md5Checksum: "new", modifiedTime: "new" },
  ]);

  assertEquals(Object.keys(reconciled.files).sort(), ["created", "kept"]);
  assertEquals(reconciled.files.kept.md5Checksum, "current");
  assertEquals(reconciled.files.kept.size, "12");
});

Deno.test("detects duplicate Drive paths before pull or push writes", () => {
  const duplicates: SyncMeta = {
    lastUpdatedAt: "",
    files: {
      a: { name: "same.md", md5Checksum: "a", mimeType: "text/markdown", modifiedTime: "1" },
      b: { name: "same.md", md5Checksum: "b", mimeType: "text/markdown", modifiedTime: "2" },
      c: { name: "unique.md", md5Checksum: "c", mimeType: "text/markdown", modifiedTime: "3" },
    },
  };
  assertEquals(duplicateRemotePaths(duplicates), ["same.md"]);
});

Deno.test("detects case-distinct Drive paths as duplicates on Windows", () => {
  const duplicates: SyncMeta = {
    lastUpdatedAt: "",
    files: {
      upper: { name: "Tasks/a.md", md5Checksum: "a", mimeType: "text/markdown", modifiedTime: "" },
      lower: { name: "tasks/a.md", md5Checksum: "b", mimeType: "text/markdown", modifiedTime: "" },
    },
  };
  assertEquals(duplicateRemotePaths(duplicates), []);
  assertEquals(duplicateRemotePaths(duplicates, true), ["Tasks/a.md"]);
});

Deno.test("case-only path differences are unchanged on Windows", () => {
  const windowsBaseline: LocalSyncMeta = {
    workspaceId: "p", lastUpdatedAt: "",
    files: { id: { name: "Tasks/a.md", md5Checksum: "a" } },
    pathToId: { "Tasks/a.md": "id" },
  };
  const windowsRemote: SyncMeta = {
    lastUpdatedAt: "",
    files: { id: { name: "Tasks/a.md", md5Checksum: "a", mimeType: "text/markdown", modifiedTime: "" } },
  };
  const inventory = [local("tasks/a.md", "a")];
  assertEquals(computeStatus(inventory, windowsBaseline, windowsRemote, true), {
    localChanges: [], remoteChanges: [], localOnly: [], remoteOnly: [], localDeletes: [], remoteDeletes: [], conflicts: [],
  });
  assertEquals(planPush(inventory, windowsBaseline, windowsRemote, true), [
    { local: inventory[0], id: "id", rename: false, upload: null },
  ]);
  assertEquals(computeSnapshot("p", windowsRemote, inventory, windowsBaseline, true).pathToId, { "Tasks/a.md": "id" });
});

Deno.test("detects a changed Drive batch snapshot", () => {
  assertEquals(remoteSnapshotChanged(remote(), remote()), false);
  assertEquals(remoteSnapshotChanged(remote(), remote("changed")), true);
  assertEquals(remoteSnapshotChanged(remote(), { lastUpdatedAt: "", files: {} }), true);
});

Deno.test("snapshot keeps pending local edits, deletes, and unresolved conflicts", () => {
  const currentRemote: SyncMeta = {
    lastUpdatedAt: "now",
    files: {
      synced: { name: "synced.md", md5Checksum: "s", mimeType: "text/markdown", modifiedTime: "" },
      edited: { name: "edited.md", md5Checksum: "e", mimeType: "text/markdown", modifiedTime: "" },
      deleted: { name: "deleted.md", md5Checksum: "d", mimeType: "text/markdown", modifiedTime: "" },
      untracked: { name: "conflict.md", md5Checksum: "r", mimeType: "text/markdown", modifiedTime: "" },
    },
  };
  const previous: LocalSyncMeta = {
    workspaceId: "p", lastUpdatedAt: "",
    files: {
      synced: { name: "synced.md", md5Checksum: "s" },
      edited: { name: "edited.md", md5Checksum: "e" },
      deleted: { name: "deleted.md", md5Checksum: "d" },
    },
    pathToId: { "synced.md": "synced", "edited.md": "edited", "deleted.md": "deleted" },
  };
  const inventory = [local("synced.md", "s"), local("edited.md", "changed"), local("conflict.md", "mine")];

  const snapshot = computeSnapshot("p", currentRemote, inventory, previous);
  assertEquals(snapshot.files.synced, { name: "synced.md", md5Checksum: "s" });
  // A pending local edit keeps its baseline entry so the change stays pushable.
  assertEquals(snapshot.files.edited, { name: "edited.md", md5Checksum: "e" });
  // A pending local delete stays tracked so the next push can apply it.
  assertEquals(snapshot.files.deleted, { name: "deleted.md", md5Checksum: "d" });
  // An unresolved untracked conflict must not be adopted as synchronized.
  assertEquals(snapshot.files.untracked, undefined);
  assertEquals(snapshot.pathToId["deleted.md"], "deleted");
});

Deno.test("sync worker pool limits concurrency", async () => {
  let active = 0, maximum = 0, completed = 0;
  await parallelForEach(Array.from({ length: 17 }, (_, index) => index), async () => {
    active++; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--; completed++;
  }, 5);
  assertEquals(maximum, 5);
  assertEquals(completed, 17);
});

Deno.test("duplicate groups preserve every identity and reject stale choices", () => {
  const value = remote();
  value.files.second = { ...value.files.id, md5Checksum: "different" };
  value.files.third = { ...value.files.id };
  const group = duplicateRemoteGroups(value)[0];
  assertEquals(group.files.map(({ id }) => id), ["id", "second", "third"]);
  assertEquals(assertCurrentDuplicate(group, value), group);
  const changed = structuredClone(value);
  changed.files.second.md5Checksum = "new edit";
  assertThrows(() => assertCurrentDuplicate(group, changed), Error, "changed");
  delete changed.files.second;
  assertThrows(() => assertCurrentDuplicate(group, changed), Error, "changed");
  const caseVariants = remote();
  caseVariants.files.second = { ...caseVariants.files.id, name: "NOTES/A.md" };
  assertEquals(duplicateRemoteGroups(caseVariants).length, 0);
  assertEquals(duplicateRemoteGroups(caseVariants, true).length, 1);
});

Deno.test("duplicate resolution previews all copies, archives only losers, and preserves local conflicts", async () => {
  const current = remote("selected");
  current.files.other = { ...current.files.id, md5Checksum: "old" };
  current.files.third = { ...current.files.id, md5Checksum: "third" };
  const saved = baseline("old");
  saved.files = { other: saved.files.id };
  saved.pathToId = { "notes/a.md": "other" };
  const workspace = { id: "p", name: "test", path: "/test" };
  const storage: Record<string, unknown> = { connection: { workspace }, syncSnapshot: saved };
  const moved: string[] = [];
  const writes: string[] = [];
  const ok = (value: unknown): HTTPResponse => ({ status: 200, headers: {}, body: typeof value === "string" ? value : JSON.stringify(value), bodyBase64: "" });
  const api = {
    language: "en", registerView() {},
    storage: { get: (key: string) => Promise.resolve(structuredClone(storage[key])), set: (key: string, value: unknown) => { storage[key] = structuredClone(value); return Promise.resolve(); } },
    workspaceFiles: { current: () => Promise.resolve(workspace), inventory: () => Promise.resolve([local("notes/a.md", "local edit")]) },
    network: { request: (request: { url: string; method: string; body?: string }) => {
      const url = new URL(request.url);
      const id = url.pathname.split("/").at(-1)!;
      if (url.pathname.startsWith("/upload/")) { writes.push(request.body!); return Promise.resolve(ok({ id: "meta" })); }
      if (request.method === "PATCH") {
        assertEquals(url.searchParams.get("addParents"), "trash-id");
        assertEquals(url.searchParams.get("removeParents"), "root");
        moved.push(id); delete current.files[id]; return Promise.resolve(ok({ id }));
      }
      if (url.searchParams.get("alt") === "media") return Promise.resolve(ok(id === "meta" ? current : `content of ${id}`));
      const query = url.searchParams.get("q") ?? "";
      if (query.includes("_sync-meta.json")) return Promise.resolve(ok({ files: [{ id: "meta", name: "_sync-meta.json" }] }));
      if (/name\s*=\s*'trash'/.test(query)) return Promise.resolve(ok({ files: [{ id: "trash-id", name: "trash", mimeType: "application/vnd.google-apps.folder" }] }));
      return Promise.resolve(ok({ files: Object.entries(current.files).map(([id, file]) => ({ id, ...file })) }));
    } },
  } as unknown as PluginAPI;
  const client = new WorkspaceDriveSync(api);
  Object.defineProperty(client, "tokens", { value: () => Promise.resolve({ accessToken: "token", rootFolderId: "root" }) });
  await assertRejects(() => client.status(), DuplicateRemoteError);
  assertEquals(moved, []);
  const group = duplicateRemoteGroups(structuredClone(current))[0];
  assertEquals(await client.duplicatePreview(group), { id: "content of id", other: "content of other", third: "content of third" });
  await assertRejects(() => client.resolveDuplicate(group, "invalid"), Error, "Choose a file");
  assertEquals(moved, []);
  current.files.third.md5Checksum = "changed";
  await assertRejects(() => client.resolveDuplicate(group, "id"), Error, "changed");
  assertEquals(moved, []);
  current.files.third.md5Checksum = "third";
  await client.resolveDuplicate(group, "id");
  assertEquals(moved, ["other", "third"]);
  assertEquals(Object.keys(current.files), ["id"]);
  assertEquals(writes.length, 1);
  const updated = storage.syncSnapshot as LocalSyncMeta;
  assertEquals(updated.pathToId, { "notes/a.md": "id" });
  assertEquals(updated.files.id.md5Checksum, "old");
  const status = await client.status();
  assertEquals(status.conflicts.map(({ id, kind }) => ({ id, kind })), [{ id: "id", kind: "edit" }]);
  assertEquals(status.remoteDeletes, []);
});
