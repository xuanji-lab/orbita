/**
 * 设置 › 手机（2026-11-25，手机端「看与回」第一刀）：手机配对到这台电脑之前，电脑这头要做的三件事——
 * 开监听（选地址与端口）、生成配对码、管已配对的设备。手机设计稿上写的「地址和配对码都在电脑的
 * 设置 › 手机 里」指的就是这一页。
 *
 * 数据全走 `api.mobile`（契约在 src/shared/mobile.ts）：
 * - 开关 / 地址 / 端口改完，主进程回最新的 MobileSettings，页面不另拉；
 * - 设备的「此刻在线」没有推送通道，页面开着时每 3 秒拉一次 devices()（离开就停）；
 * - 主进程给的 message 是原话，如实照显示——地址不在本机时不静默换别的；hostKeyNotice 只有一种
 *   含义（主机密钥丢过、设备已清空），页面只把它当开关，用这一页自己的文案说（2026-11-25 设计审查 M6）；
 * - 配对码只在这一页上看得到：离开这一页就作废它（offerCancel），不留一组没人看着的码。
 *
 * 版式照现有设置页（`.set-page` 两栏、`SettingGroup` / `SettingRow`），控件照 SettingControls；
 * 移除设备的行内二次确认照插件详情「卸载…」那一套（`.pl-ic` + `.pl-btn.solid-danger`），
 * 告示与出错是行下的静默行（`.mobile-reason`），空态 / 加载 / 读失败照 `PanelEmpty`。
 */
import { useEffect, useRef, useState } from "react";
import { MOBILE_DEFAULT_PORT, type MobileDevice, type MobileOffer, type MobileSettings } from "@shared/mobile";
import { api } from "../../api";
import { useT } from "../../locale.ts";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { Icon } from "../../shell/Icon";
import { Menu, type MenuItem } from "../../shell/Menu";
import { PanelEmpty } from "../../shell/PanelEmpty";
import { relativeTime } from "../../shell/relative-time.ts";
import { ipcErrorText } from "../../utils/ipc-error.ts";
import { formatDay } from "./migration-groups.ts";
import {
  bindView,
  formatCountdown,
  groupPairingCode,
  isStaleDevice,
  needsInterfaceName,
  newlyPaired,
  offerSecondsLeft,
  parsePortInput,
  sortDevices,
} from "./mobile-settings.ts";
import { SettingGroup, SettingRow } from "./SettingRow";
import { SelectButton, Switch } from "./SettingControls";

/** 设备在线状态的轮询间隔：没有推送通道，3 秒是「刚连上 / 刚断开」不让人等太久的上限 */
const DEVICE_POLL_MS = 3_000;

type Load<T> = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; value: T };

