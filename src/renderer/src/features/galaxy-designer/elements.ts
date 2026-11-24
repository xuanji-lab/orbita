/**
 * 元素周期表的目录（星系设计面板「成分」一节用）。周期 1–6 的主表；镧系、锕系与第 7 周期不收——
 * 行星成分里用不上，面板上占一格「镧系」占位、不可选。
 *
 * 字段：
 * - group / period：周期表位置（IUPAC 1–18 族）；
 * - phase：标准状况（0 °C、1 atm）下单质的物相；
 * - reservoir：在行星里大多落进哪个「储库」——metal 金属核、rock 与氧结合成硅酸盐、volatile 冰 / 挥发物、
 *   noble 只待在气体里、oxygen 先配给硅酸盐、多的进冰（推算密度用，见 mix.ts）；
 * - hint：颜色提示（OKLCH：明度 0–1、彩度、色相°），只是示意——单质或常见化合物在行星表面 / 大气里显出的颜色；
 * - common：行星成分里常见（周期表上突出显示，其余弱化）；
 * - note：一句科普（只给常见的）。
 *
 * 与插件同源：插件 planet-forge 以后出 elements.json 时，字段按这里的名字给，这份文件改成读它；
 * 在那之前这里是真源（插件只读不改，不能往插件里加文件）。
 */
export type ElementPhase = "solid" | "liquid" | "gas";
export type Reservoir = "metal" | "rock" | "volatile" | "noble" | "oxygen";

export interface ElementInfo {
  z: number;
  symbol: string;
  zh: string;
  en: string;
  group: number;
  period: number;
  phase: ElementPhase;
  reservoir: Reservoir;
  hint: { l: number; c: number; h: number };
  common: boolean;
  note?: string;
}

const NEUTRAL = { l: 0.62, c: 0.02, h: 60 };

