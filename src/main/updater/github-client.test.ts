/**
 * 共享 GitHub 客户端（updater/github-client.ts）与「资产请求头」规则的测试。
 *
 * 钉住四件事：
 * - **缓存**：按「地址 + Accept」记成功的原文；`cache: false` 绕过（检查更新必须真的问一次）；
 * - **失败不缓存**：断网 / 5xx 之后的下一次必须真的再打（用户点「重试」有意义）；
 * - **限流**：`x-ratelimit-remaining: 0` 之后到 reset 之前不再发新请求（缓存命中照常），
 *   `retry-after` 同样折算成「到某时刻为止」；
 * - **资产头**：`api.github.com/releases/assets/<id>` 的请求必须是
 *   `Accept: application/octet-stream`——库在差分下载里写死通配 Accept，实测那会拿到 206 + JSON。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { RequestOptions } from "node:http";
import {
  ASSET_ACCEPT,
  GITHUB_BODY_LIMIT_BYTES,
  GitHubClient,
  GitHubHttpError,
  githubBodyLimitError,
  githubRedirectAllowed,
  isGitHubAssetRequest,
  isGitHubAssetUrl,
  withAssetAccept,
  type GitHubResponse,
  type GitHubTransport,
} from "./github-client.ts";

const ASSET = "https://api.github.com/repos/a/b/releases/assets/12";
const OTHER = "https://api.github.com/repos/a/b/releases/latest";

interface Call {
  url: string;
  accept: string | null;
}

/** 按地址作答的 transport 替身：没登记的地址回 404 */
function stubTransport(
  calls: Call[],
  routes: Record<string, { body: string; status?: number; headers?: Record<string, string> }>,
): GitHubTransport {
  return async ({ url, headers }) => {
    calls.push({ url: url.href, accept: headers.accept ?? null });
    const route = Object.entries(routes).find(([prefix]) => url.href.startsWith(prefix))?.[1];
    const response: GitHubResponse =
      route === undefined
        ? { status: 404, headers: {}, body: JSON.stringify({ message: "Not Found" }) }
        : { status: route.status ?? 200, headers: route.headers ?? {}, body: route.body };
    return response;
  };
}

describe("GitHubClient —— 缓存", () => {
  test("同地址同 Accept 第二次命中缓存；Accept 不同是另一份", async () => {
    const calls: Call[] = [];
    const client = new GitHubClient({ transport: stubTransport(calls, { [ASSET]: { body: "yml" } }) });

    assert.equal(await client.getAsset(ASSET), "yml");
    assert.equal(await client.getAsset(ASSET), "yml");
    assert.equal(calls.length, 1, "第二次应命中缓存");

    await client.getText(ASSET, "application/vnd.github+json");
    assert.equal(calls.length, 2, "Accept 不同不能共用一份缓存");
    assert.deepEqual(
      calls.map((call) => call.accept),
      [ASSET_ACCEPT, "application/vnd.github+json"],
    );
  });

  test("缓存过期后再打；cache: false 直接绕过", async () => {
    const calls: Call[] = [];
    let clock = 0;
    const client = new GitHubClient({
      transport: stubTransport(calls, { [OTHER]: { body: "{}" } }),
      now: () => clock,
      cacheTtlMs: 1000,
    });

    await client.getJson(OTHER);
    await client.getJson(OTHER);
    assert.equal(calls.length, 1);
    clock = 1001;
    await client.getJson(OTHER);
    assert.equal(calls.length, 2, "窗口过期后应重新请求");

    await client.getJson(OTHER, { cache: false });
    assert.equal(calls.length, 3, "检查更新这类请求必须绕过缓存");
  });

  test("失败不缓存：404 的下一次真的再打", async () => {
    const calls: Call[] = [];
    const client = new GitHubClient({ transport: stubTransport(calls, {}) });
    await assert.rejects(client.getAsset(ASSET), (error: unknown) => {
      assert.ok(error instanceof GitHubHttpError);
      assert.equal(error.statusCode, 404);
      return true;
    });
    await assert.rejects(client.getAsset(ASSET), GitHubHttpError);
    assert.equal(calls.length, 2);
  });

  test("返回的不是 JSON 时抛错，不把半个响应当数据", async () => {
    const client = new GitHubClient({
      transport: stubTransport([], { [OTHER]: { body: "<html>被代理拦了</html>" } }),
    });
    await assert.rejects(client.getJson(OTHER), /不是 JSON/);
  });
});