export function MobileSettingsPage() {
  const t = useT();
  const copy = t.settings.mobile;
  const [settings, setSettings] = useState<Load<MobileSettings>>({ kind: "loading" });
  const [devices, setDevices] = useState<Load<MobileDevice[]>>({ kind: "loading" });
  /** 正在改开关 / 地址：控件先锁住，主进程回了真状态再放开 */
  const [busy, setBusy] = useState<"enable" | "bind" | null>(null);
  /** 改开关 / 地址时 IPC 本身抛的错（主进程校验不过等）；监听失败的原因在 settings.message 里 */
  const [actionError, setActionError] = useState<string | null>(null);

  const loadSettings = () =>
    api.mobile
      .get()
      .then((value) => setSettings({ kind: "ready", value }))
      .catch((cause: unknown) => setSettings({ kind: "error", message: ipcErrorText(cause) }));
  const loadDevices = () =>
    api.mobile
      .devices()
      .then((value) => setDevices({ kind: "ready", value }))
      .catch((cause: unknown) => setDevices({ kind: "error", message: ipcErrorText(cause) }));

  useEffect(() => {
    void loadSettings();
    void loadDevices();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void loadDevices();
      void loadSettings();
    }, DEVICE_POLL_MS);
    return () => window.clearInterval(timer);
  }, []);

  const apply = (kind: "enable" | "bind", call: () => Promise<MobileSettings>) => {
    setBusy(kind);
    setActionError(null);
    void call()
      .then((value) => setSettings({ kind: "ready", value }))
      .catch((cause: unknown) => setActionError(ipcErrorText(cause)))
      .finally(() => setBusy(null));
  };

  if (settings.kind === "loading") {
    return (
      <div className="set-page">
        <PanelEmpty busy className="mobile-page-empty">
          {copy.loading}
        </PanelEmpty>
      </div>
    );
  }
  if (settings.kind === "error") {
    // IPC 的原文（通道名之类）不进正文，悬停才看得到（设计审查 M7）
    return (
      <div className="set-page">
        <PanelEmpty
          tone="danger"
          className="mobile-page-empty"
          title={settings.message}
          exit={{ label: t.common.retry, onClick: () => void loadSettings() }}
        >
          {copy.loadFailed}
        </PanelEmpty>
      </div>
    );
  }

  const state = settings.value;
  const view = bindView(state);
  /** 此刻手机连得进来：开着、真在监听、地址还在本机上。生成配对码只在这时有意义 */
  const canPair = state.enabled && state.listening && view?.missing !== true;
  const deviceList = devices.kind === "ready" ? devices.value : [];
  const hostKeyLost = state.hostKeyNotice !== null;
  return (
    <div className="set-page">
      <SettingGroup label={copy.connectGroup}>
        <SettingRow
          name={copy.enable}
          info={copy.enableInfo}
          note={
            <ListenStatus
              settings={state}
              busy={busy === "enable"}
              actionError={actionError}
              onRetry={() => apply("enable", () => api.mobile.setEnabled(true))}
            />
          }
        >
          <Switch
            label={copy.enable}
            checked={state.enabled}
            disabled={busy !== null}
            onChange={(next) => apply("enable", () => api.mobile.setEnabled(next))}
          />
        </SettingRow>
        {/* 关着也能先选地址：开关一开就监听在选好的那张网卡上，不先落到默认的第一个候选上 */}
        <AddressRow
          settings={state}
          busy={busy !== null}
          onBind={(address, port) => apply("bind", () => api.mobile.setBind({ address, port }))}
        />
      </SettingGroup>
      <SettingGroup label={copy.pairGroup}>
        <PairRow
          canPair={canPair}
          // 开关关着、也没有出错：是用户自己关的，叫他先打开；出过错（开关被主进程关回去）就指向上面的原因（设计审查 M4）
          needsOn={!state.enabled && state.message === null && actionError === null}
          deviceIds={devices.kind === "ready" ? new Set(deviceList.map((device) => device.id)) : null}
          devices={deviceList}
          onRefresh={() => void loadDevices()}
        />
      </SettingGroup>
      <SettingGroup label={copy.devicesGroup}>
        <SettingRow
          name={copy.devices}
          info={copy.devicesInfo}
          note={
            // 主机密钥丢过：设备被清空的说明是设备说明下面的一行静默告示（设计审查 S12、M6）
            hostKeyLost ? (
              <span className="set-row-note mobile-reason" role="status">
                <Icon name="triangle-alert" size={12} strokeWidth={1.8} />
                <span>{copy.hostKeyLost}</span>
              </span>
            ) : undefined
          }
        >
          {devices.kind === "ready" && devices.value.length > 0 && (
            <span className="set-row-hint mobile-count">{copy.devicesCount(devices.value.length)}</span>
          )}
        </SettingRow>
        {devices.kind === "loading" ? (
          <PanelEmpty busy className="mobile-list-empty">
            {t.common.loading}
          </PanelEmpty>
        ) : devices.kind === "error" ? (
          <PanelEmpty
            tone="danger"
            className="mobile-list-empty"
            title={devices.message}
            exit={{ label: t.common.retry, onClick: () => void loadDevices() }}
          >
            {copy.devicesFailed}
          </PanelEmpty>
        ) : devices.value.length === 0 ? (
          // 告示已经说了「之前的都移除了、要重新配对」，再写「还没有配对过」就成了相反的事实（设计审查 M3）
          hostKeyLost ? null : (
            <PanelEmpty icon={FEATURE_ICON.mobile} className="mobile-list-empty">
              {copy.devicesEmpty}
              {/* 配不了（开关关着、出错）时「生成配对码」按钮是灰的，不叫人去点它（设计审查 N2）；中文句号后不再补空格 */}
              {canPair && <span className="panel-empty-hint">{copy.devicesEmptyHint}</span>}
            </PanelEmpty>
          )
        ) : (
          <DeviceList devices={devices.value} onChanged={(value) => setDevices({ kind: "ready", value })} />
        )}
      </SettingGroup>
    </div>
  );
}

