/**
 * agent 的 computer use 工具请求（computerUseRequest）→ 沙箱 guest 桥 → 回执载荷。
 *
 * **沙箱与文件协议全在主进程**（SandboxController，browserRequest 同一条边界）：
 * agent 进程不碰沙箱、不碰 out/cmd，它那边只剩「工具定义 → requestId 问答」一层薄包装。
 * 沙箱是应用级一份（不按会话分）——多个会话同时使唤它时，事件按到达顺序注入，这正是
 * 「一个桌面」的语义。**浏览器车道不同**：sandbox_* 在 v1.5-1 起按会话各用一个 Edge 实例
 * （main/computer-use/cdp.ts），会话 id 在那里是路由键，不只是日志。宿主侧仍然按轮拿租约，
 * 本刀不动租约的资源切分。
 *
 * **坐标换算不在这里**：模型给的是它看到的那张截图的像素，换算在工具层做
 * （agent/computer-tools.ts 存下最近一次截图的几何），到这一层全是沙箱物理像素。
 * 这里只做三件事：动作 → guest 命令、回执 → 给模型的人话、「沙箱没在跑」→ 一句
 * 模型能转告用户的话（启沙箱是用户在设置页按的按钮，模型自己按不了）。
 *
 * 任何路径都必须回执：挂着不回的话 agent 进程里那次工具调用会一直等下去
 * （terminalRequest / readTaskRequest 同一条纪律）。
 *
 * 用户优先（桥 0.11.0）：像素动作在沙箱里被推迟过时，桥回 yielded / waitedMs，
 * 这一层把它变成正文里的一句「刚才那一下为什么晚了」——模型看不见沙箱窗口，
 * 只靠回执才知道“人在用它”（deferredNote）。不动任何命令的字段与租约。
 *
 * 密码框遮罩（桥 0.12.0）：截图回执带 capture（遮了几个密码框、清单过没过期、用户是不是
 * 正在打字），captureNote 把它翻成一句人话追在正文后面——**没遮必须明说**：让模型以为
 * 遮了比不遮更坏（它会放心地读图）。
 */
import {
  captureNote,
  computerUseGuestCommands,
  parseComputerUseDelivery,
  parseComputerUseEvidence,
  settleComputerUseDelivery,
  type ComputerUseAdmission,
  type ComputerUseDelivery,
  type ComputerUseGuestCommand,
  type ComputerUseScreenshotResult,
  type ComputerUseToolOutcome,
  type ComputerUseToolRequest,
  type ComputerUseUiaAction,
  type ComputerUseUiaActResult,
  type ComputerUseUiaListResult,
  type ComputerUseWindowListResult,
  type ComputerUseWindowShotResult,
} from "../../shared/computer-use.ts";
import type { GuestCommandReply } from "./sandbox.ts";
import type { SandboxCapabilities } from "./provider.ts";
import { cuLanguage, cuTexts } from "./ui-language.ts";
import { guestNoteText } from "./bridge-error-text.ts";

/**
 * 这一层真正要的那几个能力。**收窄成接口而不是直接吃 SandboxController**：
 * 回执组装是纯翻译，测试注入一个只有这几个方法的假沙箱就够，不必起状态机、
 * 不必碰文件协议（SandboxController 结构上满足它，生产环境直接传实例）。
 */
