import React, { useEffect, useState } from "react";
import { EXCLUDE_PATTERNS_KEY } from "./sync";
import type { PluginAPI } from "./types";

export function DriveSyncSettings({ api }: { api: PluginAPI }) {
  const [patterns, setPatterns] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void (async () => {
      const value = await api.storage?.get(EXCLUDE_PATTERNS_KEY) as string[] | null;
      setPatterns(Array.isArray(value) ? value.join("\n") : "");
    })();
  }, [api]);

  const save = async () => {
    const list = patterns.split("\n").map((line) => line.trim()).filter(Boolean);
    await api.storage?.set(EXCLUDE_PATTERNS_KEY, list);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return <section className="gdrive-sync">
    <header><span className="gdrive-logo">G</span><div><strong>Google Drive Sync</strong><small>設定</small></div></header>
    <div className="gdrive-form">
      <label>
        <span>除外パターン</span>
        <textarea rows={6} value={patterns} onChange={(event) => setPatterns(event.target.value)} placeholder={"node_modules/\n*.tmp"} />
      </label>
      <small>1行に1パターン。末尾に `/` を付けるとフォルダごと除外します（例: `drafts/`）。`*`（任意の文字列）と `?`（任意の1文字）はワイルドカードとして使えます。`.git/`、`node_modules/`、kiokuflowのsystem files/foldersは常に除外されます。</small>
      <button type="button" onClick={() => void save()}>{saved ? "保存しました" : "保存"}</button>
    </div>
  </section>;
}