/**
 * 开关下面那一行：在开 → 已开启（手机连得进来）→ 没能开的原因（主进程原话，红）。
 * 只说状态、不带地址：完整地址只在配对码那一块里给，那才是要抄去手机的地方（设计审查 S3）。
 */
function ListenStatus(props: { settings: MobileSettings; busy: boolean; actionError: string | null; onRetry: () => void }) {
  const copy = useT().settings.mobile;
  const { settings } = props;
  if (props.busy) {
    return (
      <span className="set-row-hint">
        <Icon name="loader-circle" size={12} spin /> {copy.starting}
      </span>
    );
  }
  const reason = props.actionError ?? settings.message;
  // 地址不在本机的那句由地址行说（它离「换一个地址」更近），这里不重复
  const missing = bindView(settings)?.missing === true;
  if (reason !== null && !(missing && settings.enabled)) {
    // 开关因为出错被主进程关回去了（例如钥匙串不可用）：句尾给一个出口（设计审查 S13）
    const refused = !settings.enabled && settings.message !== null;
    return (
      <span className="set-row-error mobile-reason" role="alert">
        <Icon name="triangle-alert" size={12} strokeWidth={1.8} />
        <span>
          {reason}
          {refused && (
            <>
              {" "}
              <button type="button" className="notice-exit" onClick={props.onRetry}>
                {copy.retryEnable}
              </button>
            </>
          )}
        </span>
      </span>
    );
  }
  if (!settings.enabled || missing) return null;
  if (settings.listening) {
    return (
      <span className="set-row-note" role="status">
        <Icon name="circle-check" size={12} strokeWidth={1.8} />
        <span>{copy.ready}</span>
      </span>
    );
  }
  return <span className="set-row-hint">{copy.notReady}</span>;
}

/**
 * 地址与端口：地址从主进程现算的候选里选（Tailscale → 局域网 → 回环，主进程排好序）；
 * 端口是个窄输入框，回车或离开时才提交。选局域网地址写明谁都连得到这个端口；地址此刻不在本机
 * 如实说、留在原地址上，等用户自己换。
 */
