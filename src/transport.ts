import type { HTTPResponse, PluginAPI } from "./types";

function bufferBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Buffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

export interface TransportResponse extends HTTPResponse { text: string; json: unknown; arrayBuffer: ArrayBuffer }

export async function request(api: PluginAPI, url: string, options: { method?: string; headers?: Record<string, string>; body?: string | ArrayBuffer } = {}): Promise<TransportResponse> {
  if (!api.network) throw new Error("This plugin requires the network permission and a compatible kiokuflow Desktop version.");
  const response = await api.network.request({
    url,
    method: options.method ?? "GET",
    headers: options.headers ?? {},
    ...(options.body instanceof ArrayBuffer ? { bodyBase64: bufferBase64(options.body) } : { body: options.body }),
  });
  let json: unknown = null;
  try { json = response.body ? JSON.parse(response.body) : null; } catch { /* non-JSON response */ }
  return { ...response, text: response.body, json, arrayBuffer: base64Buffer(response.bodyBase64) };
}
