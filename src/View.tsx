import React, { useEffect, useMemo, useState } from "react";
import { DuplicateRemoteError, isTextPath, WorkspaceDriveSync, type DuplicateGroup, type ConflictPreview } from "./sync";
import type { ConflictInfo, PluginAPI, SyncProgress, SyncStatus, SyncSummary } from "./types";
import { showToast } from "./toast";
import { refreshDriveDecorations } from "./decorations";
import { sharedClient } from "./client";
import { DriveComparison, openDriveDiffViewer, type DriveDiffDirection } from "./DiffViewer";

function summary(value: SyncSummary): string {
  return `created ${value.created}, updated ${value.updated}, renamed ${value.renamed}, deleted ${value.deleted}, skipped ${value.skipped}`;
}

function countStatus(value: SyncStatus): string {
  return `${value.localChanges.length + value.localOnly.length} local, ${value.remoteChanges.length + value.remoteOnly.length} remote, ${value.conflicts.length} conflicts`;
}

type PreviewDirection = "push" | "pull";
type PreviewItem = { path: string; type: "new" | "modified" | "deleted" | "conflict" };

function previewItems(status: SyncStatus, direction: PreviewDirection): PreviewItem[] {
  const items = new Map<string, PreviewItem["type"]>();
  const add = (paths: string[], type: PreviewItem["type"]) => paths.forEach((path) => items.set(path, type));
  if (direction === "push") {
    add(status.localOnly, "new"); add(status.localChanges, "modified"); add(status.localDeletes, "deleted");
  } else {
    add(status.remoteOnly, "new"); add(status.remoteChanges, "modified"); add(status.remoteDeletes, "deleted");
  }
  add(status.conflicts.map((conflict) => conflict.path), "conflict");
  return [...items].map(([path, type]) => ({ path, type })).sort((a, b) => a.path.localeCompare(b.path));
}

function previewBlockReason(status: SyncStatus, direction: PreviewDirection): string | null {
  if (status.conflicts.length) return "Resolve the conflicts above before syncing.";
  if (direction === "push" && (status.remoteChanges.length || status.remoteOnly.length || status.remoteDeletes.length)) return "Drive has pending changes. Pull before pushing.";
  return null;
}

type StatKey = "local" | "remote" | "pushDeletes" | "pullDeletes";
const STAT_LABELS: Record<StatKey, string> = { local: "Local changes", remote: "Remote changes", pushDeletes: "Push deletes", pullDeletes: "Pull deletes" };

function statItems(status: SyncStatus, key: StatKey): PreviewItem[] {
  const items = new Map<string, PreviewItem["type"]>();
  const add = (paths: string[], type: PreviewItem["type"]) => paths.forEach((path) => items.set(path, type));
  if (key === "local") { add(status.localOnly, "new"); add(status.localChanges, "modified"); }
  else if (key === "remote") { add(status.remoteOnly, "new"); add(status.remoteChanges, "modified"); }
  else if (key === "pushDeletes") add(status.localDeletes, "deleted");
  else add(status.remoteDeletes, "deleted");
  return [...items].map(([path, type]) => ({ path, type })).sort((a, b) => a.path.localeCompare(b.path));
}

function hasLocalFile(status: SyncStatus, path: string): boolean {
  if (status.localDeletes.includes(path) || status.remoteOnly.includes(path)) return false;
  return !status.conflicts.some((conflict) => conflict.path === path && conflict.kind === "localDeleteRemoteEdit");
}

function changeDiffDirection(status: SyncStatus, path: string): DriveDiffDirection {
  const localChange = status.localChanges.includes(path) || status.localOnly.includes(path) || status.localDeletes.includes(path);
  const remoteChange = status.remoteChanges.includes(path) || status.remoteOnly.includes(path) || status.remoteDeletes.includes(path);
  return localChange && !remoteChange ? "drive-to-local" : "local-to-drive";
}

function ChangeButtons({ api, status, item, busy }: { api: PluginAPI; status: SyncStatus; item: PreviewItem; busy: boolean }) {
  return <div className="gdrive-change-buttons">
    {isTextPath(item.path) ? <button type="button" className="secondary" disabled={busy} onClick={() => openDriveDiffViewer(api, item.path, changeDiffDirection(status, item.path))}>Diff</button> : null}
    {hasLocalFile(status, item.path) && api.selectFile ? <button type="button" className="secondary" disabled={busy} onClick={() => api.selectFile?.(item.path)}>Open</button> : null}
  </div>;
}