function AddressRow(props: { settings: MobileSettings; busy: boolean; onBind: (address: string, port: number) => void }) {
  const t = useT();
  const copy = t.settings.mobile;
  const view = bindView(props.settings);
  const [portText, setPortText] = useState(String(view?.port ?? MOBILE_DEFAULT_PORT));
  const [portInvalid, setPortInvalid] = useState(false);
  // 主进程回来的端口变了（别处改的、或提交成功）：输入框跟上
  const committedPort = view?.port ?? null;
  useEffect(() => {
    if (committedPort !== null) setPortText(String(committedPort));
  }, [committedPort]);

  const { candidates } = props.settings;
  // IP 用等宽、与触发钮里同一种写法；网卡名只在同类地址不止一个、需要区分时才写（设计审查 S5）
  const items: MenuItem[] = candidates.map((candidate) => ({
    id: candidate.address,
    label: candidate.address,
    labelMono: true,
    // 菜单里不一定写网卡名，但按网卡名、类别照样搜得到
    searchText: `${copy.kind[candidate.kind]} ${candidate.interfaceName}`,
    hint: needsInterfaceName(candidate, candidates)
      ? `${copy.kind[candidate.kind]} · ${candidate.interfaceName}`
      : copy.kind[candidate.kind],
    checked: candidate.address === view?.address,
    onSelect: () => props.onBind(candidate.address, parsePortInput(portText) ?? view?.port ?? MOBILE_DEFAULT_PORT),
  }));

  const commitPort = () => {
    const port = parsePortInput(portText);
    if (port === null) {
      setPortInvalid(true);
      return;
    }
    setPortInvalid(false);
    if (view !== null && port !== view.port) props.onBind(view.address, port);
  };

  const note =
    view === null ? (
      candidates.length === 0 ? (
        <span className="set-row-error" role="alert">
          {copy.noCandidates}
        </span>
      ) : undefined
    ) : view.missing ? (
      <span className="set-row-error mobile-reason" role="alert">
        <Icon name="triangle-alert" size={12} strokeWidth={1.8} />
        <span>{copy.addressMissing(view.address)}</span>
      </span>
    ) : view.kind === "private" ? (
      <span className="set-row-note mobile-reason" role="status">
        <Icon name="triangle-alert" size={12} strokeWidth={1.8} />
        <span>{copy.lanWarning}</span>
      </span>
    ) : view.kind === "loopback" ? (
      <span className="set-row-hint">{copy.loopbackNote}</span>
    ) : undefined;

  return (
    <SettingRow
      name={copy.address}
      info={copy.addressInfo}
      note={
        <>
          {note}
          {portInvalid && (
            <span className="set-row-error" role="alert">
              {copy.portInvalid}
            </span>
          )}
        </>
      }
    >
      <span className="set-inline mobile-bind">
        <Menu
          items={items}
          searchable={items.length > 8}
          searchPlaceholder={copy.addressSearch}
          trigger={({ open, toggle }) => (
            <SelectButton open={open} onClick={toggle} title={copy.addressPick} disabled={props.busy || items.length === 0}>
              {view === null ? (
                copy.addressPick
              ) : (
                <>
                  <span className="mobile-mono">{view.address}</span>
                  {view.kind !== null && <span className="mobile-bind-kind"> · {copy.kind[view.kind]}</span>}
                </>
              )}
            </SelectButton>
          )}
        />
        <span className="mobile-port-sep" aria-hidden="true">
          :
        </span>
        <input
          className="text-field mobile-port"
          inputMode="numeric"
          aria-label={copy.port}
          title={copy.port}
          value={portText}
          disabled={props.busy}
          aria-invalid={portInvalid}
          onChange={(event) => {
            setPortText(event.target.value);
            setPortInvalid(false);
          }}
          onBlur={commitPort}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitPort();
            if (event.key === "Escape" && view !== null) {
              setPortText(String(view.port));
              setPortInvalid(false);
            }
          }}
        />
      </span>
    </SettingRow>
  );
}

/**
 * 配对：一个主按钮「生成配对码」；有码时行底铺开一块——码、倒计时、地址，「换一个码」「收起」。
 * 过期了就收起这一块、回到行尾的「生成配对码」，行内写一句「上一个码已过期」（设计审查 S10、S11）。
 * 有码期间冒出新设备 = 配上了：收起码，写一句「已配上」——只在那台设备还在清单里时写（设计审查 M1）。
 * 离开这一页（卸载）时作废还在有效期里的码。
 */
