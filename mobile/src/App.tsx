import { useEffect, useState, useSyncExternalStore } from "react";
import { AppState as RNAppState, Linking, LogBox, Platform, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { HostLink } from "./protocol/link.ts";
import { pairWithHost } from "./protocol/pair.ts";
import { rnSocketFactory } from "./protocol/rn-socket.ts";
import { clearCredentials, loadCredentials, saveCredentials } from "./protocol/credentials-store.ts";
import { AppController } from "./store/controller.ts";
import { fixtureController, parseFixtureUrl, type FixtureParams } from "./store/fixture.ts";
import { fontSize, useTheme, type Theme } from "./theme/theme.ts";
import { PairScreen } from "./ui/PairScreen.tsx";
import { Spinner } from "./ui/PanelEmpty.tsx";

/** 配对时报给电脑的名字：厂商 + 型号（电脑的设置页里列已配对设备用） */
function deviceName(): string {
  const constants = Platform.constants as { Manufacturer?: string; Brand?: string; Model?: string };
  const maker = constants.Manufacturer ?? constants.Brand ?? "";
  const model = constants.Model ?? "";
  const name = `${maker} ${model}`.trim();
  return name === "" ? "安卓手机" : name;
}

function productionController(): AppController {
  return new AppController({
    loadCredentials,
    saveCredentials,
    clearCredentials,
    makeTransport: (credentials, callbacks) =>
      new HostLink({
        credentials,
        socketFactory: rnSocketFactory,
        deviceName: null,
        now: Date.now,
        onStatus: callbacks.onStatus,
        onNotification: callbacks.onNotification,
        onOpen: callbacks.onOpen,
        log: (line) => console.log(line),
      }),
    pair: (input) => pairWithHost({ ...input, socketFactory: rnSocketFactory }),
    deviceName: deviceName(),
    now: Date.now,
    log: (line) => console.log(line),
  });
}

export function App() {
  const theme = useTheme();
  const [controller, setController] = useState<AppController | null>(null);
  const [fixture, setFixture] = useState<FixtureParams | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // 样例数据只在开发版里认：发布版的 app 不响应 orbita-mobile://fixture
      const fixture = __DEV__ ? parseFixtureUrl((await Linking.getInitialURL()) ?? null) : null;
      if (fixture !== null) LogBox.ignoreAllLogs(true);
      const next = fixture !== null ? await fixtureController(fixture) : productionController();
      if (fixture === null) await next.boot();
      if (cancelled) return;
      setFixture(fixture);
      setController(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (controller === null) return undefined;
    // 回到前台：断线等待中的立刻再连一次（后台里系统可能早掐了连接）
    const sub = RNAppState.addEventListener("change", (next) => {
      if (next === "active") controller.resume();
    });
    return () => sub.remove();
  }, [controller]);
  return (
    <SafeAreaProvider>
      <StatusBar style={theme.dark ? "light" : "dark"} />
      {controller === null ? <Booting theme={theme} /> : <Screens theme={theme} controller={controller} fixture={fixture} />}
    </SafeAreaProvider>
  );
}

function Screens(props: { theme: Theme; controller: AppController; fixture: FixtureParams | null }) {
  const { theme, controller, fixture } = props;
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  if (state.phase === "boot") return <Booting theme={theme} />;
  if (state.phase === "pair") return (
      <PairScreen
        theme={theme}
        state={state}
        controller={controller}
        initialAddress=""
        initialCode={fixture?.pair !== null && fixture !== null ? "418207" : ""}
      />
    );
  return (
    <View style={[styles.center, { backgroundColor: theme.color.bgApp }]}>
      <Text style={{ color: theme.color.textPrimary, fontSize: fontSize.base }}>{state.hostName}</Text>
      <Text style={{ color: theme.color.textTertiary, fontSize: fontSize.sm }}>{state.link.kind}</Text>
    </View>
  );
}

function Booting(props: { theme: Theme }) {
  return (
    <View style={[styles.center, { backgroundColor: props.theme.color.bgApp }]}>
      <Spinner color={props.theme.color.textTertiary} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
