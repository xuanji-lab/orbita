// 入口：先补全局（noble 要的随机数），再注册根组件
import "./src/polyfills.ts";
import { registerRootComponent } from "expo";
import { App } from "./src/App.tsx";

registerRootComponent(App);
