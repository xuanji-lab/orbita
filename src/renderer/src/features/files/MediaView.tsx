import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Icon } from "../../shell/Icon";
import { IconButton } from "../../shell/IconButton";
import { PanelButton, PanelLine } from "../../shell/RightPanel";
import { api } from "../../api";
import { useT } from "../../locale.ts";
import type { FileListRequest, FileMediaUrl, MediaKind } from "@shared/files";
import { formatSize } from "./tree-view";
import { EmptyPreview } from "./PreviewChrome";
import {
  SEEK_STEP_SECONDS,
  formatClock,
  formatLabel,
  formatRate,
  fractionAtPointer,
  isKnownDuration,
  mediaKeyAction,
  nextRate,
  progressFraction,
  seekTarget,
} from "./media-view.ts";

type UrlState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; media: FileMediaUrl };

const failMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * 文件面板里的音 / 视频播放（FilePreviewPane 按扩展名分派到这里）。
 *
 * 数据半边：不读字节，向主进程要一个 `orbita-media://` 播放地址（fs:media-url，与 fs:read 同一道白名单），
 * 元素按 Range 流式读——大文件不过 IPC、视频拖得动进度。要地址失败（会话范围外、文件没了）与元素解不出码
 * 都落在同一个错误态：一句说明 + 「用默认应用打开」。
 */
export function MediaView(props: {
  request: FileListRequest;
  name: string;
  kind: MediaKind;
  /** 「刷新」计数器：头上的刷新键重取地址 */
  reloadToken: number;
  onOpenDefault: () => void;
}) {
  const t = useT();
  const { request } = props;
  const [state, setState] = useState<UrlState>({ status: "loading" });
  const [playFailed, setPlayFailed] = useState(false);
  const requestRef = useRef(0);

  useEffect(() => {
    const id = ++requestRef.current;
    setState({ status: "loading" });
    setPlayFailed(false);
    api.files
      .mediaUrl(request)
      .then((media) => {
        if (requestRef.current === id) setState({ status: "ready", media });
      })
      .catch((cause: unknown) => {
        if (requestRef.current === id) setState({ status: "error", message: failMessage(cause) });
      });
  }, [request.sessionId, request.workspaceId, request.extraWorkspaceId, request.root, request.dir, props.reloadToken]);

  if (state.status === "loading") {
    return (
      <div className="file-preview-loading">
        <Icon name="loader-circle" size={14} spin />
        {t.common.loading}
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="file-preview-empty">
        <Icon name={props.kind === "video" ? "file-video-2" : "file-audio-2"} size={24} style={{ color: "var(--color-text-tertiary)" }} />
        <PanelLine danger>{state.message}</PanelLine>
        <PanelButton onClick={props.onOpenDefault}>
          <Icon name="external-link" size={14} />
          {t.files.openDefault}
        </PanelButton>
      </div>
    );
  }
  if (playFailed) return <EmptyPreview message={t.files.mediaCantPlay} onOpenDefault={props.onOpenDefault} />;
  return (
    <MediaPlayer
      key={state.media.url}
      src={state.media.url}
      kind={state.media.kind}
      name={props.name}
      size={state.media.size}
      onFail={() => setPlayFailed(true)}
    />
  );
}

/**
 * 播放器本体：自绘控制条（不用原生 controls——风格与设计系统不搭），元素只管出声 / 出画。
 * 控制条一行：播放 / 暂停 · 当前时间 · 可拖进度条 · 总时长 · （音频）倍速 · （视频）全屏。
 * 键盘：空格播放 / 暂停，← / → 跳 5 秒（焦点在播放器内任何位置都生效，打开时焦点就落在播放器上）。
 * 不自动播放：用户点开一个文件是要看它，不是要它出声。
 */
