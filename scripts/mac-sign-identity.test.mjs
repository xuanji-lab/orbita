import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  electronBuilderMacIdentityArgs,
  parseCodesigningIdentities,
  resolveSignIdentity,
  selectIdentityMatches,
} from "./mac-sign-identity.mjs";

describe("resolveSignIdentity", () => {
  it("未设置时返回 null（保持 ad-hoc 默认）", () => {
    assert.equal(resolveSignIdentity({}), null);
  });

  it("空串与全空白返回 null", () => {
    assert.equal(resolveSignIdentity({ ORBITA_MAC_SIGN_IDENTITY: "" }), null);
    assert.equal(resolveSignIdentity({ ORBITA_MAC_SIGN_IDENTITY: "   \t " }), null);
  });

  it("去掉首尾空白后返回证书名（名字可含空格）", () => {
    assert.equal(resolveSignIdentity({ ORBITA_MAC_SIGN_IDENTITY: "orbita-sign" }), "orbita-sign");
    assert.equal(resolveSignIdentity({ ORBITA_MAC_SIGN_IDENTITY: "  orbita sign cert \n" }), "orbita sign cert");
  });
});

describe("parseCodesigningIdentities", () => {
  it("解析证书名（含带空格的名字）并去重", () => {
    const output = [
      "Policy: X.509 Basic",
      "  Matching identities",
      '  1) ABCDEF0123 "orbita sign" (CSSM OK)',
      '  2) 1234ABCDEF "orbita sign" (CSSM OK)',
      '  3) FEDCBA9876 "another-cert"',
      "  3 valid identities found",
    ].join("\n");
    assert.deepEqual(parseCodesigningIdentities(output), ["orbita sign", "another-cert"]);
  });

  it("过滤缺 codeSigning 扩展的证书与汇总行", () => {
    const output = [
      '  1) ABCDEF0123 "no-eku-cert" (Missing required extension)',
      '  2) 1234ABCDEF "good-cert"',
      "  1 valid identities found",
    ].join("\n");
    assert.deepEqual(parseCodesigningIdentities(output), ["good-cert"]);
  });

  it("空输出与无证书输出都返回空数组", () => {
    assert.deepEqual(parseCodesigningIdentities(""), []);
    assert.deepEqual(parseCodesigningIdentities("0 valid identities found"), []);
  });
});

describe("selectIdentityMatches", () => {
  it("子串匹配，与 electron-builder 的 line.includes 一致", () => {
    const names = ["orbita sign", "orbita sign (old)", "other"];
    assert.deepEqual(selectIdentityMatches(names, "orbita sign"), ["orbita sign", "orbita sign (old)"]);
    assert.deepEqual(selectIdentityMatches(names, "orbita sign (old)"), ["orbita sign (old)"]);
  });

  it("无命中返回空数组", () => {
    assert.deepEqual(selectIdentityMatches(["a", "b"], "c"), []);
  });
});

describe("electronBuilderMacIdentityArgs", () => {
  it("null 与显式 - 不产生覆盖参数（走 package.json 的 ad-hoc 配置）", () => {
    assert.deepEqual(electronBuilderMacIdentityArgs(null), []);
    assert.deepEqual(electronBuilderMacIdentityArgs("-"), []);
  });

  it("生成点号形式的单 token 覆盖参数", () => {
    assert.deepEqual(electronBuilderMacIdentityArgs("orbita sign"), ["--config.mac.identity=orbita sign"]);
  });
});
