/**
 * 测试夹具：一台本机的「假 Notion」——同一个端口上既是 MCP 资源服务器（Streamable HTTP，要 Bearer），
 * 又是它的授权服务器（Protected Resource Metadata → 授权服务器元数据 → 动态注册 → PKCE 授权码 → token / refresh / revoke）。
 * 不在应用调用路径上，只给 mcp-oauth 的端到端测试用。
 *
 * 做得和真服务一样严的几处（测试要验的正是这些）：PKCE 的 S256 校验、redirect_uri 必须与注册的一致、
 * 授权码一次性、**refresh token 轮换**（用过的旧 refresh token 再用 = invalid_grant）、
 * 未授权时回 `401 + WWW-Authenticate: Bearer resource_metadata=...`。
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface FixtureOptions {
  /** access token 的 expires_in（秒），默认 3600 */
  expiresIn?: number;
  /** 授权服务器元数据里不给 registration_endpoint（模拟不支持动态注册的服务） */
  noRegistration?: boolean;
  /** 授权端点改写成别的地址（模拟远端元数据塞了危险协议） */
  authorizeEndpoint?: string;
  /** token 端点不给 refresh_token（模拟没有 offline_access） */
  noRefreshToken?: boolean;
  /** 指定端口（默认 0 = OS 分配）。长驻自测时重启要回到同一个地址用 */
  port?: number;
}

export interface OauthFixture {
  /** `http://127.0.0.1:<port>` */
  base: string;
  /** MCP 地址 = `${base}/mcp` */
  mcpUrl: string;
  /** 服务端见到的、按顺序的记录，断言用 */
  log: {
    registered: Record<string, unknown>[];
    authorize: URLSearchParams[];
    tokenGrants: { grant: string; body: URLSearchParams }[];
    revoked: URLSearchParams[];
    /** /mcp 上每个请求带的 Authorization 头（没带为 null） */
    mcpAuth: (string | null)[];
  };
  /** 让已发出的 access token 全部失效（模拟服务端撤销 / 重置），refresh token 仍有效 */
  revokeAccessTokens(): void;
  /** 让已发出的 refresh token 全部失效（续期会得到 invalid_grant） */
  revokeRefreshTokens(): void;
  close(): Promise<void>;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startOauthFixture(options: FixtureOptions = {}): Promise<OauthFixture> {
  let base = "";
  const clients = new Map<string, { redirectUris: string[] }>();
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string }>();
  const accessTokens = new Set<string>();
  const refreshTokens = new Map<string, string>(); // refresh token → clientId
  const log: OauthFixture["log"] = { registered: [], authorize: [], tokenGrants: [], revoked: [], mcpAuth: [] };
  let counter = 0;

  const issue = (clientId: string): Record<string, unknown> => {
    counter += 1;
    const access = `at-${counter}-${randomBytes(4).toString("hex")}`;
    accessTokens.add(access);
    const out: Record<string, unknown> = { access_token: access, token_type: "Bearer", expires_in: options.expiresIn ?? 3600 };
    if (options.noRefreshToken !== true) {
      const refresh = `rt-${counter}-${randomBytes(4).toString("hex")}`;
      refreshTokens.set(refresh, clientId);
      out["refresh_token"] = refresh;
    }
    return out;
  };

