import assert from "node:assert/strict";
import { test } from "node:test";
import { appUserModelIdFor } from "./app-identity.ts";

test("开发版与安装版使用不同 AUMID，安装版身份保持 electron-builder appId", () => {
  assert.equal(appUserModelIdFor(true), "com.orbita.desktop");
  assert.equal(appUserModelIdFor(false), "com.orbita.desktop.dev");
  assert.notEqual(appUserModelIdFor(false), appUserModelIdFor(true));
});
