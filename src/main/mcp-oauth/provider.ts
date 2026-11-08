/**
 * SDK `auth()` 要的 OAuthClientProvider，主进程一侧的实现，**只给登录用，一次登录一个实例，状态都在内存里**——
 * 凭据怎么落盘是 manager 的事（credential-store.ts），本类只把 SDK 要存的东西接住。
 *
 * 没有 client 信息起步：SDK 会向授权服务器动态注册一个——每次登录都注册新的，因为 redirect_uri 的端口是这次
 * 随机分到的，旧注册里的端口对不上，严格的授权服务器会拒。`onRedirect` 接住授权地址去开浏览器。
 *
 * **续期不走这里**：SDK 的 `auth()` 在 refresh 遇到网络错误时会悄悄退回「重新授权」，分不出「授权服务器暂时连不上」
 * 与「refresh token 被拒」，续期必须分得清（前者留着凭据下次再试，后者才删），所以 manager 直接调
 * `refreshAuthorization`，它会把服务端的 invalid_grant 抛成 OAuthError、把网络错误原样抛出。
 */
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

export interface FlowProviderOptions {
  redirectUrl: string;
  /** 登录时给 SDK 的 state（回调服务器按它校验）；续期不需要 */
  state: string;
  onRedirect: (authorizationUrl: URL) => void | Promise<void>;
  /** 时钟（测试注入），算 expiresAt 用 */
  now?: () => number;
}

export class McpOauthFlowProvider implements OAuthClientProvider {
  private readonly redirect: string;
  private readonly fixedState: string;
  private readonly onRedirect: (authorizationUrl: URL) => void | Promise<void>;
  private readonly now: () => number;
  private client: OAuthClientInformationMixed | undefined;
  private tokenValue: OAuthTokens | undefined;
  private verifier = "";

  /** SDK 最近一次存下的授权服务器撤销端点（断开时用） */
  revocationEndpoint: string | null = null;
  /** 最近一次 saveTokens 的时刻；null = 这个实例里没存过新 token */
  tokensSavedAt: number | null = null;

  constructor(options: FlowProviderOptions) {
    this.redirect = options.redirectUrl;
    this.fixedState = options.state;
    this.onRedirect = options.onRedirect;
    this.now = options.now ?? Date.now;
  }

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Orbita",
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // 桌面应用是公共客户端：靠 PKCE，不带 client_secret
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.fixedState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.client;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.client = info;
  }

  tokens(): OAuthTokens | undefined {
    return this.tokenValue;
  }

  saveTokens(tokens: OAuthTokens): void {
    // 续期的响应常常不再带 refresh_token（沿用旧的）：别把唯一能续期的那个弄丢
    const refresh = tokens.refresh_token ?? this.tokenValue?.refresh_token;
    this.tokenValue = refresh === undefined ? tokens : { ...tokens, refresh_token: refresh };
    this.tokensSavedAt = this.now();
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.onRedirect(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (this.verifier === "") throw new Error("没有 PKCE code_verifier（授权请求还没发出）");
    return this.verifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "tokens") this.tokenValue = undefined;
    if (scope === "all" || scope === "client") this.client = undefined;
    if (scope === "all" || scope === "verifier") this.verifier = "";
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    // SDK 的 AuthorizationServerMetadata 类型没列 RFC 7009 的 revocation_endpoint，但元数据里有就原样带着
    const endpoint = (state.authorizationServerMetadata as { revocation_endpoint?: unknown } | undefined)?.revocation_endpoint;
    if (typeof endpoint === "string") this.revocationEndpoint = endpoint;
  }

  /** 登录成功后，manager 取走这一次的结果 */
  snapshot(): { client: OAuthClientInformationMixed | undefined; tokens: OAuthTokens | undefined } {
    return { client: this.client, tokens: this.tokenValue };
  }
}