export const ELEMENTS: readonly ElementInfo[] = [
  { z: 1, symbol: "H", zh: "氢", en: "Hydrogen", group: 1, period: 1, phase: "gas", reservoir: "volatile", hint: { l: 0.8, c: 0.04, h: 250 }, common: true, note: "宇宙里最多的元素；气态巨行星的主体，在冰里和氧结合成水。" },
  { z: 2, symbol: "He", zh: "氦", en: "Helium", group: 18, period: 1, phase: "gas", reservoir: "noble", hint: { l: 0.86, c: 0.01, h: 80 }, common: true, note: "第二多；惰性，只待在气体里，不进岩石。" },
  { z: 3, symbol: "Li", zh: "锂", en: "Lithium", group: 1, period: 2, phase: "solid", reservoir: "rock", hint: NEUTRAL, common: false },
  { z: 4, symbol: "Be", zh: "铍", en: "Beryllium", group: 2, period: 2, phase: "solid", reservoir: "rock", hint: NEUTRAL, common: false },
  { z: 5, symbol: "B", zh: "硼", en: "Boron", group: 13, period: 2, phase: "solid", reservoir: "rock", hint: NEUTRAL, common: false },
  { z: 6, symbol: "C", zh: "碳", en: "Carbon", group: 14, period: 2, phase: "solid", reservoir: "volatile", hint: { l: 0.36, c: 0.01, h: 60 }, common: true, note: "有机物与甲烷冰的骨架；外太阳系冰质天体里常见。" },
  { z: 7, symbol: "N", zh: "氮", en: "Nitrogen", group: 15, period: 2, phase: "gas", reservoir: "volatile", hint: { l: 0.78, c: 0.05, h: 260 }, common: true, note: "地球大气的 78%（体积）；冰质天体上以氨冰、氮冰出现。" },
  { z: 8, symbol: "O", zh: "氧", en: "Oxygen", group: 16, period: 2, phase: "gas", reservoir: "oxygen", hint: { l: 0.76, c: 0.06, h: 235 }, common: true, note: "岩石里质量最多的元素：和镁、硅、铁结合成硅酸盐；多出来的和氢成水。" },
  { z: 9, symbol: "F", zh: "氟", en: "Fluorine", group: 17, period: 2, phase: "gas", reservoir: "volatile", hint: NEUTRAL, common: false },
  { z: 10, symbol: "Ne", zh: "氖", en: "Neon", group: 18, period: 2, phase: "gas", reservoir: "noble", hint: { l: 0.66, c: 0.2, h: 30 }, common: true, note: "惰性气体，只在大气里；放电时发橙红光。" },
  { z: 11, symbol: "Na", zh: "钠", en: "Sodium", group: 1, period: 3, phase: "solid", reservoir: "rock", hint: { l: 0.8, c: 0.12, h: 90 }, common: true, note: "盐（NaCl）与长石里的成分；在稀薄外逸层里发黄光。" },
  { z: 12, symbol: "Mg", zh: "镁", en: "Magnesium", group: 2, period: 3, phase: "solid", reservoir: "rock", hint: { l: 0.72, c: 0.02, h: 80 }, common: true, note: "地幔橄榄石的主要金属之一。" },
  { z: 13, symbol: "Al", zh: "铝", en: "Aluminium", group: 13, period: 3, phase: "solid", reservoir: "rock", hint: { l: 0.76, c: 0.01, h: 250 }, common: true, note: "地壳里最多的金属，长石的骨架之一。" },
  { z: 14, symbol: "Si", zh: "硅", en: "Silicon", group: 14, period: 3, phase: "solid", reservoir: "rock", hint: { l: 0.64, c: 0.04, h: 70 }, common: true, note: "岩石的骨架：和氧组成硅氧四面体。" },
  { z: 15, symbol: "P", zh: "磷", en: "Phosphorus", group: 15, period: 3, phase: "solid", reservoir: "rock", hint: { l: 0.76, c: 0.08, h: 60 }, common: true, note: "生命必需，含量很低；多在矿物磷灰石里。" },
  { z: 16, symbol: "S", zh: "硫", en: "Sulfur", group: 16, period: 3, phase: "solid", reservoir: "metal", hint: { l: 0.84, c: 0.15, h: 100 }, common: true, note: "多跟铁一起沉进核（FeS）；火山与硫黄让表面发黄。" },
  { z: 17, symbol: "Cl", zh: "氯", en: "Chlorine", group: 17, period: 3, phase: "gas", reservoir: "volatile", hint: { l: 0.82, c: 0.12, h: 120 }, common: true, note: "盐与卤水里的成分，表面化学活泼。" },
  { z: 18, symbol: "Ar", zh: "氩", en: "Argon", group: 18, period: 3, phase: "gas", reservoir: "noble", hint: { l: 0.66, c: 0.12, h: 300 }, common: true, note: "地球大气里第三多（约 0.93% 体积），来自钾-40 衰变。" },
  { z: 19, symbol: "K", zh: "钾", en: "Potassium", group: 1, period: 4, phase: "solid", reservoir: "rock", hint: { l: 0.7, c: 0.08, h: 320 }, common: true, note: "长石与云母里的成分；钾-40 是岩石内部的热源之一。" },
  { z: 20, symbol: "Ca", zh: "钙", en: "Calcium", group: 2, period: 4, phase: "solid", reservoir: "rock", hint: { l: 0.82, c: 0.02, h: 85 }, common: true, note: "斜长石、碳酸盐里的成分，耐熔。" },
  { z: 21, symbol: "Sc", zh: "钪", en: "Scandium", group: 3, period: 4, phase: "solid", reservoir: "rock", hint: NEUTRAL, common: false },
  { z: 22, symbol: "Ti", zh: "钛", en: "Titanium", group: 4, period: 4, phase: "solid", reservoir: "rock", hint: { l: 0.66, c: 0.02, h: 250 }, common: true, note: "钛铁矿里的成分；月海玄武岩里偏多。" },
  { z: 23, symbol: "V", zh: "钒", en: "Vanadium", group: 5, period: 4, phase: "solid", reservoir: "metal", hint: NEUTRAL, common: false },
  { z: 24, symbol: "Cr", zh: "铬", en: "Chromium", group: 6, period: 4, phase: "solid", reservoir: "metal", hint: { l: 0.6, c: 0.1, h: 150 }, common: true, note: "少量进核，少量在尖晶石里。" },
  { z: 25, symbol: "Mn", zh: "锰", en: "Manganese", group: 7, period: 4, phase: "solid", reservoir: "metal", hint: { l: 0.52, c: 0.08, h: 330 }, common: true, note: "少量；氧化后让表面泛紫褐。" },
  { z: 26, symbol: "Fe", zh: "铁", en: "Iron", group: 8, period: 4, phase: "solid", reservoir: "metal", hint: { l: 0.55, c: 0.13, h: 40 }, common: true, note: "岩质行星质量最多的元素之一（地球约 32%），大部分沉在核里；表面氧化成锈红（火星）。" },
  { z: 27, symbol: "Co", zh: "钴", en: "Cobalt", group: 9, period: 4, phase: "solid", reservoir: "metal", hint: { l: 0.5, c: 0.12, h: 265 }, common: false },
  { z: 28, symbol: "Ni", zh: "镍", en: "Nickel", group: 10, period: 4, phase: "solid", reservoir: "metal", hint: { l: 0.62, c: 0.02, h: 90 }, common: true, note: "和铁一起组成金属核（地核约 5% 镍）。" },
  { z: 29, symbol: "Cu", zh: "铜", en: "Copper", group: 11, period: 4, phase: "solid", reservoir: "metal", hint: { l: 0.6, c: 0.11, h: 175 }, common: false },
  { z: 30, symbol: "Zn", zh: "锌", en: "Zinc", group: 12, period: 4, phase: "solid", reservoir: "metal", hint: { l: 0.75, c: 0.01, h: 250 }, common: false },
  { z: 31, symbol: "Ga", zh: "镓", en: "Gallium", group: 13, period: 4, phase: "solid", reservoir: "rock", hint: NEUTRAL, common: false },
  { z: 32, symbol: "Ge", zh: "锗", en: "Germanium", group: 14, period: 4, phase: "solid", reservoir: "rock", hint: NEUTRAL, common: false },
  { z: 33, symbol: "As", zh: "砷", en: "Arsenic", group: 15, period: 4, phase: "solid", reservoir: "rock", hint: NEUTRAL, common: false },
  { z: 34, symbol: "Se", zh: "硒", en: "Selenium", group: 16, period: 4, phase: "solid", reservoir: "rock", hint: NEUTRAL, common: false },
  { z: 35, symbol: "Br", zh: "溴", en: "Bromine", group: 17, period: 4, phase: "liquid", reservoir: "volatile", hint: { l: 0.5, c: 0.14, h: 35 }, common: false },
  { z: 36, symbol: "Kr", zh: "氪", en: "Krypton", group: 18, period: 4, phase: "gas", reservoir: "noble", hint: { l: 0.72, c: 0.08, h: 260 }, common: false },
  { z: 37, symbol: "Rb", zh: "铷", en: "Rubidium", group: 1, period: 5, phase: "solid", reservoir: "rock", hint: NEUTRAL, common: false },
  { z: 38, symbol: "Sr", zh: "锶", en: "Strontium", group: 2, period: 5, phase: "solid", reservoir: "rock", hint: NEUTRAL, common: false },
  { z: 39, symbol: "Y", zh: "钇", en: "Yttrium", group: 3, period: 5, phase: "solid", reservoir: "rock", hint: NEUTRAL, common: false },
  { z: 40, symbol: "Zr", zh: "锆", en: "Zirconium", group: 4, period: 5, phase: "solid", reservoir: "rock", hint: NEUTRAL, common: false },
  { z: 41, symbol: "Nb", zh: "铌", en: "Niobium", group: 5, period: 5, phase: "solid", reservoir: "metal", hint: NEUTRAL, common: false },
  { z: 42, symbol: "Mo", zh: "钼", en: "Molybdenum", group: 6, period: 5, phase: "solid", reservoir: "metal", hint: NEUTRAL, common: false },
  { z: 43, symbol: "Tc", zh: "锝", en: "Technetium", group: 7, period: 5, phase: "solid", reservoir: "metal", hint: NEUTRAL, common: false },
  { z: 44, symbol: "Ru", zh: "钌", en: "Ruthenium", group: 8, period: 5, phase: "solid", reservoir: "metal", hint: NEUTRAL, common: false },
  { z: 45, symbol: "Rh", zh: "铑", en: "Rhodium", group: 9, period: 5, phase: "solid", reservoir: "metal", hint: NEUTRAL, common: false },
  { z: 46, symbol: "Pd", zh: "钯", en: "Palladium", group: 10, period: 5, phase: "solid", reservoir: "metal", hint: NEUTRAL, common: false },
  { z: 47, symbol: "Ag", zh: "银", en: "Silver", group: 11, period: 5, phase: "solid", reservoir: "metal", hint: { l: 0.82, c: 0.005, h: 250 }, common: false },
  { z: 48, symbol: "Cd", zh: "镉", en: "Cadmium", group: 12, period: 5, phase: "solid", reservoir: "metal", hint: NEUTRAL, common: false },
  { z: 49, symbol: "In", zh: "铟", en: "Indium", group: 13, period: 5, phase: "solid", reservoir: "metal", hint: NEUTRAL, common: false },
  { z: 50, symbol: "Sn", zh: "锡", en: "Tin", group: 14, period: 5, phase: "solid", reservoir: "rock", hint: NEUTRAL, common: false },
  { z: 51, symbol: "Sb", zh: "锑", en: "Antimony", group: 15, period: 5, phase: "solid", reservoir: "rock", hint: NEUTRAL, common: false },
  { z: 52, symbol: "Te", zh: "碲", en: "Tellurium", group: 16, period: 5, phase: "solid", reservoir: "rock", hint: NEUTRAL, common: false },
  { z: 53, symbol: "I", zh: "碘", en: "Iodine", group: 17, period: 5, phase: "solid", reservoir: "volatile", hint: { l: 0.4, c: 0.1, h: 310 }, common: false },
  { z: 54, symbol: "Xe", zh: "氙", en: "Xenon", group: 18, period: 5, phase: "gas", reservoir: "noble", hint: { l: 0.7, c: 0.1, h: 265 }, common: false },
  { z: 55, symbol: "Cs", zh: "铯", en: "Caesium", group: 1, period: 6, phase: "solid", reservoir: "rock", hint: { l: 0.8, c: 0.1, h: 85 }, common: false },
  { z: 56, symbol: "Ba", zh: "钡", en: "Barium", group: 2, period: 6, phase: "solid", reservoir: "rock", hint: NEUTRAL, common: false },
  { z: 72, symbol: "Hf", zh: "铪", en: "Hafnium", group: 4, period: 6, phase: "solid", reservoir: "rock", hint: NEUTRAL, common: false },
  { z: 73, symbol: "Ta", zh: "钽", en: "Tantalum", group: 5, period: 6, phase: "solid", reservoir: "metal", hint: NEUTRAL, common: false },
  { z: 74, symbol: "W", zh: "钨", en: "Tungsten", group: 6, period: 6, phase: "solid", reservoir: "metal", hint: NEUTRAL, common: false },
  { z: 75, symbol: "Re", zh: "铼", en: "Rhenium", group: 7, period: 6, phase: "solid", reservoir: "metal", hint: NEUTRAL, common: false },
  { z: 76, symbol: "Os", zh: "锇", en: "Osmium", group: 8, period: 6, phase: "solid", reservoir: "metal", hint: NEUTRAL, common: false },
  { z: 77, symbol: "Ir", zh: "铱", en: "Iridium", group: 9, period: 6, phase: "solid", reservoir: "metal", hint: NEUTRAL, common: false },
  { z: 78, symbol: "Pt", zh: "铂", en: "Platinum", group: 10, period: 6, phase: "solid", reservoir: "metal", hint: { l: 0.78, c: 0.005, h: 90 }, common: false },
  { z: 79, symbol: "Au", zh: "金", en: "Gold", group: 11, period: 6, phase: "solid", reservoir: "metal", hint: { l: 0.75, c: 0.13, h: 85 }, common: false },
  { z: 80, symbol: "Hg", zh: "汞", en: "Mercury", group: 12, period: 6, phase: "liquid", reservoir: "metal", hint: { l: 0.75, c: 0.01, h: 250 }, common: false },
  { z: 81, symbol: "Tl", zh: "铊", en: "Thallium", group: 13, period: 6, phase: "solid", reservoir: "metal", hint: NEUTRAL, common: false },
  { z: 82, symbol: "Pb", zh: "铅", en: "Lead", group: 14, period: 6, phase: "solid", reservoir: "metal", hint: { l: 0.5, c: 0.01, h: 260 }, common: false },
  { z: 83, symbol: "Bi", zh: "铋", en: "Bismuth", group: 15, period: 6, phase: "solid", reservoir: "metal", hint: NEUTRAL, common: false },
  { z: 84, symbol: "Po", zh: "钋", en: "Polonium", group: 16, period: 6, phase: "solid", reservoir: "metal", hint: NEUTRAL, common: false },
  { z: 85, symbol: "At", zh: "砹", en: "Astatine", group: 17, period: 6, phase: "solid", reservoir: "volatile", hint: NEUTRAL, common: false },
  { z: 86, symbol: "Rn", zh: "氡", en: "Radon", group: 18, period: 6, phase: "gas", reservoir: "noble", hint: NEUTRAL, common: false },
];

export const ELEMENT_BY_SYMBOL: ReadonlyMap<string, ElementInfo> = new Map(ELEMENTS.map((element) => [element.symbol, element]));

/** 周期表上折叠起来的那几行：第 6 周期（铯以后）默认收起 */
export const FOLDED_PERIODS: ReadonlySet<number> = new Set([6]);
