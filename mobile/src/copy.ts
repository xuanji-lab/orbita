/**
 * 手机端的界面文字（第一刀只有中文）。
 *
 * 出处：设计稿分支 `proto/mobile-look` 的 `messages-zh.ts` 里 `mobile` 一节（用户认可的那一版），
 * 改了两处：配对码的有效期从 5 分钟改成 3 分钟（契约 `MOBILE_CRYPTO.offerTtlMs`）；过期后电脑设置页
 * 那颗键叫「再生成一组」（桌面侧 PR #568 的实际叫法：生成配对码 / 换一组 / 再生成一组），过期提示照它写。
 * 另补了设计稿没画到的几句（配对码不对、被劫持、被电脑忘掉、回复没发出去）。
 *
 * 规矩照桌面的中文表：全角标点；中文与数字 / 拉丁字母之间留一个空格。
 */
import { MOBILE_CRYPTO, MOBILE_TAIL_PAGE } from "../../src/shared/mobile.ts";

const OFFER_MINUTES = MOBILE_CRYPTO.offerTtlMs / 60_000;

export const copy = {
  pair: {
    title: "连上你的电脑",
    lead: "这块屏幕只用来看和回：智能体、任务记录和密钥都留在电脑上。它和电脑要在同一个 Tailscale 网络、或同一个局域网里。",
    hostLabel: "主机地址",
    hostPlaceholder: "例如 100.64.0.12，或电脑的主机名",
    codeLabel: "配对码",
    codePlaceholder: "000 000",
    codeWhere: `地址和配对码都在电脑的 设置 › 手机 里，配对码 ${OFFER_MINUTES} 分钟内有效。`,
    connect: "配对",
    connecting: "正在配对…",
    deriving: (percent: number) => `正在核对配对码… ${percent}%`,
    expired: "配对码已过期。",
    expiredHint: "在电脑的 设置 › 手机 里再生成一组，再输一次。",
    wrongCode: "配对码不对。",
    wrongCodeHint: "对一下电脑上 设置 › 手机 里的 6 位数字。",
    offline: (host: string) => `连不上 ${host}。`,
    offlineHint: "电脑可能睡着了，或者不在同一个网络里。",
    hijacked: "没连上你的电脑，地址可能被劫持。",
    hijackedHint: "这次配对没有保存。确认地址是你自己的电脑，再生成一组配对码。",
    busy: "配对试得太频繁了。",
    busyHint: "等一分钟再试。",
    protocol: "对面不像是璇玑。",
    protocolHint: "确认地址和端口是电脑 设置 › 手机 里写的那一个。",
    badAddress: "地址的写法不对。",
    badAddressHint: "写 IP 或主机名，端口不是默认的 47620 时写成 地址:端口。",
    retry: "重试",
  },
  host: {
    online: "在线",
    tailscale: "经 Tailscale",
    lan: "经局域网",
    loopback: "经本机回环",
    other: "经主机名",
    reconnecting: "正在重连…",
    stopped: "电脑没开，点一下再连",
    lastSync: (clock: string) => `最后同步 ${clock}`,
    rejected: "电脑认不出这台手机了。",
    rejectedHint: "它可能在电脑上被忘掉了。重新配对一次就好。",
    rePair: "重新配对",
  },
  list: {
    group: { waiting: "等你", running: "在跑", done: "跑完没看", failed: "出错" },
    more: (count: number) => `还有 ${count} 件`,
    less: "收起",
    workspaces: "工作区",
    tasks: "任务",
    older: (count: number) => `更早的 ${count} 条`,
    olderOnHost: "更早的任务在电脑上。",
    empty: "这台电脑上还没有任务。",
    emptyHint: "在电脑上开个任务，这里就有了。",
    loading: "正在读任务清单…",
    failed: "没读到任务清单。",
    subRunning: (count: number) => `${count} 个子会话在跑`,
    above: (count: number) => `另有 ${count} 件在上面`,
  },
  chat: {
    back: "返回",
    tail: (count: number) => `只显示最近 ${count} 条。`,
    tailCount: MOBILE_TAIL_PAGE,
    loadEarlier: "载入更早的",
    loading: "正在读最近的消息…",
    loadFailed: "没读到这条任务的消息。",
    empty: "这条任务还没有消息。",
    reconnecting: "和电脑断开了，正在重连…",
    reconnectingHint: "你写的话先留在手机上，连上后再发。",
    placeholder: "回一句",
    placeholderRunning: "回一句，这一轮跑完后发出",
    placeholderOffline: "回一句，连上后再发",
    send: "发送",
    stop: "停止",
    queued: "这一轮跑完后发出",
    sending: "正在发…",
    replyFailed: (message: string) => `没发出去：${message}`,
    dismiss: "知道了",
    beforeDisconnect: "断线前",
    retry: "重试",
    planWaiting: "计划写好了，等你确认。回一句「开工」，或者说要改哪里。",
    images: (count: number) => `带了 ${count} 张图`,
    steps: (count: number) => `做了 ${count} 步`,
    stepsFailed: (count: number) => `${count} 步没成`,
    stopFailed: "没停下来，再按一次试试。",
    state: { running: "在跑", waiting: "等你", done: "跑完了", failed: "出错", idle: "空闲" },
  },
  time: {
    now: "刚刚",
    minutes: (n: number) => `${n} 分钟`,
    hours: (n: number) => `${n} 小时`,
    yesterday: "昨天",
    days: (n: number) => `${n} 天`,
  },
} as const;
