/**
 * llama-server 的生命周期核 —— **纯模块**：spawn / HTTP / 端口全注入，
 * 可被 `node --test` 直接测（host-core 的同款分层）。真的 child_process 与
 * fetch 在服务进程的装配层（server-core 之外、runtime 薄壳之内）。
 *
 * 职责：按需拉起（embed 前确保健康）、请求转发（/v1/embeddings）、
 * 空闲 N 分钟卸载（用电池 / 不用向量时别占着 500MB 内存）、崩溃自清理。
 * Miyo 同款策略；评测实测热加载 <1s，按需拉起对交互无感。
 *
 * embed 的失败语义：返回 null（不抛）——调用方（service-core 的召回路径）
 * 对 null 退字面召回，向量不可用不报错不拦开轮。
 */
import { normalize } from "./vector-store.ts";

/** 对子进程的最小要求（child_process.ChildProcess 结构上满足；测试假货顶上）。 */
export interface EmbedServerChild {
  on(event: "exit", listener: (code: number | null) => void): unknown;
  kill(): unknown;
}

/** 模型配置：前缀 / pooling / 维度随模型走（选型报告 §4 的实测参数）。 */
export interface EmbedModelConfig {
  /** 模型标识（vector manifest 的 model） */
  id: string;
  /** GGUF 绝对路径 */
  modelPath: string;
  /** llama-server --pooling 参数；null = GGUF 自带（jina 式） */
  pooling: "mean" | "last" | "cls" | null;
  /** -c 上下文（评测用 8192；文档条目短，留头寸） */
  ctx: number;
  /** 查询前缀（非空才拼） */
  queryPrefix: string | null;
  /** 文档前缀（非空才拼） */
  docPrefix: string | null;
  /** 输出维度（MRL 截断后的实际维度） */
  dims: number;
}

export interface EmbedServerOptions {
  /** 模型路径解析（binaryPath + modelPath；null = 没启用 / 没就绪，embed 直接 null） */
  resolve: () => { binaryPath: string; model: EmbedModelConfig } | null;
  /** 真的 spawn（注入；返回子进程） */
  spawn: (args: readonly string[]) => EmbedServerChild;
  /** /health 探活（注入） */
  probe: (port: number) => Promise<boolean>;
  /** POST /v1/embeddings（注入；返回按 index 排好序的原始向量） */
  post: (port: number, texts: readonly string[]) => Promise<number[][]>;
  /** 找一个空闲端口（注入；主装配层用 net 先占再放） */
  freePort: () => Promise<number>;
  /** 空闲多久卸载（默认 5 分钟） */
  idleUnloadMs?: number;
  /** 拉起等健康的超时（默认 90 秒：冷启动含大模型读盘） */
  startTimeoutMs?: number;
  log?: (message: string, ...args: unknown[]) => void;
  now?: () => number;
}

const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_START_TIMEOUT_MS = 90_000;

export class EmbedServerCore {
  private readonly resolve: EmbedServerOptions["resolve"];
  private readonly spawn: EmbedServerOptions["spawn"];
  private readonly probe: EmbedServerOptions["probe"];
  private readonly post: EmbedServerOptions["post"];
  private readonly freePort: EmbedServerOptions["freePort"];
  private idleUnloadMs: number;
  private readonly startTimeoutMs: number;
  private readonly log: (message: string, ...args: unknown[]) => void;
  private readonly now: () => number;
  private child: EmbedServerChild | null = null;
  private port = 0;
  private starting: Promise<boolean> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  /** 在途嵌入请求数：大于零时禁用空闲卸载，最后一条结束后才重新计时 */
  private activeEmbeds = 0;
  /** 上次请求的模型 id：换模型（设置改了）要重启 llama-server */
  private startedFor: string | null = null;

  constructor(options: EmbedServerOptions) {
    this.resolve = options.resolve;
    this.spawn = options.spawn;
    this.probe = options.probe;
    this.post = options.post;
    this.freePort = options.freePort;
    this.idleUnloadMs = options.idleUnloadMs ?? DEFAULT_IDLE_MS;
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? (() => Date.now());
  }

  isRunning(): boolean {
    // 已 spawn 但还在健康检查的不算就绪：召回的冷启动路径不该因此等加载
    return this.child !== null && this.starting === null;
  }

  /** 设置页改空闲卸载分钟后立即生效；运行中的进程重排计时。 */
  setIdleUnloadMs(ms: number): void {
    this.idleUnloadMs = ms;
    if (this.isRunning()) this.armIdle();
  }

