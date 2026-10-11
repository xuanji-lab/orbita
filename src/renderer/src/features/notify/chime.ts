/**
 * 提示音：客舱呼唤铃那一声「叮」（用户 2026-10-10 点名：航班上呼叫空乘的提示音）。
 *
 * **现场合成，不带音频文件**：录音有版权，也没有必要——那一声本质是一个钟琴式的
 * 纯音，基频加两三个衰减更快的泛音、几毫秒起音、一两秒指数衰减，Web Audio 几个
 * 振荡器就能做出来，不进包体、不走文件 IO、不新增依赖。
 *
 * 以后要加别的提示音（等待输入、失败…），在这里再加一个 play 函数，共用同一个
 * AudioContext；**现在只有一个消费者，不建注册表**。
 */

/** 一个分音：相对基频的倍数、相对音量、衰减到静音的秒数 */
interface ChimePartial {
  ratio: number;
  gain: number;
  decay: number;
}

/** 基频取 B5 附近：够亮能穿透背景，又不刺耳 */
const FUNDAMENTAL_HZ = 988;
/** 总音量：提示而不吓人。系统音量之下再压一档 */
const MASTER_GAIN = 0.16;
const ATTACK_S = 0.006;

/**
 * 分音表。1.0 是主音；1.004 与它拍出缓慢的颤动，听感从「电子蜂鸣」变成「金属铃」；
 * 2.0 / 3.0 是让音色发亮的泛音，衰减得更快——铃声越到尾巴越纯，正是这个原因。
 */
const PARTIALS: readonly ChimePartial[] = [
  { ratio: 1, gain: 1, decay: 2.2 },
  { ratio: 1.004, gain: 0.35, decay: 1.8 },
  { ratio: 2, gain: 0.22, decay: 0.9 },
  { ratio: 3, gain: 0.07, decay: 0.45 },
];

let context: AudioContext | null = null;

/** 播放一次完成提示音。失败（没有音频设备等）静默吞掉——提示音不能让任何流程失败。 */
export function playCompletionChime(): void {
  try {
    context ??= new AudioContext();
    const ctx = context;
    // 闲置久了 Chromium 会把 context 挂起；resume 是幂等的
    void ctx.resume().catch(() => undefined);
    const start = ctx.currentTime + 0.01;
    const master = ctx.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(ctx.destination);
    let end = start;
    for (const partial of PARTIALS) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = FUNDAMENTAL_HZ * partial.ratio;
      const env = ctx.createGain();
      // 从 0 起音，指数衰减（exponentialRamp 不能到 0，到 0.0001 即听不见）
      env.gain.setValueAtTime(0, start);
      env.gain.linearRampToValueAtTime(partial.gain, start + ATTACK_S);
      env.gain.exponentialRampToValueAtTime(0.0001, start + ATTACK_S + partial.decay);
      osc.connect(env);
      env.connect(master);
      const stop = start + ATTACK_S + partial.decay + 0.05;
      osc.start(start);
      osc.stop(stop);
      end = Math.max(end, stop);
    }
    // 播完断开总线，节点交给 GC
    setTimeout(() => master.disconnect(), Math.ceil((end - ctx.currentTime) * 1000) + 100);
  } catch (cause) {
    console.warn("[chime] 提示音播放失败", cause);
  }
}