export interface ComputerUseGuest {
  screenshot(maxWidth?: number): Promise<ComputerUseScreenshotResult>;
  /**
   * 像素命令的下发（click / type / key / scroll）。成功时**带 resp**：交付档位（confirmed /
   * unverifiable / refused …）就在里面，这一层不替桥猜。
   */
  guestCommand(command: ComputerUseGuestCommand, fields: Record<string, unknown>): Promise<GuestCommandReply>;
  /**
   * 按**窗口**截图（桥 0.9.0 的 win-shot）。hwnd 优先，否则 title 不区分大小写包含匹配。
   * 失败时 error 是桥给出的人话（「这个窗口拍不到…——改用整桌面截图或 computer_screenshot」），
   * 这一层**只追加候选窗口清单**，不改写那句话。
   */
  windowShot(options: {
    hwnd?: number;
    title?: string;
    maxWidth?: number;
  }): Promise<ComputerUseWindowShotResult>;
  /** 可截图的顶层窗口列表（win-list）。按标题拍失败时用它把候选窗口告诉模型 */
  listWindows(timeoutMs?: number): Promise<ComputerUseWindowListResult>;
  /**
   * 列出一个窗口里可动作的控件（桥 0.10.0 的 uia-list）。只读、不抢焦点。
   * 失败时 error 是桥的人话（「没找到标题包含…的窗口」/「目标窗口没有响应（UIA 调用超时…）」），
   * 这一层**不改写**。
   */
  uiaList(options: {
    hwnd?: number;
    title?: string;
    maxItems?: number;
    /** 只回这一代之后的变化（带上一次回执里的 generation）；缺省 = 全量 */
    since?: number;
  }): Promise<ComputerUseUiaListResult>;
  /**
   * 对控件执行 UIA 模式（桥 0.10.0 的 uia-act）。不抢前台，所以不占桌面租约。
   * 动作集里没有 focus（桥 0.11.0 删）：它动的是桌面级焦点，接线层会直接拒并回替代路径。
   */
  uiaAct(options: {
    hwnd?: number;
    title?: string;
    /** 带代次的 ref token（"g12:r3"），来自该窗口最近一次 list */
    ref?: string;
    name?: string;
    perform: ComputerUseUiaAction;
    value?: string;
    timeoutMs?: number;
  }): Promise<ComputerUseUiaActResult>;
}

/**
 * 按标题拍失败后列候选窗口的预算。不能吃默认的 45s：那条路刚白等过一次（可能已经超时），
 * 再用一整条命令预算去列清单，agent 那边的 broker（60s）会先放弃——模型只看到「主进程没有回执」，
 * 而候选人话里其实已经有「该传 hwnd 还是换标题」的答案。TCP 通道下这条命令是毫秒级。
 */
const WINDOW_LIST_TIMEOUT_MS = 5_000;

