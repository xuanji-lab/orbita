import { test } from "node:test";
import assert from "node:assert/strict";
import { browserUserAgent } from "./identity.ts";

const ELECTRON_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) orbita/0.1.0 Chrome/140.0.7339.41 Electron/43.2.0 Safari/537.36";
const ORBITA_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.41 Safari/537.36 Orbita/0.1.9";

test("去掉应用名与 Electron token，末尾追加 Orbita/<版本>，保留 Chrome / Safari token", () => {
  assert.equal(browserUserAgent(ELECTRON_UA, "orbita", "0.1.9"), ORBITA_UA);
});

test("应用名大小写不敏感；dev 下应用名就是 Electron 也成立", () => {
  assert.equal(browserUserAgent(ELECTRON_UA, "ORBITA", "0.1.9"), ORBITA_UA);
  assert.equal(
    browserUserAgent(ELECTRON_UA.replace("orbita/0.1.0", "Electron/43.2.0"), "Electron", "0.1.9"),
    ORBITA_UA,
  );
});

test("幂等：改写过的再改一遍不变；版本变了只换版本、不叠两个 token", () => {
  assert.equal(browserUserAgent(ORBITA_UA, "orbita", "0.1.9"), ORBITA_UA);
  assert.equal(browserUserAgent(ORBITA_UA, "orbita", "0.2.0"), ORBITA_UA.replace("Orbita/0.1.9", "Orbita/0.2.0"));
});

test("不冒充 Chrome：结果里一定带 Orbita token，绝不出现 Electron token", () => {
  const ua = browserUserAgent(ELECTRON_UA, "orbita", "0.1.9");
  assert.match(ua, / Orbita\/0\.1\.9$/);
  assert.doesNotMatch(ua, /Electron\//);
});

test("应用名里的正则元字符不会炸", () => {
  const base = ORBITA_UA.replace(" Orbita/0.1.9", "");
  assert.equal(browserUserAgent(`${base} a.b+c/1.0`, "a.b+c", "0.1.9"), ORBITA_UA);
});