  /**
   * 确保服务在跑且健康。没启用（resolve null）/ spawn 失败 / 健康超时都返回
   * false（embed 会退 null）。换模型时先停旧进程再拉新的。
   */
  ready(): Promise<boolean> {
    const resolved = this.resolve();
    if (resolved === null) return Promise.resolve(false);
    // 先看 starting：spawn 已发生但健康检查没完时，不能把 child 非空当成就绪
    if (this.starting !== null && this.startedFor === resolved.model.id) return this.starting;
    if (this.child !== null && this.startedFor === resolved.model.id) return Promise.resolve(true);
    this.stop();
    const { binaryPath, model } = resolved;
    this.startedFor = model.id;
    const starting = new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        if (this.starting === starting) this.starting = null;
        resolve(ok);
      };
      void this.freePort()
        .then(async (port: number) => {
          // 等端口时配置被关 / 换模型：这次启动已经作废
          if (this.starting !== starting) {
            finish(false);
            return;
          }
          const args = [
            "-m",
            model.modelPath,
            "--host",
            "127.0.0.1",
            "--port",
            `${port}`,
            "-c",
            `${model.ctx}`,
            "-ub",
            "4096",
            "--embedding",
            ...(model.pooling !== null ? ["--pooling", model.pooling] : []),
          ];
          let child: EmbedServerChild;
          try {
            child = this.spawn([binaryPath, ...args]);
          } catch (cause) {
            this.log("[memory] llama-server spawn 失败", cause);
            this.startedFor = null;
            finish(false);
            return;
          }
          this.child = child;
          this.port = port;
          child.on("exit", () => {
            if (this.child === child) {
              this.child = null;
              this.port = 0;
            }
          });
          // 健康轮询：300ms 一拍，直到超时。进程死了 / 配置改了立刻失败
          const deadline = this.now() + this.startTimeoutMs;
          while (this.now() < deadline) {
            if (this.child !== child || this.starting !== starting) {
              finish(false);
              return;
            }
            if (await this.probe(port)) {
              if (this.child !== child || this.starting !== starting) {
                finish(false);
                return;
              }
              this.armIdle();
              finish(true);
              return;
            }
            await new Promise((sleep) => setTimeout(sleep, 300));
          }
          if (this.child === child) this.stop();
          finish(false);
        })
        .catch((cause: unknown) => {
          this.log("[memory] llama-server 启动失败", cause);
          if (this.starting === starting) this.stop();
          finish(false);
        });
    });
    this.starting = starting;
    return starting;
  }

  /**
   * 嵌入一批文本（查询走 queryPrefix、条目走 docPrefix 由调用方拼好传入）。
   * 不可用 / 失败返回 null；向量 L2 归一化后交回（打分即点积）。
   */
  async embed(texts: readonly string[]): Promise<Float32Array[] | null> {
    if (texts.length === 0) return [];
    if (!(await this.ready())) return null;
    this.activeEmbeds += 1;
    this.disarmIdle();
    try {
      const raw = await this.post(this.port, texts);
      if (raw.length !== texts.length) return null;
      return raw.map((values) => normalize(Float32Array.from(values)));
    } catch (cause) {
      // 状态未知（进程可能死了）：停掉，下次用时重拉。本轮退字面
      this.log("[memory] llama-server 嵌入请求失败（本轮退字面召回）", cause);
      this.stop();
      return null;
    } finally {
      this.activeEmbeds -= 1;
      if (this.activeEmbeds === 0 && this.child !== null) this.armIdle();
    }
  }

  /** 停进程 + 清状态（空闲卸载 / 换模型 / 服务退出）。 */
  stop(): void {
    const child = this.child;
    this.child = null;
    this.port = 0;
    this.starting = null;
    this.startedFor = null;
    this.disarmIdle();
    if (child !== null) {
      try {
        child.kill();
      } catch {
        // 已经死了
      }
    }
  }

  /** 重置闲置计时（有请求时调；embed 内部已调）。 */
  private armIdle(): void {
    this.disarmIdle();
    if (this.child === null || this.activeEmbeds > 0) return;
    const timer = setTimeout(() => {
      this.idleTimer = null;
      if (this.child !== null) {
        this.log("[memory] llama-server 空闲卸载（下次用到再拉，热加载 <1s）");
        this.stop();
      }
    }, this.idleUnloadMs);
    timer.unref?.();
    this.idleTimer = timer;
  }

  private disarmIdle(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
