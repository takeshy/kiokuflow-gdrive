/// <reference lib="deno.ns" />
import { assertEquals, assertThrows } from "jsr:@std/assert";
import { decodeMigrationToken } from "./auth.ts";

function token(payload: unknown): string {
  return [...new TextEncoder().encode(JSON.stringify(payload))].map((value) => (value ^ 0x5a).toString(16).padStart(2, "0")).join("");
}

Deno.test("decodes the kiokuflow migration token", () => {
  assertEquals(decodeMigrationToken(token({ a: "access", r: "root" })), { accessToken: "access", rootFolderId: "root" });
  assertThrows(() => decodeMigrationToken("xyz"));
});
