import { useEffect, useMemo, useState } from "react";
import { BackHandler, FlatList, KeyboardAvoidingView, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SessionSummary, TailEntry } from "../../../src/shared/mobile.ts";
import { MOBILE_LIMITS } from "../../../src/shared/mobile.ts";
import { copy } from "../copy.ts";
import { visibleReplies, type PendingReply } from "../model/chat.ts";
import { clockOf } from "../model/time.ts";
import type { AppController, AppState } from "../store/controller.ts";
import { fontSize, lineHeight, MONO, radius, space, TOUCH, weight, type Theme } from "../theme/theme.ts";
import { isStale } from "./HostBar.tsx";
import { Icon } from "./Icon.tsx";
import { PanelEmpty, Spinner } from "./PanelEmpty.tsx";
import { StatusPie } from "./StatusPie.tsx";

/**
 * 对话页（照设计稿 android-chat-*）：壳上的顶栏（返回 · 标题 / 状态 · 工作区 · 在跑时右侧一颗独立的
 * 停止键），下面是顶部圆角的纸面井：尾部若干条（打开就停在最后一条，往上翻有「载入更早的」），
 * 井底是输入台——等你时一句提示、排队的那句灰条、输入框和发送键。
 *
 * 停止键放顶栏、不放输入框旁边（2026-11-25 用户拍板「单独放一颗停止键」）：停止和发送是两件相反的事，
 * 离开拇指常落的发送键就不会误停；键盘弹起时顶栏也还在。只有图标是红的，不铺底；断线时退灰、不能点。
 * 发送键只管发送，有字才亮（accent）。文字一律按纯文本渲染，不自动识别链接。
 */
