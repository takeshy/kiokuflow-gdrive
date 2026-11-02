import {
  buildTokenRefreshRequest,
  decodeMigrationToken,
  decryptEncryptedAuth,
  ENCRYPTED_AUTH_FILE_NAME,
  needsTokenRefresh,
  parseEncryptedAuthFile,
  parseTokenRefreshResponse,
} from "gemihub-sync-core/auth";
import { request } from "./transport";
import type { PluginAPI, Workspace } from "./types";

export interface StoredConnection {
  data: string;
  encryptedPrivateKey: string;
  salt: string;
  rootFolderId: string;
  workspace: Workspace;
}

export interface Session { accessToken: string; refreshToken: string; apiOrigin: string; rootFolderId: string; expiryTime: number }

// Token, _encrypted-auth.json and refresh formats are shared with kiokuflow web
// and Obsidian (gemihub-sync-core/auth); only the transport lives here.
export { decodeMigrationToken };

async function driveJSON(api: PluginAPI, url: string, accessToken: string): Promise<unknown> {
  const response = await request(api, url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (response.status < 200 || response.status >= 300) throw new Error(`Google Drive request failed: HTTP ${response.status}`);
  return response.json;
}

export async function createConnection(api: PluginAPI, token: string, workspace: Workspace): Promise<StoredConnection> {
  const temporary = decodeMigrationToken(token);
  const query = encodeURIComponent(`name='${ENCRYPTED_AUTH_FILE_NAME}' and '${temporary.rootFolderId}' in parents and trashed=false`);
  const listed = await driveJSON(api, `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id)&pageSize=1`, temporary.accessToken) as { files?: Array<{ id: string }> };
  const id = listed.files?.[0]?.id;
  if (!id) throw new Error("_encrypted-auth.json was not found. Enable encryption in kiokuflow, then generate a new sync token.");
  const response = await request(api, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`, { headers: { Authorization: `Bearer ${temporary.accessToken}` } });
  if (response.status !== 200) throw new Error(`Could not read encrypted authentication: HTTP ${response.status}`);
  const auth = parseEncryptedAuthFile(response.json);
  return { ...auth, rootFolderId: temporary.rootFolderId, workspace };
}

export async function unlockConnection(api: PluginAPI, connection: StoredConnection, password: string): Promise<Session> {
  const { refreshToken, apiOrigin } = await decryptEncryptedAuth(connection, password);
  return refreshSession(api, { accessToken: "", refreshToken, apiOrigin, rootFolderId: connection.rootFolderId, expiryTime: 0 });
}

export async function refreshSession(api: PluginAPI, session: Session): Promise<Session> {
  if (!needsTokenRefresh(session.expiryTime)) return session;
  const { url, ...init } = buildTokenRefreshRequest(session, session.rootFolderId);
  const response = await request(api, url, init);
  const refreshed = parseTokenRefreshResponse(response.status, response.json);
  return { ...session, ...refreshed };
}
