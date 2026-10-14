import { test } from "node:test";
import assert from "node:assert/strict";
import { browserClientHints, browserUserAgent, hostClientHintsHost } from "./identity.ts";

const ELECTRON_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) orbita/0.1.0 Chrome/140.0.7339.41 Electron/43.2.0 Safari/537.36";
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.41 Safari/537.36";

test("去掉应用名与 Electron token，保留 Chrome / Safari token", () => {
  assert.equal(browserUserAgent(ELECTRON_UA, "orbita"), CHROME_UA);
});

test("应用名大小写不敏感；dev 下应用名就是 Electron 也成立", () => {
  assert.equal(browserUserAgent(ELECTRON_UA, "ORBITA"), CHROME_UA);
  assert.equal(
    browserUserAgent(ELECTRON_UA.replace("orbita/0.1.0", "Electron/43.2.0"), "Electron"),
    CHROME_UA,
  );
});

test("幂等：改写过的再改一遍不变", () => {
  assert.equal(browserUserAgent(CHROME_UA, "orbita"), CHROME_UA);
});

test("应用名里的正则元字符不会炸", () => {
  assert.equal(browserUserAgent(`${CHROME_UA} a.b+c/1.0`, "a.b+c"), CHROME_UA);
});

const WINDOWS_HOST = { platform: "Windows", platformVersion: "15.0.0", arch: "x86" } as const;

test("client hints：brands 带上 Google Chrome，版本号从 UA 里取", () => {
  const hints = browserClientHints(CHROME_UA, WINDOWS_HOST);
  assert.equal(hints["Sec-CH-UA"], `"Not;A=Brand";v="8", "Chromium";v="140", "Google Chrome";v="140"`);
  assert.equal(
    hints["Sec-CH-UA-Full-Version-List"],
    `"Not;A=Brand";v="8.0.0.0", "Chromium";v="140.0.7339.41", "Google Chrome";v="140.0.7339.41"`,
  );
  assert.equal(hints["Sec-CH-UA-Mobile"], "?0");
  assert.equal(hints["Sec-CH-UA-Platform"], `"Windows"`);
  assert.equal(hints["Sec-CH-UA-Platform-Version"], `"15.0.0"`);
  assert.equal(hints["Sec-CH-UA-Form-Factors"], `"Desktop"`);
  assert.equal(hints["Sec-CH-UA-WoW64"], "?0");
});

test("client hints：非 Windows 不发 WoW64；UA 里没有 Chrome token 也不炸", () => {
  const mac = browserClientHints(CHROME_UA, { platform: "macOS", platformVersion: "15.0.0", arch: "arm" });
  assert.equal(mac["Sec-CH-UA-WoW64"], undefined);
  assert.equal(mac["Sec-CH-UA-Arch"], `"arm"`);
  const noChrome = browserClientHints("Mozilla/5.0", WINDOWS_HOST);
  assert.equal(noChrome["Sec-CH-UA"], `"Not;A=Brand";v="8", "Chromium";v="", "Google Chrome";v=""`);
});

test("hostClientHintsHost：Windows 按 build 折算 Platform-Version", () => {
  assert.deepEqual(hostClientHintsHost("win32", "10.0.26200", "x64"), {
    platform: "Windows",
    platformVersion: "19.0.0",
    arch: "x86",
  });
  assert.deepEqual(hostClientHintsHost("win32", "10.0.22000", "x64"), {
    platform: "Windows",
    platformVersion: "13.0.0",
    arch: "x86",
  });
  assert.equal(hostClientHintsHost("win32", "10.0.19045", "x64").platformVersion, "10.0.0");
});

test("hostClientHintsHost：macOS 用 Darwin 主版本减 9，minor/patch 对齐", () => {
  assert.deepEqual(hostClientHintsHost("darwin", "24.6.0", "arm64"), {
    platform: "macOS",
    platformVersion: "15.6.0",
    arch: "arm",
  });
  assert.equal(hostClientHintsHost("linux", "6.8.0", "x64").platformVersion, "");
});