function conflictLabel(kind: ConflictInfo["kind"]): string {
  if (kind === "localEditRemoteDelete") return "edited here, deleted on Drive";
  if (kind === "localDeleteRemoteEdit") return "deleted here, edited on Drive";
  if (kind === "untracked") return "different content on both sides";
  return "edited on both sides";
}

function ConflictComparison({ value }: { value: ConflictPreview }) {
  return <DriveComparison value={value} />;
}

export function DriveSyncView({ api }: { api: PluginAPI }) {
  const client = useMemo(() => {
    try { return sharedClient(api); }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }, [api]);
  const [connection, setConnection] = useState<Awaited<ReturnType<WorkspaceDriveSync["connection"]>>>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateGroup[]>([]);
  const [duplicateContents, setDuplicateContents] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [preview, setPreview] = useState<PreviewDirection | null>(null);
  const [statDetail, setStatDetail] = useState<StatKey | null>(null);
  const [conflictPreviews, setConflictPreviews] = useState<Record<string, { open: boolean; loading?: boolean; value?: ConflictPreview; error?: string }>>({});
  const [skipConflictBackups, setSkipConflictBackups] = useState(false);

  useEffect(() => {
    if (typeof client === "string") return;
    setUnlocked(client.isUnlocked());
    void client.connection().then(setConnection).catch((error) => setMessage(String(error)));
  }, [client]);

  if (typeof client === "string") return <section className="gdrive-sync">
    <header><span className="gdrive-logo">G</span><div><strong>Google Drive Sync</strong><small>kiokuflow-compatible Workspace sync</small></div></header>
    <p className="gdrive-message danger">{client}</p>
  </section>;

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setMessage(""); setProgress(null);
    try { await action(); } catch (error) {
      if (error instanceof DuplicateRemoteError) {
        setDuplicates(error.groups); setDuplicateContents({}); setStatus(null); setPreview(null); setStatDetail(null);
      }
      setMessage(error instanceof Error ? error.message : String(error));
    }
    finally { setBusy(false); setProgress(null); }
  };

  const refresh = async () => {
    const next = await client.status(); setDuplicates([]);
    setStatus(next); setPreview(null); setStatDetail(null); setMessage(countStatus(next));
    await refreshDriveDecorations(api);
  };

  const prepare = async (direction: PreviewDirection) => {
    const next = await client.status(); setDuplicates([]);
    setStatus(next); setPreview(direction); setStatDetail(null); setMessage(countStatus(next));
  };

  const toggleStatDetail = (key: StatKey) => { setPreview(null); setStatDetail((current) => (current === key ? null : key)); };

  const push = async () => {
    const next = await client.status(); setDuplicates([]); setStatus(next);
    const deletions = next.localDeletes.length;
    if (deletions && !window.confirm(`Push will move ${deletions} file(s) to kiokuflow trash. Continue?`)) return;
    showToast(`Push complete: ${summary(await client.push(deletions > 0))}`);
    setStatus(await client.status()); setPreview(null); setStatDetail(null);
    await refreshDriveDecorations(api);
  };

  const pull = async () => {
    const next = await client.status(); setDuplicates([]); setStatus(next);
    const deletions = next.remoteDeletes.length;
    showToast(`Pull complete: ${summary(await client.pull(deletions > 0, setProgress))}`);
    setStatus(await client.status()); setPreview(null); setStatDetail(null);
    await refreshDriveDecorations(api);
  };

  const resolve = async (targets: ConflictInfo[], choice: "local" | "remote") => {
    const resolved = await client.resolveConflicts(targets.map((conflict) => ({ conflict, choice, backup: !skipConflictBackups })));
    const next = await client.status(); setDuplicates([]); setStatus(next);
    setConflictPreviews({});
    setMessage(`Resolved ${resolved} conflict(s). ${countStatus(next)}`);
    await refreshDriveDecorations(api);
  };

  const toggleConflictPreview = async (conflict: ConflictInfo) => {
    const key = `${conflict.kind}:${conflict.path}`;
    const current = conflictPreviews[key];
    if (current?.open) { setConflictPreviews((values) => ({ ...values, [key]: { ...current, open: false } })); return; }
    if (current?.value) { setConflictPreviews((values) => ({ ...values, [key]: { ...current, open: true } })); return; }
    setConflictPreviews((values) => ({ ...values, [key]: { open: true, loading: true } }));
    try {
      const value = await client.conflictPreview(conflict);
      setConflictPreviews((values) => ({ ...values, [key]: { open: true, value } }));
    } catch (error) {
      setConflictPreviews((values) => ({ ...values, [key]: { open: true, error: error instanceof Error ? error.message : String(error) } }));
    }
  };

  return <section className="gdrive-sync">
    <header><span className="gdrive-logo">G</span><div><strong>Google Drive Sync</strong><small>kiokuflow-compatible Workspace sync</small></div></header>
    {!connection ? <div className="gdrive-form">
      <p>kiokuflowで暗号化を有効にし、設定 → 同期 → 外部同期から同期トークンを生成してください。現在選択中のWorkspace全体がこの接続に固定されます。</p>
      <label><span>kiokuflow sync token</span><textarea rows={5} value={token} onChange={(event) => setToken(event.target.value)} disabled={busy} /></label>
      <button type="button" disabled={busy || !token.trim()} onClick={() => void run(async () => { const saved = await client.setup(token); setConnection(saved); setToken(""); setMessage(`Connected to Workspace “${saved.workspace.name}”.`); })}>Connect Workspace</button>
    </div> : !unlocked ? <div className="gdrive-form">
      <p>接続先Workspace: <strong>{connection.workspace.name}</strong></p>
      <label><span>kiokuflow encryption password</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} /></label>
      <button type="button" disabled={busy || !password} onClick={() => void run(async () => { await client.unlock(password); setPassword(""); setUnlocked(true); setMessage("Drive connection unlocked for this session."); })}>Unlock</button>
      <button type="button" className="secondary" disabled={busy} onClick={() => void run(async () => { await client.reset(); setConnection(null); setStatus(null); showToast("Connection reset."); })}>Reset connection</button>
    </div> : <div className="gdrive-actions">
      <div className="gdrive-workspace"><span>Workspace</span><strong>{connection.workspace.name}</strong><small>{connection.workspace.path}</small></div>
      {duplicates.length ? <div className="gdrive-preview gdrive-conflicts">
        <div className="gdrive-preview-header"><strong>Duplicate Drive paths</strong><span>{duplicates.length} path(s)</span></div>
        <p>各コピーを確認して、元のパスに残すファイルを選んでください。他のコピーは復元可能なkiokuflowのtrashへ移動します。ローカルの内容は変更しません。</p>
        {duplicates.map((group) => <div key={group.path}>
          <strong>{group.path}</strong>
          <button type="button" className="secondary" disabled={busy} onClick={() => void run(async () => {
            const contents = await client.duplicatePreview(group);
            setDuplicateContents((previous) => ({ ...previous, ...contents }));
          })}>View all copies</button>
          <ul>{group.files.map(({ id, file }) => <li key={id} className="is-conflict">
            <div className="gdrive-conflict-file"><span>{file.name}</span><small>ID: {id}</small>
              <small>Updated: {file.modifiedTime || "unknown"} · Size: {file.size ?? "unknown"} · MD5: {file.md5Checksum || "unknown"}</small>
            </div>
            <button type="button" disabled={busy} onClick={() => void run(async () => {
              await client.resolveDuplicate(group, id);
              setDuplicateContents({});
              await refresh();
            })}>Keep this copy</button>
            {duplicateContents[id] !== undefined ? <div className="gdrive-conflict-detail"><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "24rem", overflow: "auto" }}>{duplicateContents[id]}</pre></div> : null}
          </li>)}</ul>
        </div>)}
      </div> : null}
      {status && <div className="gdrive-status-grid">
        <button type="button" className={statDetail === "local" ? "is-open" : ""} onClick={() => toggleStatDetail("local")}>Local changes <b>{status.localChanges.length + status.localOnly.length}</b></button>
        <button type="button" className={statDetail === "remote" ? "is-open" : ""} onClick={() => toggleStatDetail("remote")}>Remote changes <b>{status.remoteChanges.length + status.remoteOnly.length}</b></button>
        <button type="button" className={statDetail === "pushDeletes" ? "is-open" : ""} onClick={() => toggleStatDetail("pushDeletes")}>Push deletes <b>{status.localDeletes.length}</b></button>
        <button type="button" className={statDetail === "pullDeletes" ? "is-open" : ""} onClick={() => toggleStatDetail("pullDeletes")}>Pull deletes <b>{status.remoteDeletes.length}</b></button>
        <span className={status.conflicts.length ? "danger" : ""}>Conflicts <b>{status.conflicts.length}</b></span>
      </div>}
      {status && statDetail ? <div className="gdrive-preview">
        <div className="gdrive-preview-header"><strong>{STAT_LABELS[statDetail]}</strong><span>{statItems(status, statDetail).length} file(s)</span></div>
        {statItems(status, statDetail).length ? <ul>{statItems(status, statDetail).map((item) => <li key={`${item.type}:${item.path}`} className={`is-${item.type}`}><span className="gdrive-preview-type">{item.type}</span><span>{item.path}</span><ChangeButtons api={api} status={status} item={item} busy={busy} /></li>)}</ul> : <p>No files.</p>}
      </div> : null}
      {status?.conflicts.length ? <div className="gdrive-preview gdrive-conflicts">
        <div className="gdrive-preview-header"><strong>Conflicts</strong><span>{status.conflicts.length} file(s)</span></div>
        <p>Choose which side to keep for each file. By default, the discarded versions are backed up locally to <code>GemiHub/conflict-backups/</code>.</p>
        <label className="gdrive-conflict-backup-option">
          <input type="checkbox" checked={skipConflictBackups} disabled={busy} onChange={(event) => setSkipConflictBackups(event.target.checked)} />
          <span>Do not save conflict backups</span>
        </label>
        <ul>{status.conflicts.map((conflict) => {
          const key = `${conflict.kind}:${conflict.path}`;
          const comparison = conflictPreviews[key];
          return <li key={key} className="is-conflict">
            <div className="gdrive-conflict-file"><span>{conflict.path}</span><small>{conflictLabel(conflict.kind)}</small></div>
            <div className="gdrive-conflict-buttons">
              <button type="button" className="secondary" disabled={busy || comparison?.loading} onClick={() => void toggleConflictPreview(conflict)}>{comparison?.open ? "Hide diff" : comparison?.value ? "Show diff" : "View diff"}</button>
              <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => resolve([conflict], "local"))}>Keep local</button>
              <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => resolve([conflict], "remote"))}>Keep remote</button>
            </div>
            {comparison?.open ? <div className="gdrive-conflict-detail">
              {comparison.loading ? <p>Loading both sides…</p> : comparison.error ? <p className="danger">{comparison.error}</p> : comparison.value ? <ConflictComparison value={comparison.value} /> : null}
            </div> : null}
          </li>;
        })}</ul>
        <div className="gdrive-preview-actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => resolve(status.conflicts, "local"))}>Keep all local</button>
          <button type="button" disabled={busy} onClick={() => void run(() => resolve(status.conflicts, "remote"))}>Keep all remote</button>
        </div>
      </div> : null}
      {status && preview ? <div className="gdrive-preview">
        <div className="gdrive-preview-header"><strong>{preview === "push" ? "Push to Drive" : "Pull to Workspace"}</strong><span>{previewItems(status, preview).length} file(s)</span></div>
        {previewItems(status, preview).length ? <ul>{previewItems(status, preview).map((item) => <li key={`${item.type}:${item.path}`} className={`is-${item.type}`}><span className="gdrive-preview-type">{item.type}</span><span>{item.path}</span><ChangeButtons api={api} status={status} item={item} busy={busy} /></li>)}</ul> : <p>No files to sync.</p>}
        {previewBlockReason(status, preview) ? <p className="danger">{previewBlockReason(status, preview)}</p> : null}
        <div className="gdrive-preview-actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => setPreview(null)}>Cancel</button>
          <button type="button" disabled={busy || !!previewBlockReason(status, preview)} onClick={() => void run(preview === "push" ? push : pull)}>{preview === "push" ? "Confirm push" : "Confirm pull"}</button>
        </div>
      </div> : null}
      <div className="gdrive-buttons">
        <button type="button" disabled={busy || !!preview} onClick={() => void run(refresh)}>Check</button>
        <button type="button" disabled={busy || !!preview} onClick={() => void run(() => prepare("pull"))}>Pull</button>
        <button type="button" disabled={busy || !!preview} onClick={() => void run(() => prepare("push"))}>Push</button>
      </div>
      <small>kiokuflowと同じ `_sync-meta.json` を使用します。初回に両側へ異なるファイルがある場合は Pull → Push の順で統合してください。</small>
    </div>}
    {busy && <p className="gdrive-message">{progress ? `${progress.phase === "pull" ? "Pull" : progress.phase === "delete" ? "Delete" : "Snapshot"} ${progress.completed} / ${progress.total}${progress.path ? `: ${progress.path}` : ""}` : "Working…"}</p>}
    {message && <p className="gdrive-message">{message}</p>}
  </section>;
}
