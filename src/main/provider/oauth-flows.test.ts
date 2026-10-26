import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import {
  createInteraction,
  emailFromJwt,
  fromPiCredential,
  isPiOauthKind,
  modelsFromCredential,
  oauthRequestAuth,
  runPiOauthLogin,
  toPiCredential,
} from "./oauth-flows.ts";

const jwt = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

describe("凭据换形：pi 的 OAuthCredential ↔ 我们的 OauthCredential", () => {
  test("公共四项对上，其余字段进 flowData，往回换时原样摊开（Copilot 续期要 enterpriseUrl）", () => {
    const ours = fromPiCredential(
      { type: "oauth", access: "a", refresh: "r", expires: 1_000_000, enterpriseUrl: "corp.ghe.com", availableModelIds: ["m"] },
      null,
    );
    assert.equal(ours.accessToken, "a");
    assert.equal(ours.refreshToken, "r");
    // 统一再扣 1 分钟提前量（Codex 的流程自己没扣）
    assert.equal(ours.expiresAt, 1_000_000 - 60_000);
    assert.deepEqual(ours.flowData, { enterpriseUrl: "corp.ghe.com", availableModelIds: ["m"] });
    const back = toPiCredential(ours);
    assert.equal(back.type, "oauth");
    assert.equal(back.access, "a");
    assert.equal(back["enterpriseUrl"], "corp.ghe.com");
  });

  test("没有额外字段（xAI）就不带 flowData", () => {
    assert.equal("flowData" in fromPiCredential({ type: "oauth", access: "a", refresh: "r", expires: 9 }, null), false);
  });

  test("账号邮箱：Codex 的 profile 声明、通用 email 声明；不是 JWT 的（Copilot 令牌）为 null", () => {
    assert.equal(emailFromJwt(jwt({ "https://api.openai.com/profile": { email: "me@x.com" } })), "me@x.com");
    assert.equal(emailFromJwt(jwt({ email: "g@x.ai" })), "g@x.ai");
    assert.equal(emailFromJwt("tid=1;exp=2;proxy-ep=proxy.individual.githubcopilot.com"), null);
  });

  test("Copilot 登录问出的可用型号拿来预填；没有就是空", () => {
    const base = { accessToken: "a", refreshToken: "r", expiresAt: 1, accountEmail: null };
    assert.deepEqual(modelsFromCredential({ ...base, flowData: { availableModelIds: ["gpt-5.2", 3, ""] } }), ["gpt-5.2"]);
    assert.deepEqual(modelsFromCredential(base), []);
  });
});

describe("交互回调：pi 流程的每一种提问都有去向（漏接一种流程就挂住）", () => {
  const ports = () => {
    const opened: string[] = [];
    const codes: { userCode: string; verificationUri: string }[] = [];
    return {
      opened,
      codes,
      openExternal: async (url: string) => {
        opened.push(url);
      },
      onDeviceCode: (code: { userCode: string; verificationUri: string }) => codes.push(code),
      signal: new AbortController().signal,
    };
  };

  test("select（Codex 问浏览器还是设备码）选浏览器；text（Copilot 问企业域名）留空 = github.com", async () => {
    const io = createInteraction(ports(), new AbortController().signal);
    const select: AuthPrompt = {
      type: "select",
      message: "?",
      options: [
        { id: "browser", label: "Browser" },
        { id: "device_code", label: "Device" },
      ],
    };
    assert.equal(await io.prompt(select), "browser");
    assert.equal(await io.prompt({ type: "text", message: "GitHub Enterprise URL/domain" }), "");
    await assert.rejects(() => io.prompt({ type: "secret", message: "key" }));
  });

  test("manual_code 不提供：挂着，直到流程自己取消它（拿到回调后）", async () => {
    const io = createInteraction(ports(), new AbortController().signal);
    const own = new AbortController();
    const pending = io.prompt({ type: "manual_code", message: "paste", signal: own.signal });
    own.abort();
    await assert.rejects(pending, /cancelled/);
  });

  test("auth_url 打开浏览器；device_code 既推给设置页显示，又打开输入验证码的页面", () => {
    const p = ports();
    const io = createInteraction(p, new AbortController().signal);
    io.notify({ type: "auth_url", url: "https://auth.openai.com/oauth/authorize?x=1" });
    io.notify({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" });
    io.notify({ type: "progress", message: "Enabling models..." });
    assert.deepEqual(p.opened, ["https://auth.openai.com/oauth/authorize?x=1", "https://github.com/login/device"]);
    assert.deepEqual(p.codes, [{ userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" }]);
  });
});

describe("pi 流程的接线（不联网）", () => {
  test("三家走 pi，Claude 不走", () => {
    assert.equal(isPiOauthKind("openai-codex"), true);
    assert.equal(isPiOauthKind("github-copilot"), true);
    assert.equal(isPiOauthKind("xai"), true);
    assert.equal(isPiOauthKind("claude"), false);
  });

  test("用户取消：真的 pi 流程（xAI 设备码）在发请求前就停下，报「登录已取消」", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () =>
        runPiOauthLogin("xai", {
          openExternal: async () => undefined,
          onDeviceCode: () => undefined,
          signal: controller.signal,
        }),
      /登录已取消/,
    );
  });

  test("Copilot 的请求地址按令牌里的 proxy-ep 改写（商业版不是个人版的地址）——pi 的 toAuth", async () => {
    const auth = await oauthRequestAuth("github-copilot", {
      accessToken: "tid=1;exp=2;proxy-ep=proxy.business.githubcopilot.com;",
      refreshToken: "gho_x",
      expiresAt: Date.now() + 1000,
      accountEmail: null,
    });
    assert.equal(auth.baseUrl, "https://api.business.githubcopilot.com");
    assert.equal(auth.apiKey, "tid=1;exp=2;proxy-ep=proxy.business.githubcopilot.com;");
  });

  test("Claude / Codex / xAI：鉴权就是访问令牌本身，不改地址", async () => {
    const credential = { accessToken: "tok", refreshToken: "r", expiresAt: Date.now() + 1000, accountEmail: null };
    assert.deepEqual(await oauthRequestAuth("claude", credential), { apiKey: "tok" });
    assert.deepEqual(await oauthRequestAuth("xai", credential), { apiKey: "tok" });
  });
});
