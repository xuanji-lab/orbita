import { test } from "node:test";
import assert from "node:assert/strict";
import { browserUserAgent } from "./identity.ts";

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
