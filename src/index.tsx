import type { PluginAPI } from "./types";
import { DriveSyncSettings } from "./Settings";
import { DriveSyncView } from "./View";
import { installDriveDecorations } from "./decorations";
import { installDriveDiffActions } from "./DiffViewer";

export default class KiokuflowGoogleDrivePlugin {
  private disposeDecorations: (() => void) | null = null;
  private disposeDiffActions: (() => void) | null = null;
  onload(api: PluginAPI) {
    api.registerView({ id: "sync", name: "Drive Sync", icon: "cloud", location: "sidebar", component: DriveSyncView });
    api.registerSettingsTab?.({ component: DriveSyncSettings });
    this.disposeDecorations = installDriveDecorations(api);
    this.disposeDiffActions = installDriveDiffActions(api);
  }
  onunload() {
    this.disposeDecorations?.(); this.disposeDecorations = null;
    this.disposeDiffActions?.(); this.disposeDiffActions = null;
  }
}