function MediaPlayer(props: { src: string; kind: MediaKind; name: string; size: number; onFail: () => void }) {
  const t = useT();
  const { kind } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  /** 拖进度条时的预览位置（比例）；null = 没在拖 */
  const [scrub, setScrub] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const onFailRef = useRef(props.onFail);
  onFailRef.current = props.onFail;

  const known = isKnownDuration(duration);
  const shownTime = scrub !== null && known ? scrub * duration : current;
  const fraction = scrub !== null ? scrub : progressFraction(current, duration);

  // 元素事件 → 状态。进度条要平滑，播放中用 rAF 读 currentTime（timeupdate 约 4 Hz，条会一格一格跳）
  useEffect(() => {
    const el = mediaRef.current;
    if (el === null) return undefined;
    const syncDuration = (): void => setDuration(el.duration);
    const onPlay = (): void => setPlaying(true);
    const onPause = (): void => setPlaying(false);
    const onTime = (): void => setCurrent(el.currentTime);
    const onError = (): void => onFailRef.current();
    // 清理时会 removeAttribute("src")；严格模式 / 重挂载会再跑一遍 setup，这里把 src 补回去
    if (el.getAttribute("src") !== props.src) el.src = props.src;
    el.addEventListener("loadedmetadata", syncDuration);
    el.addEventListener("durationchange", syncDuration);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onPause);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("seeked", onTime);
    el.addEventListener("error", onError);
    syncDuration();
    return () => {
      el.removeEventListener("loadedmetadata", syncDuration);
      el.removeEventListener("durationchange", syncDuration);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onPause);
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("seeked", onTime);
      el.removeEventListener("error", onError);
      // 关面板 / 换文件：停掉并放掉流，在途的 Range 请求随之取消
      el.pause();
      el.removeAttribute("src");
      el.load();
    };
  }, [props.src]);

  useEffect(() => {
    if (!playing || scrub !== null) return undefined;
    let frame = 0;
    const tick = (): void => {
      const el = mediaRef.current;
      if (el !== null) setCurrent(el.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, scrub]);

  useEffect(() => {
    const onChange = (): void => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // 打开即把焦点放在播放器上，空格 / 方向键立刻可用
  useEffect(() => rootRef.current?.focus({ preventScroll: true }), []);

  const toggle = (): void => {
    const el = mediaRef.current;
    if (el === null) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  };
  const seekBy = (delta: number): void => {
    const el = mediaRef.current;
    if (el === null) return;
    el.currentTime = seekTarget(el.currentTime, delta, el.duration);
    setCurrent(el.currentTime);
  };
  const cycleRate = (): void => {
    const next = nextRate(rate);
    setRate(next);
    if (mediaRef.current !== null) mediaRef.current.playbackRate = next;
  };
  const toggleFullscreen = (): void => {
    const root = rootRef.current;
    if (root === null) return;
    if (document.fullscreenElement === root) void document.exitFullscreen().catch(() => undefined);
    else void root.requestFullscreen().catch(() => undefined);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const action = mediaKeyAction({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      targetTag: (event.target as HTMLElement).tagName,
    });
    if (action === null) return;
    event.preventDefault();
    if (action === "toggle") toggle();
    else seekBy(action === "back" ? -SEEK_STEP_SECONDS : SEEK_STEP_SECONDS);
  };

  const pointerFraction = (event: PointerEvent<HTMLDivElement>): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    return rect === undefined ? 0 : fractionAtPointer(event.clientX, rect.left, rect.width);
  };
  const onSeekDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (!known || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setScrub(pointerFraction(event));
  };
  const onSeekMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (scrub !== null) setScrub(pointerFraction(event));
  };
  const onSeekUp = (event: PointerEvent<HTMLDivElement>): void => {
    if (scrub === null) return;
    const target = pointerFraction(event) * duration;
    setScrub(null);
    const el = mediaRef.current;
    if (el !== null) el.currentTime = target;
    setCurrent(target);
  };

  const controls = (
    <div className="media-controls">
      <button
        type="button"
        className="media-play"
        aria-label={playing ? t.files.mediaPause : t.files.mediaPlay}
        title={playing ? t.files.mediaPause : t.files.mediaPlay}
        onClick={toggle}
      >
        <Icon name={playing ? "pause" : "play"} size={16} strokeWidth={2} />
      </button>
      <span className="media-time" data-side="current">
        {formatClock(shownTime)}
      </span>
      <div
        className="media-seek"
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={t.files.mediaSeek}
        aria-valuemin={0}
        aria-valuemax={known ? Math.floor(duration) : 0}
        aria-valuenow={Math.floor(shownTime)}
        aria-valuetext={`${formatClock(shownTime)} / ${formatClock(duration)}`}
        aria-disabled={!known}
        data-dragging={scrub !== null ? "true" : undefined}
        onPointerDown={onSeekDown}
        onPointerMove={onSeekMove}
        onPointerUp={onSeekUp}
        onPointerCancel={() => setScrub(null)}
      >
        <div className="media-seek-track">
          <div className="media-seek-fill" style={{ width: `${fraction * 100}%` }} />
        </div>
        <div className="media-seek-thumb" style={{ left: `${fraction * 100}%` }} />
      </div>
      <span className="media-time" data-side="total">
        {known ? formatClock(duration) : "--:--"}
      </span>
      {kind === "audio" && (
        <button
          type="button"
          className="media-rate"
          aria-label={t.files.mediaSpeed(formatRate(rate))}
          title={t.files.mediaSpeed(formatRate(rate))}
          onClick={cycleRate}
        >
          {formatRate(rate)}
        </button>
      )}
      {kind === "video" && (
        <IconButton
          label={fullscreen ? t.files.mediaExitFullscreen : t.files.mediaFullscreen}
          size={28}
          onClick={toggleFullscreen}
        >
          <Icon name={fullscreen ? "minimize-2" : "expand"} size={16} strokeWidth={1.8} />
        </IconButton>
      )}
    </div>
  );

  return (
    <div className="media-player" data-kind={kind} data-fullscreen={fullscreen ? "true" : undefined} ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown}>
      {kind === "video" ? (
        <>
          <div className="media-stage">
            <video
              className="media-video"
              ref={(el) => {
                mediaRef.current = el;
              }}
              src={props.src}
              preload="metadata"
              playsInline
              onClick={toggle}
            />
          </div>
          {controls}
        </>
      ) : (
        <div className="media-audio-body">
          <audio
            ref={(el) => {
              mediaRef.current = el;
            }}
            src={props.src}
            preload="metadata"
          />
          <div className="media-audio-tile">
            <Icon name="file-audio-2" size={24} strokeWidth={1.6} />
          </div>
          <div className="media-audio-name" title={props.name}>
            {props.name}
          </div>
          <div className="media-audio-meta">
            {[formatLabel(props.name), known ? formatClock(duration) : "", formatSize(props.size)]
              .filter((part) => part !== "")
              .join(" · ")}
          </div>
          {controls}
        </div>
      )}
    </div>
  );
}