  const metadata = (): Record<string, unknown> => ({
    issuer: base,
    authorization_endpoint: options.authorizeEndpoint ?? `${base}/authorize`,
    token_endpoint: `${base}/token`,
    ...(options.noRegistration === true ? {} : { registration_endpoint: `${base}/register` }),
    revocation_endpoint: `${base}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["default"],
  });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", base);
    const path = url.pathname;
    if (path.startsWith("/.well-known/oauth-protected-resource")) {
      json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["default"] });
      return;
    }
    if (path.startsWith("/.well-known/oauth-authorization-server")) {
      json(res, 200, metadata());
      return;
    }
    if (path === "/register" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as { redirect_uris?: string[] } & Record<string, unknown>;
      log.registered.push(body);
      const clientId = `client-${clients.size + 1}`;
      clients.set(clientId, { redirectUris: body.redirect_uris ?? [] });
      json(res, 201, { ...body, client_id: clientId });
      return;
    }
    if (path === "/authorize" && req.method === "GET") {
      // 「用户在浏览器里点了同意」：校验后 302 回 redirect_uri
      log.authorize.push(url.searchParams);
      const clientId = url.searchParams.get("client_id") ?? "";
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const client = clients.get(clientId);
      if (client === undefined || !client.redirectUris.includes(redirectUri)) {
        json(res, 400, { error: "invalid_request", error_description: "redirect_uri 与注册的不一致" });
        return;
      }
      if (url.searchParams.get("code_challenge_method") !== "S256") {
        json(res, 400, { error: "invalid_request", error_description: "需要 PKCE S256" });
        return;
      }
      const code = `code-${randomBytes(6).toString("hex")}`;
      codes.set(code, { clientId, redirectUri, challenge: url.searchParams.get("code_challenge") ?? "" });
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      const state = url.searchParams.get("state");
      if (state !== null) back.searchParams.set("state", state);
      res.writeHead(302, { Location: back.toString() });
      res.end();
      return;
    }
    if (path === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const grant = form.get("grant_type") ?? "";
      log.tokenGrants.push({ grant, body: form });
      if (grant === "authorization_code") {
        const code = form.get("code") ?? "";
        const record = codes.get(code);
        codes.delete(code); // 一次性
        const verifier = form.get("code_verifier") ?? "";
        if (
          record === undefined ||
          record.clientId !== form.get("client_id") ||
          record.redirectUri !== form.get("redirect_uri") ||
          createHash("sha256").update(verifier).digest("base64url") !== record.challenge
        ) {
          json(res, 400, { error: "invalid_grant", error_description: "授权码无效或 PKCE 校验失败" });
          return;
        }
        json(res, 200, issue(record.clientId));
        return;
      }
      if (grant === "refresh_token") {
        const refresh = form.get("refresh_token") ?? "";
        const clientId = refreshTokens.get(refresh);
        if (clientId === undefined || clientId !== form.get("client_id")) {
          json(res, 400, { error: "invalid_grant", error_description: "refresh token 无效（已用过或已撤销）" });
          return;
        }
        refreshTokens.delete(refresh); // 轮换：用过即作废
        json(res, 200, issue(clientId));
        return;
      }
      json(res, 400, { error: "unsupported_grant_type" });
      return;
    }
    if (path === "/revoke" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      log.revoked.push(form);
      const token = form.get("token") ?? "";
      refreshTokens.delete(token);
      accessTokens.delete(token);
      res.writeHead(200).end();
      return;
    }
    if (path === "/mcp") {
      const header = req.headers["authorization"] ?? null;
      log.mcpAuth.push(header);
      const bearer = header?.startsWith("Bearer ") === true ? header.slice(7) : "";
      if (!accessTokens.has(bearer)) {
        json(
          res,
          401,
          { error: "invalid_token" },
          { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` },
        );
        return;
      }
      // 无状态：每个请求一个 Server + 传输，足够 initialize / tools/list / tools/call
      const server = new Server({ name: "fake-notion", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: [{ name: "whoami", description: "回当前 token", inputSchema: { type: "object", properties: {} } }],
      }));
      server.setRequestHandler(CallToolRequestSchema, () => ({ content: [{ type: "text", text: `ok:${bearer}` }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => void transport.close());
      await server.connect(transport);
      const raw = req.method === "POST" ? await readBody(req) : "";
      await transport.handleRequest(req, res, raw === "" ? undefined : JSON.parse(raw));
      return;
    }
    res.writeHead(404).end();
  };

  const http: HttpServer = createServer((req, res) => {
    handle(req, res).catch((cause: unknown) => {
      if (!res.headersSent) json(res, 500, { error: "server_error", error_description: String(cause) });
    });
  });
  await new Promise<void>((resolve) => http.listen(options.port ?? 0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return {
    base,
    mcpUrl: `${base}/mcp`,
    log,
    revokeAccessTokens: () => accessTokens.clear(),
    revokeRefreshTokens: () => refreshTokens.clear(),
    close: async () => {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

/**
 * 测试里的「用户的浏览器」：拿到授权地址就去访问它（假授权端点直接 302 回本机回调），
 * 再顺着 Location 访问回调——等价于「用户点了同意、浏览器被重定向回 Orbita」。
 * `tamper` 可以改写回调地址（测错 state / error）。
 */
export async function fakeBrowser(
  authorizationUrl: string,
  tamper?: (callback: URL) => URL | null,
): Promise<{ authorizeStatus: number; callbackStatus: number | null }> {
  const first = await fetch(authorizationUrl, { redirect: "manual" });
  const location = first.headers.get("location");
  if (location === null) return { authorizeStatus: first.status, callbackStatus: null };
  const callback = tamper === undefined ? new URL(location) : tamper(new URL(location));
  if (callback === null) return { authorizeStatus: first.status, callbackStatus: null };
  const second = await fetch(callback, { redirect: "manual" });
  await second.arrayBuffer();
  return { authorizeStatus: first.status, callbackStatus: second.status };
}