function PairRow(props: {
  /** 此刻手机连得进来（开着、在监听、地址在本机） */
  canPair: boolean;
  /** 连不进来是因为用户自己关了开关（不是出错） */
  needsOn: boolean;
  /** 设备列表还没读到时是 null（那时不判断「配上了」） */
  deviceIds: ReadonlySet<string> | null;
  devices: readonly MobileDevice[];
  /** 生成码之后拉一次设备列表，把「生成前已有的设备」钉准 */
  onRefresh: () => void;
}) {
  const t = useT();
  const copy = t.settings.mobile;
  const [offer, setOffer] = useState<MobileOffer | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairedId, setPairedId] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  /** 生成这组码时已有的设备：之后多出来的就是用这组码配上的 */
  const baseline = useRef<ReadonlySet<string> | null>(null);
  const live = useRef<MobileOffer | null>(null);
  live.current = offer;

  // 有码时每秒走一次倒计时
  useEffect(() => {
    if (offer === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [offer]);

  // 离开这一页：还在有效期里的码作废
  useEffect(
    () => () => {
      const current = live.current;
      if (current !== null && current.expiresAt > Date.now()) void api.mobile.offerCancel().catch(() => undefined);
    },
    [],
  );

  // 连不进来了（关了开关 / 地址掉了）：主进程已作废配对簿，码收起
  useEffect(() => {
    if (!props.canPair) setOffer(null);
  }, [props.canPair]);

  // 有码期间冒出新设备：配上了
  useEffect(() => {
    if (offer === null || baseline.current === null) return;
    const paired = newlyPaired(baseline.current, props.devices);
    if (paired !== null) {
      setPairedId(paired.id);
      setOffer(null);
    }
  }, [props.devices, offer]);

  const secondsLeft = offer === null ? 0 : offerSecondsLeft(offer.expiresAt, now);
  // 码过期：整块收起，行尾回到「生成配对码」
  useEffect(() => {
    if (offer !== null && secondsLeft === 0) {
      setOffer(null);
      setExpired(true);
    }
  }, [offer, secondsLeft]);

  const create = () => {
    setCreating(true);
    setError(null);
    setPairedId(null);
    setExpired(false);
    baseline.current = props.deviceIds;
    void api.mobile
      .offerCreate()
      .then((next) => {
        setOffer(next);
        props.onRefresh();
      })
      .catch((cause: unknown) => setError(ipcErrorText(cause)))
      .finally(() => setCreating(false));
  };
  const close = () => {
    setOffer(null);
    void api.mobile.offerCancel().catch(() => undefined);
  };

  // 配上的那台被移除了，「已配上」就不再是真话
  const paired = pairedId === null ? undefined : props.devices.find((device) => device.id === pairedId);
  const blockedText = props.needsOn ? copy.pairNeedsOn : copy.pairBlocked;
  const note =
    error !== null ? (
      <span className="set-row-error mobile-reason" role="alert">
        <Icon name="triangle-alert" size={12} strokeWidth={1.8} />
        <span>{copy.pairFailed(error)}</span>
      </span>
    ) : paired !== undefined ? (
      <span className="set-row-note" role="status">
        <Icon name="circle-check" size={12} strokeWidth={1.8} />
        <span className="mobile-ellipsis">{copy.pairDone(paired.name)}</span>
      </span>
    ) : !props.canPair ? (
      <span className="set-row-hint">{blockedText}</span>
    ) : expired && offer === null ? (
      <span className="set-row-hint">{copy.pairExpiredNote}</span>
    ) : undefined;

  return (
    <SettingRow
      name={copy.pair}
      info={copy.pairInfo}
      note={note}
      below={
        offer !== null && (
          <div className="mobile-offer" aria-live="polite">
            <div className="mobile-offer-main">
              <span className="mobile-offer-label">{copy.pairCode}</span>
              <span className="mobile-offer-code" aria-label={copy.pairCode}>
                {groupPairingCode(offer.code)}
              </span>
              <span className="mobile-offer-meta">
                <span>{copy.pairExpiresIn(formatCountdown(secondsLeft))}</span>
                <span>
                  {copy.pairAddress} <span className="mobile-mono">{`${offer.address}:${offer.port}`}</span>
                </span>
              </span>
            </div>
            {/* 卡里只用文字钮：卡已经是 muted 底，再叠描边钮就是一个容器两种语言（设计审查 S9） */}
            <div className="mobile-offer-acts">
              <button type="button" className="mg-textbtn" disabled={creating} onClick={create}>
                {creating ? copy.pairCreating : copy.pairRenew}
              </button>
              <button type="button" className="mg-textbtn" onClick={close}>
                {copy.pairClose}
              </button>
            </div>
          </div>
        )
      }
    >
      {offer === null && (
        <button
          type="button"
          className="pl-btn btn-accent"
          disabled={!props.canPair || creating}
          title={props.canPair ? undefined : blockedText}
          onClick={create}
        >
          {creating ? copy.pairCreating : copy.pairCreate}
        </button>
      )}
    </SettingRow>
  );
}

/**
 * 已配对设备：一行一台，在线的在前。行尾平时不放动作（八台设备不竖出一列「移除…」），悬停或键盘聚焦到这一行
 * 时「移除…」浮到行尾（设计审查 S1）；很久没用的设备整行退成三级灰，行尾写「很久没用了」，动作浮上来时它让位（S2）。
 * 「移除…」就地换成红底确认条（插件详情「卸载…」同一套），后果写在确认条里、按钮之前（S7）。
 */
function DeviceList(props: { devices: readonly MobileDevice[]; onChanged: (devices: MobileDevice[]) => void }) {
  const t = useT();
  const copy = t.settings.mobile;
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keepRef = useRef<HTMLButtonElement | null>(null);
  const now = Date.now();

  useEffect(() => {
    if (confirming !== null) keepRef.current?.focus();
  }, [confirming]);

  const remove = (device: MobileDevice) => {
    setRemoving(true);
    setError(null);
    void api.mobile
      .revoke(device.id)
      .then((next) => props.onChanged(next))
      .catch((cause: unknown) => setError(copy.removeFailed(ipcErrorText(cause))))
      .finally(() => {
        setRemoving(false);
        setConfirming(null);
      });
  };

  return (
    <div className="mobile-devices-wrap">
      {error !== null && (
        <span className="set-row-error mobile-reason" role="alert">
          <Icon name="triangle-alert" size={12} strokeWidth={1.8} />
          <span>{error}</span>
        </span>
      )}
      <ul className="mobile-devices" aria-label={copy.devices}>
        {sortDevices(props.devices).map((device) => {
          const stale = isStaleDevice(device, now);
          const status = device.connected
            ? copy.online
            : device.lastSeenAt !== null
              ? copy.lastSeen(relativeTime(device.lastSeenAt, t))
              : copy.neverSeen;
          return (
            <li
              key={device.id}
              className="mobile-device"
              data-online={device.connected ? "" : undefined}
              data-stale={stale ? "" : undefined}
            >
              {confirming === device.id ? (
                <div
                  className="pl-ic mobile-device-confirm"
                  role="alertdialog"
                  aria-label={copy.removeAsk(device.name)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      setConfirming(null);
                    }
                  }}
                >
                  <div className="pl-ic-bar">
                    <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
                    <span className="pl-ic-ask mobile-confirm-text">
                      <span className="mobile-confirm-ask">{copy.removeAsk(device.name)}</span>
                      <span className="mobile-confirm-hint">{copy.removeHint}</span>
                    </span>
                    <button type="button" className="pl-btn solid-danger" disabled={removing} onClick={() => remove(device)}>
                      {removing ? copy.removing : copy.removeAction}
                    </button>
                    <button type="button" className="pl-btn" ref={keepRef} disabled={removing} onClick={() => setConfirming(null)}>
                      {copy.removeKeep}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <Icon name={FEATURE_ICON.mobile} size={14} strokeWidth={1.8} className="mobile-device-glyph" />
                  <span className="mobile-device-head">
                    <span className="mobile-device-name" title={device.name}>
                      {device.name}
                    </span>
                    <span className="mobile-device-meta">
                      <span className="mobile-device-status">{status}</span>
                      {" · "}
                      {copy.pairedOn(formatDay(device.pairedAt, now))}
                    </span>
                  </span>
                  {stale && <span className="row-trailing mobile-device-stale">{copy.stale}</span>}
                  <button
                    type="button"
                    className="mg-textbtn mobile-device-remove"
                    disabled={confirming !== null}
                    onClick={() => {
                      setError(null);
                      setConfirming(device.id);
                    }}
                  >
                    {copy.remove}
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