export async function applyComputerUseRequest(
  controller: ComputerUseGuest,
  /**
   * 只用于日志与观测，**不改变任何命令的语义**：沙箱里就一个桌面，同一条 click 无论在谁的
   * 轮次里都只做一件事——「一个会话同一时间用沙箱」由 computer-use/lease.ts 保证（index.ts
   * 先 acquire 再调到这里），不在这一层。带上它是因为真机排查要回答「这一下到底是谁发的」：
   * 租约挡住的是并发，日志回答的是事后归因。
   */
  sessionId: string,
  request: ComputerUseToolRequest,
  /**
   * 正在跑的那个后端的**能力声明**（index.ts 传 `computerUse.capabilities()`）。
   * 它的 `evidence` 决定这一层能不能出 `confirmed` / `suspected_noop`（见 gateForBackend）。
   *
   * **拿不到就传 null（或省略）——不等于「没有证据能力」**：沙箱没在跑、能力声明还没就绪，
   * 与「这个后端没有读回」是两件不同的事。拿不到时档位与正文都不动（旧行为），
   * 不猜一个更坏的档位塞给模型。
   */
  capabilities: SandboxCapabilities | null = null,
): Promise<ComputerUseToolOutcome> {
  // 证据级别：优先用调用方给的当前后端能力，没给时退一步读控制器自己声明的 `capabilities`
  const evidence = evidenceOf(controller, capabilities);
  console.log(`[computer-use] ${sessionId} → ${request.action}`);
  try {
    switch (request.action) {
      case "screenshot": {
        // screenshot + window = 按窗口截图（桥 0.9.0）。它不占桌面租约（理由见
        // shared/computer-use.ts 的 isWindowScreenshotRequest），回执的几何是**窗口**的像素
        if (request.window !== undefined) return await windowShot(controller, request.window, request.maxWidth);
        const shot = await controller.screenshot(request.maxWidth);
        if (!shot.ok) return { ok: false, error: shot.error };
        return {
          ok: true,
          text:
            cuTexts().rcptDesktopShot(shot.width, shot.height, shot.nativeWidth, shot.nativeHeight) +
            captureNote(shot.capture, cuTexts()),
          shot: {
            width: shot.width,
            height: shot.height,
            nativeWidth: shot.nativeWidth,
            nativeHeight: shot.nativeHeight,
            data: shot.jpegBase64,
            ...(shot.mime === undefined ? {} : { mime: shot.mime }),
          },
          ...(shot.capture === undefined ? {} : { capture: shot.capture }),
        };
      }
      case "click": {
        const button = request.button ?? "left";
        const reply = await controller.guestCommand(computerUseGuestCommands.click, {
          x: request.x,
          y: request.y,
          button,
          double: request.double === true,
        });
        if (!reply.ok) return failedReply(reply, evidence);
        const delivery = deliveryOf(reply.resp, evidence);
        const kind = `${request.double === true ? "double " : ""}${button} click`;
        return {
          ok: true,
          delivery,
          text:
            cuTexts().rcptClickSent(kind, request.x, request.y) + " " +
            deliveryNote(delivery, evidence) +
            guestNote(reply.resp) +
            admissionNote(reply.admission, sessionId) +
            deferredNote(reply),
        };
      }
      case "type": {
        const reply = await controller.guestCommand(computerUseGuestCommands.type, { text: request.text });
        if (!reply.ok) return failedReply(reply, evidence);
        const delivery = deliveryOf(reply.resp, evidence);
        return {
          ok: true,
          delivery,
          text:
            cuTexts().rcptTypedChars(request.text.length) + " " +
            deliveryNote(delivery, evidence) + guestNote(reply.resp) + deferredNote(reply),
        };
      }
      case "key": {
        const reply = await controller.guestCommand(computerUseGuestCommands.key, { key: request.key });
        if (!reply.ok) return failedReply(reply, evidence);
        const delivery = deliveryOf(reply.resp, evidence);
        return {
          ok: true,
          delivery,
          text: cuTexts().rcptKeyPressed(request.key) + " " + deliveryNote(delivery, evidence) +
            guestNote(reply.resp) + deferredNote(reply),
        };
      }
      case "scroll": {
        const reply = await controller.guestCommand(computerUseGuestCommands.scroll, {
          x: request.x,
          y: request.y,
          deltaY: request.deltaY,
        });
        if (!reply.ok) return failedReply(reply, evidence);
        const delivery = deliveryOf(reply.resp, evidence);
        return {
          ok: true,
          delivery,
          text:
            `${cuTexts().rcptScrolled(request.deltaY, request.x, request.y)} ${deliveryNote(delivery, evidence)}` +
            guestNote(reply.resp) +
            admissionNote(reply.admission, sessionId) +
            deferredNote(reply),
        };
      }
      // ── UIA 车道（桥 0.10.0）：按控件动作，不按坐标、不抢前台 ─────────────
      case "uia-list": {
        const size = request.maxItems === undefined ? {} : { maxItems: request.maxItems };
        // since 只有模型明确给了才下发：不传 = 全量（与改之前逐字同行为）
        const since = request.since === undefined ? {} : { since: request.since };
        const reply = await controller.uiaList({ ...targetOf(request.window), ...size, ...since });
        if (!reply.ok) return { ok: false, error: reply.error };
        return { ok: true, text: uiaListText(reply) };
      }
      case "uia-act": {
        const reply = await controller.uiaAct({
          ...targetOf(request.window),
          ...(request.ref === undefined ? {} : { ref: request.ref }),
          ...(request.name === undefined ? {} : { name: request.name }),
          perform: request.perform,
          ...(request.value === undefined ? {} : { value: request.value }),
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        });
        // 失败也走 failedReply：桥明确拒绝时它已经带 `delivery:"refused"`（控制器层在
        // GuestCommandRejected 那里补的——那里才知道「桥回了 ok:false」与「超时没回应」的分别，
        // 见 sandbox.ts / isolation-session.ts 的 rejectedUiaAct）。这一层只负责过后端闸门，
        // 不替它猜档位：超时那条绝不能被补成 refused。
        if (!reply.ok) return failedReply(reply, evidence);
        // setValue（桥 0.15.0）自带读回：桥发 delivery + evidence，这一层不再自己猜。
        // 两道闸门与像素命令同一套：没证据的 confirmed 降回 unverifiable（settle），
        // 声明「拿不到读回」的后端不出确认档（gateForBackend）。
        const delivery =
          reply.delivery === undefined
            ? undefined
            : gateForBackend(settleComputerUseDelivery(reply.delivery, reply.evidence), evidence);
        return {
          ok: true,
          text: uiaActText(reply, delivery, evidence),
          ...(delivery === undefined ? {} : { delivery }),
        };
      }
      // sandbox_* 动作走 CDP 通道（main/computer-use/cdp.ts），不经过这一层：
      // 它们要一条常驻的 CdpSession（socket / 标签页 / 自动起 Edge），而这里只认沙箱状态机。
      // index.ts 按 isSandboxBrowserAction 分流；走到这里说明分流漏了，宁可报错也不要静默。
      default:
        return {
          ok: false,
          error: cuTexts().internalWrongLane(request.action, "pixel"),
        };
    }
  } catch (cause: unknown) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * 能力声明里的「证据级别」。null = 不知道（后端没在跑 / 调用方没给），与 "none" 不是一回事：
 * "none" 是「这个后端确实没有读回」，null 是「我还不知道它有没有」——后者不能拿来降档。
 */
type EvidenceLevel = SandboxCapabilities["evidence"];

/**
 * 这一层用的证据级别：**优先用调用方传的当前后端能力**（index.ts 传 `computerUse.capabilities()`，
 * 那是门面回答的「现在在跑谁」），没有时**退一步读控制器自己声明的 `capabilities`**
 * （`SandboxProvider` 上就是一个只读属性）。
 *
 * 为什么要有退路：直接把后端控制器交给这一层（单测、将来别的入口）时，它也必须按自己
 * 声明的证据级别被门控——否则同一个后端换一个入口就能把 `confirmed` / `suspected_noop`
 * 漏给模型，写在 `QEMU_CAPABILITIES` 里的 "none" 就成了摆设。
 * 这里是**运行时校验**而不是直接强转：读到一个不认识的 `evidence` 就当不知道（null），
 * 不猜一个档位（猜「有证据」会伪造确认，猜「没证据」会把能确认的后端误降级）。
 */
function evidenceOf(controller: ComputerUseGuest, capabilities: SandboxCapabilities | null): EvidenceLevel | null {
  if (capabilities !== null) return capabilities.evidence;
  const declared: unknown = (controller as { capabilities?: unknown }).capabilities;
  if (typeof declared !== "object" || declared === null) return null;
  const level: unknown = (declared as { evidence?: unknown }).evidence;
  return level === "value" || level === "window" || level === "none" ? level : null;
}

/**
 * 后端声明的证据级别 → 这一层能不能出这个档位。**拿不到任何读回的后端
 * （`evidence: "none"`）永远不出 `confirmed` / `suspected_noop`**，一律降成 `unverifiable`。
 *
 * 为什么不仅靠「这次没有证据」那一条闸门（settleComputerUseDelivery）：那道闸门只能拦
 * `confirmed`，拦不住 `suspected_noop`，也拦不住将来某条路径伪造出一份证据对象。
 * 声明是后端自己的事实——它说没有读回，那这一层就不能把「有读回」的话交给模型。
 * 为什么 `unknown`（null）原样返回：拿不到能力不等于没有证据能力（沙箱可能正在启动），
 * 替它降档会让本来能确认的后端也变成「永远确认不了」。
 */
function gateForBackend(delivery: ComputerUseDelivery, evidence: EvidenceLevel | null): ComputerUseDelivery {
  if (evidence !== "none") return delivery;
  return delivery === "confirmed" || delivery === "suspected_noop" ? "unverifiable" : delivery;
}

/**
 * 回执里的 delivery → 契约档位，并**当场过两道闸门**：先「没证据不许 confirmed」
 * （settleComputerUseDelivery），再「这个后端拿不到读回就永不出确认档」（gateForBackend）。
 *
 * 桥没说（老桥 / 非像素命令）时兜底 `unverifiable`：像素命令能走到「有回执且 ok」这一步，
 * 本来就只能是「已发出、未验证」——这正是 SendInput 返回值的真实含义。
 *
 * 为什么降级必须在这里做、不能只做成 shared 里的一个工具函数：工具回执是模型唯一读得到的
 * 地方。老桥发 `applied` 会被归一成 `confirmed`，但那一跳**没有任何读回证据**；如果让它
 * 原样流出去，模型就会看到一句「已确认生效」——正是这次要消灭的谎报。
 */
function deliveryOf(resp: Record<string, unknown>, evidence: EvidenceLevel | null): ComputerUseDelivery {
  // 桥发了读回证据就带上（桥 0.15.0 起 setValue / 将来的像素读回）；形状不对等于没发
  // （parseComputerUseEvidence 不抛错）。少了这一跳，桥发来的证据就是白发的——上一轮验收
  // 指出的 gap 正是这里。
  const readback = parseComputerUseEvidence(resp["evidence"]);
  const settled = settleComputerUseDelivery(parseComputerUseDelivery(resp["delivery"]) ?? "unverifiable", readback);
  return gateForBackend(settled, evidence);
}

/**
 * 桥在**成功回执**里给的一句补充（0.15.0 的 partial 用它说「差几个事件、补松开了哪些」）。
 *
 * 为什么要在宿主这里再拼一次：正文是这一层拼的，桥的 note 不会自己跑到模型眼前；
 * 不拼的话 partial 的原因、补松开的键名都只活在回执的 JSON 里，模型只看得到一句
 * 「只完成了一部分」。没 note 就一个字都不加——不凭空编一句。
 */
function guestNote(resp: Record<string, unknown>): string {
  const note = resp["note"];
  // 桥给的补充说明是中文：跟界面语言走（认不出的在英文界面下丢掉，原文进日志）
  return typeof note === "string" && note !== "" ? ` ${guestNoteText(note, cuLanguage())}` : "";
}

/**
 * 成功回执后面跟的那句交付说明（2026-11-28 起跟界面语言走）。
 *
 * 为什么另取一份而不直接用 `COMPUTER_USE_DELIVERY_HINTS`：那个常量的另一头是**工具描述**
 * （agent/computer-tools.ts 拼进去），工具描述不随界面语言变；回执正文要跟着界面走，
 * 两件事从此分开。内容仍是同一套五档口径（zh 那半边与常量逐字一致）。
 *
 * `evidence: "none"` 的后端再追加一句「永远拿不到读回」：五档那句话讲的是「这一次」，
 * 而这类后端是**永远**拿不到——不说死，模型会一直等一个不会来的确认。
 */
function deliveryNote(delivery: ComputerUseDelivery, evidence: EvidenceLevel | null): string {
  const texts = cuTexts();
  const hint =
    delivery === "confirmed"
      ? texts.deliveryConfirmed
      : delivery === "partial"
        ? texts.deliveryPartial
        : delivery === "unverifiable"
          ? texts.deliveryUnverifiable
          : delivery === "suspected_noop"
            ? texts.deliverySuspectedNoop
            : texts.deliveryRefused;
  return hint + (evidence === "none" ? texts.noEvidenceHint : "");
}

/**
 * 下发失败 → 回执。桥明确说的 `delivery:"refused"` 原样带出（「确定没做成」）；
 * 超时 / 沙箱没在跑这类没有那一档——那时我们不知道那一下有没有生效，不能替它断言。
 * 同样过后端闸门：失败回执里出现一个无证据后端的 `confirmed` 是矛盾，不能原样交给模型。
 * 这里不追加 NO_EVIDENCE 那句话：正文是桥的错误原话，失败时该做的是看错误、不是去截图。
 */
function failedReply(
  reply: { ok: false; error: string; delivery?: ComputerUseDelivery },
  evidence: EvidenceLevel | null,
): ComputerUseToolOutcome {
  const delivery =
    reply.delivery === undefined
      ? undefined
      : gateForBackend(settleComputerUseDelivery(reply.delivery), evidence);
  return { ok: false, error: reply.error, ...(delivery === undefined ? {} : { delivery }) };
}

/**
 * 让路回执 → 一句「刚才那一下为什么晚了」。模型看不见沙箱窗口，这一句是它唯一能学到
 * 「用户正在用这个桌面」的地方：否则它只会看到一条成功的回执，然后接着按自己的节奏动手。
 *
 * 只在桥真的推迟过（yielded:true）时才追加——没让路的回执一个字都不变。
 */
function deferredNote(reply: GuestCommandReply): string {
  if (reply.ok !== true || reply.yielded !== true) return "";
  return cuTexts().rcptDeferred(reply.waitedMs ?? 0);
}

/**
 * 按窗口截图的回执组装（screenshot + window）。
 *
 * 两件额外的事：
 *   ① 失败时**只追加**候选窗口清单，不改写桥那句「这个窗口拍不到（…）——改用整桌面截图或
 *      computer_screenshot」——那是模型唯一的换路指示；
 *   ② 成功时明说「这张图的坐标**不能**用于 computer_click」：窗口图的原点是窗口左上角，
 *      点击要的是整屏物理像素，两者混用会“成功地”点到别处。
 */
async function windowShot(
  controller: ComputerUseGuest,
  target: string | number,
  maxWidth: number | undefined,
): Promise<ComputerUseToolOutcome> {
  const size = maxWidth === undefined ? {} : { maxWidth };
  const options = typeof target === "number" ? { hwnd: target, ...size } : { title: target, ...size };
  const shot = await controller.windowShot(options);
  if (!shot.ok) {
    // 只有「按标题找」才值得列候选：传了 hwnd 就是那个窗口本身拍不到，列清单没有帮助
    const candidates = typeof target === "string" ? await candidateLine(controller) : "";
    return { ok: false, error: shot.error + candidates };
  }
  const texts = cuTexts();
  return {
    ok: true,
    text:
      texts.rcptWindowShot(shot.title, shot.hwnd, shot.width, shot.height, shot.nativeWidth, shot.nativeHeight) +
      (shot.restoredFromMinimized ? texts.rcptWindowRestored : "") +
      ` ${texts.rcptWindowShotFooter}` +
      captureNote(shot.capture, texts),
    shot: {
      width: shot.width,
      height: shot.height,
      nativeWidth: shot.nativeWidth,
      nativeHeight: shot.nativeHeight,
      data: shot.jpegBase64,
      ...(shot.mime === undefined ? {} : { mime: shot.mime }),
    },
    ...(shot.capture === undefined ? {} : { capture: shot.capture }),
  };
}

/** 候选窗口清单（best effort：列不出来就回空串，绝不让「列清单失败」顶掉真正的失败原因） */
async function candidateLine(controller: ComputerUseGuest): Promise<string> {
  const list = await controller.listWindows(WINDOW_LIST_TIMEOUT_MS).catch(() => null);
  if (list === null || !list.ok) return "";
  const minimized = cuTexts().rcptWindowMinimized;
  const rows = list.windows.slice(0, 12).map((window) => {
    const process = window.process === "" ? "" : ` (${window.process})`;
    const state = window.minimized ? minimized : "";
    return `hwnd ${window.hwnd} "${window.title}"${process}${state}`;
  });
  if (rows.length === 0) return "";
  return cuTexts().rcptCandidates(rows.join("; "));
}

/**
 * 请求里的 window → 桥要的 hwnd / title 两个字段（数字 = hwnd，字符串 = 标题片段）。
 * 空的字符串也照发：让桥回「没找到标题包含「」的窗口」比宿主静默丢掉它更不容易错。
 */
function targetOf(window: string | number | undefined): { hwnd?: number; title?: string } {
  if (window === undefined) return {};
  return typeof window === "number" ? { hwnd: window } : { title: window };
}

/**
 * uia-list 回执 → 给模型读的文本。
 *
 * 一行一个控件（标题行先给窗口与命中数）：模型要拿 ref 或 name 去 uia-act，所以这两个字段
 * 必须在前；patterns / 可用性 / offscreen 决定它该用哪个动作、要不要先滚动。
 * **不输出 JSON**：模型已经能把一行行的「ref · 类型 · 名字」对上去，多一层括号只是多烧 token。
 *
 * 0.14.0 起有两种形态：全量（与改之前同样的逐条清单）与 diff（只列变化 + 消失的 + unchanged
 * 计数）。diff 的体积优势就来自「不变的控件根本不出现」——所以两种形态的差异必须在正文里说清，
 * 尤其是 **ref 只属于它那一代**：没变的控件不在 diff 里，要动它就用 name 或重新全量列一次。
 */
function uiaListText(reply: {
  hwnd: number;
  window: { title: string; className: string };
  generation: number;
  mode: "full" | "diff";
  since?: number;
  items: readonly {
    ref: string;
    stableId: string;
    name: string;
    controlType: string;
    automationId: string;
    className: string;
    x: number;
    y: number;
    w: number;
    h: number;
    patterns: readonly string[];
    enabled: boolean;
    offscreen: boolean;
    isPassword: boolean;
    change?: "added" | "changed";
    changed?: readonly string[];
  }[];
  removed: readonly { stableId: string; name: string; controlType: string }[];
  unchanged: number;
  /** 只挪了位置的条数（diff 才可能 >0）：不逐条列，正文只说一句 */
  rectMoved: number;
  truncated: boolean;
  passwordFields: number;
  /** 树里的输入框个数（含密码框）；用来发现「登录页还没长完」 */
  editFields: number;
  note?: string;
}): string {
  const texts = cuTexts();
  const title = reply.window.title === "" ? texts.rcptUiaNoTitle : reply.window.title;
  const body =
    reply.mode === "diff" ? uiaDiffBody(reply) : reply.items.map(uiaItemLine).join(String.fromCharCode(10));
  const bodyText =
    body === "" ? (reply.mode === "diff" ? texts.rcptUiaNothingChanged : texts.rcptUiaNoControls) : body;
  const head =
    reply.mode === "diff"
      ? texts.rcptUiaDiffHead(
          title,
          reply.hwnd,
          reply.generation,
          reply.items.length,
          reply.removed.length,
          reply.unchanged,
          reply.rectMoved,
          String(reply.since ?? "?"),
          reply.truncated,
        )
      : texts.rcptUiaListHead(title, reply.hwnd, reply.generation, reply.items.length, reply.truncated);
  const noteLine = reply.note === undefined ? "" : texts.rcptUiaNoteLine(reply.note);
  const tail = texts.rcptUiaTail(reply.generation, reply.mode === "diff");
  const passwordNote =
    reply.passwordFields > 0
      ? texts.rcptUiaPasswordNote(reply.passwordFields)
      : reply.editFields > 0
        ? texts.rcptUiaEditNote(reply.editFields)
        : "";
  return `${head}${noteLine}${String.fromCharCode(10)}${bodyText}${String.fromCharCode(10)}${String.fromCharCode(10)}${tail}${passwordNote}`;
}

/** 一条控件的正文行（全量与 diff 共用；diff 只在前面加 change 标签） */
function uiaItemLine(item: {
  ref: string;
  name: string;
  controlType: string;
  automationId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  patterns: readonly string[];
  enabled: boolean;
  offscreen: boolean;
  isPassword: boolean;
  change?: "added" | "changed";
  changed?: readonly string[];
}): string {
  const texts = cuTexts();
  const name = item.name === "" ? texts.rcptUiaItemUnnamed(item.automationId) : `"${item.name}"`;
  const patterns = item.patterns.length === 0 ? texts.rcptUiaItemNoPattern : item.patterns.join("/");
  const flags: string[] = [];
  if (item.isPassword) flags.push(texts.rcptUiaFlagPassword);
  if (!item.enabled) flags.push(texts.rcptUiaFlagDisabled);
  if (item.offscreen) flags.push(texts.rcptUiaFlagOffscreen);
  const id = item.automationId === "" ? "" : ` id=${item.automationId}`;
  const state = flags.length === 0 ? "" : `${texts.rcptUiaStateSeparator}${flags.join(texts.rcptUiaFlagJoiner)}`;
  const change =
    item.change === "added"
      ? texts.rcptUiaChangeNew
      : item.change === "changed"
        ? texts.rcptUiaChangeChanged((item.changed ?? []).join("/"))
        : "";
  return (
    `${change}${item.ref} · ${item.controlType} ${name} · ${texts.rcptUiaItemSupports} ${patterns}${state} · ` +
    `${texts.rcptUiaItemAt} ${item.x},${item.y} ${item.w}×${item.h}${id}`
  );
}

/** diff 的正文：变化过的控件 + 消失的控件（消失的没有 ref，只有名字与稳定 id） */
function uiaDiffBody(reply: {
  items: readonly {
    ref: string;
    stableId: string;
    name: string;
    controlType: string;
    automationId: string;
    className: string;
    x: number;
    y: number;
    w: number;
    h: number;
    patterns: readonly string[];
    enabled: boolean;
    offscreen: boolean;
    isPassword: boolean;
    change?: "added" | "changed";
    changed?: readonly string[];
  }[];
  removed: readonly { stableId: string; name: string; controlType: string }[];
}): string {
  const lines = reply.items.map(uiaItemLine);
  for (const gone of reply.removed) {
    const name = gone.name === "" ? "(unnamed)" : `"${gone.name}"`;
    lines.push(`gone · ${gone.controlType} ${name} — no longer in this window (it has no ref any more)`);
  }
  return lines.join("\n");
}

/**
 * 应用级准入给模型的一句话（桥 0.11.0 的观察模式）。**只在回执里，不改变行为**：
 * 这一轮不拒任何目标，只是让「这一下打在了谁身上」在回执和日志里可见。
 *
 * 为什么要写给模型看：它后面的动作是按「我点的是自己那只 Edge」推断的，如果实际点的是
 * notepad.exe，接着的截图/断言会全都对不上——这句话让它能自己发现目标错了。
 */
function admissionNote(admission: ComputerUseAdmission | undefined, sessionId: string): string {
  if (admission === undefined) return "";
  const target = admission.targetExe === "" ? "(unknown process)" : admission.targetExe;
  console.log(
    `[computer-use] ${sessionId} admission=${admission.admission} targetExe=${target}` +
      (admission.targetPid === undefined ? "" : ` pid=${admission.targetPid}`),
  );
  const texts = cuTexts();
  const tail =
    admission.admission === "bypassed"
      ? texts.rcptAdmissionBypassed
      : admission.admission === "unknown"
        ? texts.rcptAdmissionUnknown
        : texts.rcptAdmissionOwned;
  return texts.rcptAdmission(admission.admission, target, tail);
}

/** uia-act 成功回执 → 给模型读的文本（含 AutoSetFocus 降级时的抢焦点警告与读回档位） */
function uiaActText(
  reply: {
    hwnd: number;
    action: string;
    usedPattern: string;
    name: string;
    controlType: string;
    autoSetFocus: boolean;
    autoSetFocusWarning?: string;
    admission?: ComputerUseAdmission;
    elapsedMs: number;
  },
  delivery: ComputerUseDelivery | undefined = undefined,
  evidence: EvidenceLevel | null = null,
): string {
  const texts = cuTexts();
  const name = reply.name === "" ? texts.rcptUiaActUnnamed : `"${reply.name}"`;
  const verb =
    reply.action === "setValue"
      ? texts.rcptUiaVerbSetValue
      : reply.action === "selection"
        ? texts.rcptUiaVerbSelection
        : texts.rcptUiaVerbInvoke;
  const head =
    texts.rcptUiaActHead(verb, name, reply.controlType, reply.hwnd, reply.usedPattern, reply.elapsedMs) +
    texts.rcptUiaActFooter(reply.hwnd) +
    // setValue 的读回档位（桥 0.15.0）：桥没说就一个字都不加（老桥 / invoke / selection）
    (delivery === undefined ? "" : ` ${deliveryNote(delivery, evidence)}`) +
    admissionNote(reply.admission, "uia-act");
  if (reply.autoSetFocus) return head;
  const warning = reply.autoSetFocusWarning ?? texts.rcptUiaActAutoFocusDefault;
  return `${head}\n\n${texts.rcptUiaActWarningLabel}${warning}`;
}
