import { test } from "node:test";
import assert from "node:assert/strict";
import { isReaderRequestAllowed } from "./gate.ts";
import type { GateRequestInfo } from "../window/request-gate.ts";

const OWN = "http://127.0.0.1:5273/";
const isOwnPage = (url: string): boolean => url.startsWith(OWN);
const base: GateRequestInfo = {
  url: "orbita-reader://app/reader.html",
  resourceType: "subFrame",
  frameUrl: null,
  parentUrl: OWN,
  parentHasParent: false,
  grandparentUrl: null,
  referrer: "",
};

test("入口页只能挂在我们自己的 renderer 页面下，且只能是 reader.html", () => {
  assert.equal(isReaderRequestAllowed(base, isOwnPage), true);
  assert.equal(isReaderRequestAllowed({ ...base, url: "orbita-reader://app/doc/abc" }, isOwnPage), false);
  assert.equal(isReaderRequestAllowed({ ...base, parentUrl: "https://evil.example/" }, isOwnPage), false);
  // 插件面板（orbita-panel://）里嵌一层阅读器：父框架不是我们的页面
  assert.equal(isReaderRequestAllowed({ ...base, parentUrl: "orbita-panel://doc/x", parentHasParent: true, grandparentUrl: OWN }, isOwnPage), false);
});

test("顶层导航一律拦", () => {
  assert.equal(isReaderRequestAllowed({ ...base, resourceType: "mainFrame", parentUrl: null }, isOwnPage), false);
});

test("阅读器内部的 pdf.js iframe：父是阅读器页面、祖父是我们的页面", () => {
  const inner = { ...base, url: "orbita-reader://app/pdf/web/viewer.html", parentUrl: "orbita-reader://app/reader.html", parentHasParent: true, grandparentUrl: OWN };
  assert.equal(isReaderRequestAllowed(inner, isOwnPage), true);
  assert.equal(isReaderRequestAllowed({ ...inner, grandparentUrl: "https://evil.example/" }, isOwnPage), false);
});

test("子资源：发起的框架必须是阅读器的页面；没有框架时看 referrer", () => {
  const sub = { ...base, resourceType: "xhr", url: "orbita-reader://app/doc/x", parentUrl: null };
  assert.equal(isReaderRequestAllowed({ ...sub, frameUrl: "orbita-reader://app/pdf/web/viewer.html" }, isOwnPage), true);
  // renderer 页面自己（或别的框架）来 fetch 当前 PDF：拦
  assert.equal(isReaderRequestAllowed({ ...sub, frameUrl: OWN }, isOwnPage), false);
  assert.equal(isReaderRequestAllowed({ ...sub, frameUrl: "orbita-panel://doc/x" }, isOwnPage), false);
  assert.equal(isReaderRequestAllowed({ ...sub, referrer: "orbita-reader://app/pdf/web/viewer.html" }, isOwnPage), true);
  assert.equal(isReaderRequestAllowed({ ...sub, referrer: OWN }, isOwnPage), false);
});