export function ChatScreen(props: { theme: Theme; state: AppState; controller: AppController; initialDraft: string }) {
  const { theme, state, controller } = props;
  const { color } = theme;
  const insets = useSafeAreaInsets();
  const id = state.openId;
  const session: SessionSummary | undefined = id === null ? undefined : state.sessions.get(id);
  const slot = id === null ? undefined : state.chats.get(id);
  const stale = isStale(state);
  const [draft, setDraft] = useState(props.initialDraft);
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      controller.closeSession();
      return true;
    });
    return () => sub.remove();
  }, [controller]);
  // 倒过来的列表：最新一条在底部、打开就停在那里；往上翻到头是「载入更早的」
  const entries = useMemo(() => [...(slot?.tail?.entries ?? [])].reverse(), [slot?.tail]);
  if (session === undefined || id === null) return null;
  // 未读清掉后电脑会把它推成空闲：顶栏仍写打开时的「跑完了 / 出错」（清单那边离组，这里照设计稿留着饼）
  const shownState = session.state === "idle" && (state.openedState === "done" || state.openedState === "failed") ? state.openedState : session.state;
  const running = session.state === "running";
  const pie = shownState === "idle" ? null : shownState;
  const loading = slot === undefined || slot.loading;
  const replies = visibleReplies(state.replies, id);
  const sendable = draft.trim() !== "" && !stale && !loading;
  const placeholder = stale ? copy.chat.placeholderOffline : running ? copy.chat.placeholderRunning : copy.chat.placeholder;
  const send = () => {
    if (!sendable) return;
    const text = draft;
    setDraft("");
    void controller.sendReply(text).then((sent) => {
      if (!sent) setDraft(text);
    });
  };
  const stateWord = copy.chat.state[shownState];
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: color.bgApp }} behavior="height">
      <View style={[styles.bar, { paddingTop: insets.top }]}>
        <Pressable onPress={() => controller.closeSession()} accessibilityRole="button" accessibilityLabel={copy.chat.back} style={styles.touch}>
          <Icon name="chevron-left" size={16} color={color.textSecondary} />
        </Pressable>
        <View style={styles.barMain}>
          <Text numberOfLines={1} style={[styles.barTitle, { color: color.textPrimary }]}>
            {session.title}
          </Text>
          <View style={styles.barSub}>
            {pie !== null && <StatusPie theme={theme} state={pie} stale={stale} />}
            <Text numberOfLines={1} style={[styles.barSubText, { color: color.textTertiary }]}>
              {stale ? `${stateWord} · ${copy.chat.beforeDisconnect}` : stateWord}
              {session.workspaceName !== null ? ` · ${session.workspaceName}` : ""}
            </Text>
          </View>
        </View>
        {running && !loading && (
          <Pressable
            onPress={() => void controller.stop()}
            disabled={stale}
            accessibilityRole="button"
            accessibilityLabel={copy.chat.stop}
            accessibilityState={{ disabled: stale }}
            style={({ pressed }) => [styles.touch, pressed && { backgroundColor: color.bgHover, borderRadius: radius.pill }]}
          >
            <Icon name="circle-stop" size={16} color={stale ? color.textTertiary : color.danger} />
          </Pressable>
        )}
      </View>
      <View style={[styles.well, { backgroundColor: color.bgPanel }]}>
        {stale && (
          <View style={[styles.notice, { borderBottomColor: color.borderSubtle }]}>
            <PanelEmpty theme={theme} icon="wifi-off" hint={copy.chat.reconnectingHint} exit={{ label: copy.chat.retry, onPress: () => controller.retry() }}>
              {copy.chat.reconnecting}
            </PanelEmpty>
          </View>
        )}
        {loading ? (
          <View style={styles.transcriptPad}>
            <PanelEmpty theme={theme} busy>
              {copy.chat.loading}
            </PanelEmpty>
          </View>
        ) : slot.failed ? (
          <View style={styles.transcriptPad}>
            <PanelEmpty theme={theme} tone="danger" icon="triangle-alert" exit={{ label: copy.chat.retry, onPress: () => controller.retry() }}>
              {copy.chat.loadFailed}
            </PanelEmpty>
          </View>
        ) : (
          <FlatList
            inverted
            data={entries}
            keyExtractor={(entry) => entry.id}
            renderItem={({ item }) => <Entry theme={theme} entry={item} />}
            contentContainerStyle={styles.transcript}
            ItemSeparatorComponent={Gap}
            ListFooterComponent={
              slot.tail?.hasMore ? (
                <View style={styles.earlier}>
                  {slot.loadingOlder ? (
                    <PanelEmpty theme={theme} busy>
                      {copy.chat.loadEarlier}
                    </PanelEmpty>
                  ) : (
                    <PanelEmpty theme={theme} icon="history" exit={{ label: copy.chat.loadEarlier, onPress: () => void controller.loadEarlier() }}>
                      {copy.chat.tail(slot.tail.entries.length)}
                    </PanelEmpty>
                  )}
                </View>
              ) : undefined
            }
            ListEmptyComponent={
              <PanelEmpty theme={theme} icon="message-square">
                {copy.chat.empty}
              </PanelEmpty>
            }
          />
        )}
        <View style={[styles.ledge, { paddingBottom: insets.bottom + space.s2 }]}>
          {session.state === "waiting" && !loading && (
            <View style={styles.hint}>
              <Icon name="list-todo" size={14} color={color.textTertiary} />
              <Text style={[styles.hintText, { color: color.textSecondary }]}>{copy.chat.planWaiting}</Text>
            </View>
          )}
          {state.stopFailed && (
            <PanelEmpty theme={theme} tone="danger" icon="circle-stop">
              {copy.chat.stopFailed}
            </PanelEmpty>
          )}
          {replies.map((reply) => (
            <QueueBar key={reply.requestId} theme={theme} reply={reply} onDismiss={() => controller.dismissReply(reply.requestId)} />
          ))}
          <View style={[styles.composer, { backgroundColor: color.glassBg, borderColor: color.glassBorder }]}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={placeholder}
              placeholderTextColor={color.textTertiary}
              multiline
              maxLength={MOBILE_LIMITS.replyText}
              editable={!loading}
              dataDetectorTypes="none"
              accessibilityLabel={copy.chat.placeholder}
              style={[styles.input, { color: color.textPrimary }]}
            />
            <Pressable
              onPress={send}
              disabled={!sendable}
              accessibilityRole="button"
              accessibilityLabel={copy.chat.send}
              accessibilityState={{ disabled: !sendable }}
              style={({ pressed }) => [
                styles.send,
                { backgroundColor: sendable ? (pressed ? color.accentStrong : color.accent) : "transparent" },
              ]}
            >
              <Icon name="arrow-up" size={16} color={sendable ? color.accentFg : color.textTertiary} />
            </Pressable>
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function Gap() {
  return <View style={{ height: space.s5 }} />;
}

function Entry(props: { theme: Theme; entry: TailEntry }) {
  const { color } = props.theme;
  const { entry } = props;
  if (entry.kind === "user") {
    const text = [entry.text ?? "", entry.images !== undefined && entry.images > 0 ? copy.chat.images(entry.images) : ""]
      .filter((part) => part !== "")
      .join("\n");
    return (
      <View style={styles.user}>
        <View style={[styles.bubble, { backgroundColor: color.chatCardBg, borderColor: color.borderSubtle }]}>
          <Text selectable style={[styles.prose, { color: color.textPrimary }]}>
            {text}
          </Text>
        </View>
        <Text style={[styles.time, { color: color.textTertiary }]}>{clockOf(entry.at)}</Text>
      </View>
    );
  }
  if (entry.kind === "process") {
    const parts = [copy.chat.steps(entry.steps ?? 0)];
    return (
      <View style={styles.proc}>
        <Text style={[styles.procText, { color: color.textTertiary }]}>
          {parts.join(" · ")}
          {entry.failed !== undefined && entry.failed > 0 && <Text style={{ color: color.danger }}>{` · ${copy.chat.stepsFailed(entry.failed)}`}</Text>}
        </Text>
      </View>
    );
  }
  return (
    <Text selectable style={[styles.prose, { color: color.textPrimary }]}>
      {entry.text ?? ""}
    </Text>
  );
}