describe("GitHubClient —— 限流记录", () => {
  test("配额归零后到 reset 之前不发新请求；缓存命中照常", async () => {
    const calls: Call[] = [];
    let clock = 1_000_000;
    const client = new GitHubClient({
      transport: stubTransport(calls, {
        [OTHER]: {
          body: "{}",
          headers: { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1010" },
        },
      }),
      now: () => clock,
    });

    await client.getJson(OTHER);
    assert.equal(client.rateLimit().remaining, 0);
    assert.equal(client.rateLimit().blockedUntil, 1_010_000);

    // 新请求（缓存之外）快速失败，且没有网络请求
    await assert.rejects(client.getJson(`${OTHER}?per_page=5`, { cache: false }), (error: unknown) => {
      assert.ok(error instanceof GitHubHttpError);
      assert.equal(error.statusCode, 429);
      assert.match(error.message, /限流/);
      return true;
    });
    assert.equal(calls.length, 1, "限流期间不能白撞 GitHub");

    // 缓存命中不看限流（已经拿到的原文还能用）
    assert.deepEqual(await client.getJson(OTHER), {});

    // 过了 reset 时刻就能再打
    clock = 1_010_001;
    await client.getJson(`${OTHER}?per_page=5`, { cache: false });
    assert.equal(calls.length, 2);
  });

  test("retry-after 折算成「到某时刻为止」，并优先取更晚的那个", async () => {
    const calls: Call[] = [];
    let clock = 0;
    const client = new GitHubClient({
      transport: stubTransport(calls, {
        [OTHER]: { body: "{}", status: 429, headers: { "retry-after": "30" } },
      }),
      now: () => clock,
    });

    await assert.rejects(client.getJson(OTHER));
    assert.equal(client.rateLimit().blockedUntil, 30_000);

    clock = 29_000;
    await assert.rejects(client.getJson(OTHER, { cache: false }), GitHubHttpError);
    assert.equal(calls.length, 1);

    clock = 30_001;
    await assert.rejects(client.getJson(OTHER, { cache: false }), GitHubHttpError);
    assert.equal(calls.length, 2, "过了 retry-after 该重新尝试");
  });
});

describe("资产请求头规则 —— 库的差分下载写死 */* 后靠它改回来", () => {
  test("资产端点认得出：URL / Node 请求两种形态", () => {
    assert.equal(isGitHubAssetUrl(new URL(ASSET)), true);
    assert.equal(isGitHubAssetUrl(new URL(OTHER)), false);
    assert.equal(isGitHubAssetUrl(new URL("https://github.com/a/b/releases/download/v1/x.exe")), false);

    assert.equal(isGitHubAssetRequest("api.github.com", "/repos/a/b/releases/assets/12"), true);
    assert.equal(isGitHubAssetRequest("api.github.com", "/repos/a/b/releases/latest"), false);
    assert.equal(isGitHubAssetRequest("release-assets.githubusercontent.com", "/releases/assets/12"), false);
  });

  test("资产端点的 Accept 改成 octet-stream（覆盖库写死的 */*）", () => {
    const patched = withAssetAccept({
      hostname: "api.github.com",
      path: "/repos/a/b/releases/assets/12",
      headers: { accept: "*/*", range: "bytes=0-0" },
    });
    assert.deepEqual(patched.headers, { accept: ASSET_ACCEPT, range: "bytes=0-0" });
  });

  test("别的地址原样返回：不往 GitHub 之外的请求里塞头", () => {
    const options: RequestOptions = {
      hostname: "example.com",
      path: "/file",
      headers: { accept: "*/*" },
    };
    assert.equal(withAssetAccept(options), options);
  });
});

describe("githubRedirectAllowed —— 资产 302 目标域白名单（重定向不许把下载带去陌生域）", () => {
  test("放行 GitHub 自己的域（实测 2026-10-31：资产端点 302 到 release-assets.githubusercontent.com）", () => {
    assert.equal(githubRedirectAllowed(new URL("https://github.com/xuanji-lab/orbita/releases/download/v0.1.16/latest.yml")), true);
    assert.equal(githubRedirectAllowed(new URL("https://api.github.com/repos/a/b/releases/assets/12")), true);
    // 资产端点 302 的真实目标（Azure 签名地址，带查询串）
    assert.equal(
      githubRedirectAllowed(new URL("https://release-assets.githubusercontent.com/github-production-release-asset/xyz?sig=abc")),
      true,
    );
    assert.equal(githubRedirectAllowed(new URL("https://objects.githubusercontent.com/x/y")), true);
  });

  test("主机名大小写不敏感（规范成小写再比）", () => {
    assert.equal(githubRedirectAllowed(new URL("https://API.GitHub.com/repos/a/b")), true);
    assert.equal(githubRedirectAllowed(new URL("https://Objects.GitHubUserContent.com/x")), true);
  });

  test("拒绝：非 https、陌生域、前缀仿冒、裸 apex", () => {
    assert.equal(githubRedirectAllowed(new URL("http://objects.githubusercontent.com/x")), false, "只认 https");
    assert.equal(githubRedirectAllowed(new URL("https://evil.example.com/file")), false);
    assert.equal(githubRedirectAllowed(new URL("https://github.com.evil.example.com/file")), false, "前缀仿冒不算子域");
    assert.equal(githubRedirectAllowed(new URL("https://objects.githubusercontent.com.evil.example.com/x")), false);
    assert.equal(githubRedirectAllowed(new URL("https://githubusercontent.com/x")), false, "裸 apex 不放行");
    assert.equal(githubRedirectAllowed(new URL("file://github.com/etc/passwd")), false);
  });
});

describe("githubBodyLimitError —— 元数据响应的字节上限", () => {
  test("未超限是 null；恰好超限给出错误（这条通道只读 JSON / latest.yml 一类小文件）", () => {
    assert.equal(githubBodyLimitError(1024), null);
    assert.equal(githubBodyLimitError(GITHUB_BODY_LIMIT_BYTES), null);
    const error = githubBodyLimitError(GITHUB_BODY_LIMIT_BYTES + 1);
    assert.ok(error instanceof Error);
    assert.match(error.message, /超过/);
  });
});