/** 排队条：在跑时回的那句，「这一轮跑完后发出」；没发出去变红，点「知道了」收起 */
function QueueBar(props: { theme: Theme; reply: PendingReply; onDismiss: () => void }) {
  const { color } = props.theme;
  const { reply } = props;
  const failed = reply.status === "failed";
  return (
    <View style={[styles.queue, { backgroundColor: failed ? color.dangerSoft : color.bgMuted }]}>
      {reply.status === "sending" ? (
        <Spinner color={color.textTertiary} />
      ) : (
        <Icon name={failed ? "triangle-alert" : "clock"} size={14} color={failed ? color.danger : color.textTertiary} />
      )}
      <Text numberOfLines={1} style={[styles.queueText, { color: failed ? color.danger : color.textSecondary }]}>
        {failed ? copy.chat.replyFailed(reply.error?.message ?? reply.text) : reply.text}
      </Text>
      {failed ? (
        <Pressable onPress={props.onDismiss} hitSlop={12} accessibilityRole="button">
          <Text style={[styles.queueTrail, { color: color.danger, fontWeight: weight.semibold }]}>{copy.chat.dismiss}</Text>
        </Pressable>
      ) : (
        <Text style={[styles.queueTrail, { color: color.textTertiary }]}>{reply.status === "sending" ? copy.chat.sending : copy.chat.queued}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    columnGap: space.s2,
    minHeight: TOUCH + space.s3,
    paddingLeft: space.s1,
    paddingRight: space.s2,
  },
  touch: {
    width: TOUCH,
    height: TOUCH,
    alignItems: "center",
    justifyContent: "center",
  },
  barMain: {
    flex: 1,
    minWidth: 0,
  },
  barTitle: {
    fontSize: fontSize.base,
    lineHeight: lineHeight(fontSize.base),
    fontWeight: weight.semibold,
  },
  barSub: {
    flexDirection: "row",
    alignItems: "center",
    columnGap: space.s1_5,
  },
  barSubText: {
    flexShrink: 1,
    fontSize: fontSize.sm,
    lineHeight: lineHeight(fontSize.sm),
  },
  well: {
    flex: 1,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    overflow: "hidden",
  },
  notice: {
    paddingHorizontal: space.s4,
    paddingVertical: space.s3,
    borderBottomWidth: 1,
  },
  transcriptPad: {
    flex: 1,
    padding: space.s4,
  },
  transcript: {
    paddingHorizontal: space.s4,
    paddingTop: space.s6,
    paddingBottom: space.s4,
  },
  earlier: {
    paddingBottom: space.s5,
  },
  user: {
    alignItems: "flex-end",
    rowGap: space.s1,
  },
  bubble: {
    maxWidth: "85%",
    paddingVertical: space.s2 + 1,
    paddingHorizontal: space.s3,
    borderWidth: 1,
    borderRadius: radius.bubble,
  },
  prose: {
    fontSize: fontSize.base,
    lineHeight: lineHeight(fontSize.base, "reading"),
  },
  time: {
    fontFamily: MONO,
    fontSize: fontSize.xs,
  },
  proc: {
    minHeight: 28,
    justifyContent: "center",
  },
  procText: {
    fontSize: fontSize.sm,
    fontWeight: weight.medium,
  },
  ledge: {
    rowGap: space.s2,
    paddingTop: space.s2,
    paddingHorizontal: space.s3,
  },
  hint: {
    flexDirection: "row",
    columnGap: space.s2,
    paddingHorizontal: space.s1,
  },
  hintText: {
    flex: 1,
    fontSize: fontSize.sm,
    lineHeight: lineHeight(fontSize.sm),
  },
  queue: {
    flexDirection: "row",
    alignItems: "center",
    columnGap: space.s2,
    minHeight: 32,
    paddingHorizontal: space.s3,
    borderRadius: radius.md,
  },
  queueText: {
    flex: 1,
    fontSize: fontSize.sm,
  },
  queueTrail: {
    fontSize: fontSize.sm,
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    columnGap: space.s2,
    paddingVertical: space.s1,
    paddingLeft: space.s3,
    paddingRight: space.s1,
    borderWidth: 1,
    borderRadius: radius.xl,
  },
  input: {
    flex: 1,
    minHeight: TOUCH,
    maxHeight: 6 * lineHeight(fontSize.base),
    paddingVertical: space.s2_5,
    fontSize: fontSize.base,
    lineHeight: lineHeight(fontSize.base),
  },
  send: {
    width: TOUCH,
    height: TOUCH,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
});
