[AI 生成]

# 开源 harness 论文 → 璇玑 v4 朝廷/竞功/大明模式映射文献综述

> 本综述把 47 篇开源 harness/Agent 论文按 Coordination 拓扑映射到 璇玑 v4 朝廷模式（hierarchy）、竞功模式（market）与大明模式（混合编排），分析三模式的文献支撑程度。
> 状态：stable
> 维护：@XZF（主笔）
> 讨论：无
> 待决：无

---

## 1. 本文档定位

本文档是 璇玑 v4 的**参考类归档**，性质与 `19-minggong-frameworks.md` 一致：记录外部证据，不定义架构。定位如下：

- 不修改 `12-chaoting-mode.md`、`13-jinggong-mode.md`、`14-daming-mode.md`、`19-minggong-frameworks.md` 任何模式定义。
- 不引入新决策（决策总数现为 102，详见 10-decisions.md）、不引入新原则（原则总数保持 33）。
- 不对论文做质量排名或优劣评判，只做拓扑映射与机制佐证统计。
- 综述目的：回答"璇玑 v4 三个协作模式在开源论文生态中有多少先例，哪些是 璇玑 原创"。

朝廷模式完整定义见 `12-chaoting-mode.md`，竞功模式完整定义见 `13-jinggong-mode.md`，大明模式完整定义见 `14-daming-mode.md`，两框架设计来源见 `19-minggong-frameworks.md`，全景概览见 `01-overview.md`。

---

## 2. 综述方法

### 2.1 文献来源

文献来自四类 librarian 调研整合：① 代码 Agent harness（编程型 Agent）；② LLM 评测 harness（模型评测框架）；③ 多 Agent 框架（协作型系统）；④ 推理/规划 Agent（单 Agent 内的推理增强）。四类去重后锁定 47 篇，作为本文综述的唯一数据源。

### 2.2 论文清单

47 篇去重后的论文按模式归属分布如下（权威清单见 `无<!-- TODO: 人工确认链接 -->`）：

| 模式归属 | 数量 | 占比 |
|----------|------|------|
| 朝廷模式（hierarchy） | 9 | 19% |
| 竞功模式（market） | 7 | 15% |
| 大明模式（混合编排） | 0 | 0% |
| 其他（单 Agent） | 15 | 32% |
| 其他（评测 harness） | 10 | 21% |
| 其他（可配置） | 3 | 6% |
| 其他（peer-mesh） | 3 | 6% |
| 总计 | 47 | 100% |

### 2.3 映射维度

主判据是 **Coordination 拓扑**：论文若以层级协商组织 Agent，归朝廷模式（hierarchy）；若以并行竞争择优组织，归竞功模式（market）；若两拓扑混合或可按场景切换，归大明模式（混合编排）。三者均为协作型，单 Agent 内推理增强且无外部多 Agent 协作的归"单 Agent"，纯评测无协作的归"评测 harness"，拓扑可由用户配置的归"可配置"，扁平同辈协商的归"peer-mesh"。

副判据是**机制命中**：即便论文主类别不在三模式，仍可能命中 璇玑 的某条核心机制（如 Agentless 命中评功择优的简化版、HELM 命中三层监察的多指标监督）。副判据用于 §6 的机制佐证矩阵，不改变论文主类别。

---

## 3. 文献分类总览

### 3.1 按 Coordination 拓扑分布

| 拓扑 | 论文数 | 典型代表 |
|------|--------|----------|
| hierarchy（层级协商） | 9 | MetaGPT、ChatDev、Plan-and-Solve |
| market（并行竞争） | 7 | Multi-Agent Debate、ToT、MoA |
| 单 Agent | 15 | SWE-agent、ReAct、Reflexion |
| 评测 harness | 10 | MMLU、HELM、SWE-bench |
| 可配置 | 3 | OpenHands、AutoGen、LangGraph |
| peer-mesh | 3 | AgentVerse、AgentScope、Generative Agents |

### 3.2 按文献类别分布

| 类别 | 总数 | 直接映射三模式 | 不映射 |
|------|------|----------------|--------|
| 代码 Agent harness | 7 | 0 | 7 |
| LLM 评测 harness | 11 | 0 | 11 |
| 多 Agent 框架 | 14 | 7 | 7 |
| 推理/规划 Agent | 15 | 9 | 6 |

多 Agent 框架与推理/规划是三模式文献的主要来源；代码 harness 与评测 harness 几乎不映射——这是合法结论，它们本就不以协作组织为设计目标。

### 3.3 关键观察

47 篇中 16 篇直接映射到三模式（9 + 7 + 0），占 34%。大明模式在本次 47 篇论文样本中无直接对应，因其"混合编排/按场景切换"特性在现有开源 harness 中尚未形成独立范式。其余 31 篇虽不直接映射，仍有部分命中 璇玑 核心机制（见 §6）。开源生态中朝廷模式与竞功模式论文数量接近（9 vs 7），说明层级协商与并行竞争两种范式各有现实需求，璇玑 v4 同时支持两者有文献依据。

---

## 4. 朝廷模式（hierarchy）的文献支撑

朝廷模式以层级协商组织 Agent（见 `12-chaoting-mode.md` 第 6 节规划层、第 8 节三层监察）。本节按主题展开其文献支撑。

### 4.1 多 Agent 框架中的层级协商范式

多 Agent 框架普遍采用"角色专业化 + 流水线分工"的 hierarchy 拓扑。MetaGPT（Hong 等, 2023, ICLR 2024 Oral, arXiv:2308.00352）用 SOP 流水线把 PM/架构师/工程师/测试串成层级，通过共享消息池传递中间产物，是层级协商的典型。ChatDev（Qian 等, 2023, ACL 2024, arXiv:2307.07924）用 chat chain 实现瀑布模型，分析师→程序员→测试依次推进，并附 communicative dehallucination 做中间反馈。CAMEL（Li 等, 2023, NeurIPS 2023, arXiv:2303.17760）用 role-playing + inception prompting 形成 AI user/AI assistant 的主从协作，是 roleplay 形态的层级。CrewAI（Moura, 2024, GitHub）用 crew + manager agent 派发任务，manager 扮演层级中的裁决者。MacNet（Qian 等, 2024, arXiv:2406.07155）用 DAG 拓扑支持 1000+ Agent，把层级推广为图状分工。

这五篇共同支撑朝廷模式"多规划者协商 + 分工执行"的核心：MetaGPT/ChatDev/CrewAI 对应多规划者协商（首辅加权裁决的先例），CAMEL 对应主从式规划，MacNet 对应 DAG 分工执行（六部各管一域）。

### 4.2 推理规划中的"规划-执行分离"

推理/规划类论文中存在一组"先规划再执行"的 hierarchy 经典结构。Plan-and-Solve（Wang 等, 2023, ACL 2023, arXiv:2305.04091）显式分两阶段：Phase 1 规划、Phase 2 执行，是规划-执行分离的最直接映射。SwiftSage（Lin 等, 2023, NeurIPS 2023 spotlight, arXiv:2305.17390）用 Sage（slow planning）+ Swift（fast execution）双模块，通过 heuristic integration 在两者间切换。Self-Discover（Zhou 等, 2024, NeurIPS 2024, arXiv:2402.03620）分 Stage 1 自发现推理结构、Stage 2 按结构执行，是元推理-执行的层级分离。

这三篇对应朝廷模式规划层与执行层的职责分离（见 `12-chaoting-mode.md` 第 6 节与第 7 节）：规划层产出方案、执行层落地，两者接口明确、互不越界。SwiftSage 的模块切换还弱映射司礼监代批的"按条件分流"思想。

### 4.3 三层监察的论文回响

朝廷模式最独特的设计是过程监督/事后审计/高风险复核三层分离（见 `12-chaoting-mode.md` 第 8 节）。开源论文中无完全对应的三层结构，但有部分回响。Chain-of-Verification（Dhuliawala 等, 2023, ACL Findings 2024, arXiv:2309.11495）用 draft → plan verification → execute verification → verified response 四步链，把验证步骤从原始生成上下文中隔离出来，是最接近"独立监察者"的弱映射；其 factored 模式让验证独立于 draft，与过程监督的隔离思想相通。HELM（Liang 等, 2022, TMLR 2023, arXiv:2211.09110）用 16 scenarios × 7 metrics × 30 models 的多指标联合监督，对应三层监察"多指标并行评价"的一面。OpenCompass（Shanghai AI Lab, 2023, GitHub）的 CascadedEvaluator 用 rule-based 初判 + LLM judge 复审 + 人工可审计，构成初判-复审-终审的三段式，弱映射三层结构。

这些回响只覆盖三层中的"事后审计/多指标评价"层，没有论文实现"过程监督的独立暂停权"或"高风险强制推翻"——这两点属 璇玑 原创（见 §6.3）。

### 4.4 朝廷模式映射论文汇总表

| 论文 | 类别 | 映射机制 | arXiv |
|------|------|----------|-------|
| MetaGPT | 多 Agent 框架 | 多规划者协商 + 角色专业化 + 消息池 | 2308.00352 |
| ChatDev | 多 Agent 框架 | chat chain 分工 + dehallucination 监察 | 2307.07924 |
| CAMEL | 多 Agent 框架 | role-playing 主从协作 | 2303.17760 |
| CrewAI | 多 Agent 框架 | manager 派发（层级裁决） | GitHub |
| MacNet | 多 Agent 框架 | DAG 拓扑分工 | 2406.07155 |
| Plan-and-Solve | 推理/规划 | Phase 1 规划 + Phase 2 执行 | 2305.04091 |
| SwiftSage | 推理/规划 | Sage 规划 + Swift 执行 | 2305.17390 |
| Self-Discover | 推理/规划 | Stage 1 自发现 + Stage 2 执行 | 2402.03620 |
| Chain-of-Verification | 推理/规划 | 四步验证链（最接近三层监察） | 2309.11495 |

---

## 5. 竞功模式（market）的文献支撑

竞功模式以并行竞争组织 Agent，同任务复制多份、worktree 隔离、择优或融合（见 `13-jinggong-mode.md` 第 5 节总督、第 7 节评功推官）。本节按主题展开其文献支撑。

### 5.1 推理规划中的"多分支择优"微观市场

推理/规划类论文中最密集的 market 映射来自"多分支探索 + 择优"结构。Tree of Thoughts（Yao 等, 2023, NeurIPS 2023 oral, arXiv:2305.10601）用 BFS/DFS 展开多分支、自评估剪枝、回溯，是 worktree 并行 + 评功择优的微观版本。Graph of Thoughts（Besta 等, 2023, AAAI 2024, arXiv:2308.09687）把 thoughts 组织成任意图，支持 aggregation/distillation/feedback loop，对应评功推官的 merge 策略。LATS（Zhou 等, 2023, ICML 2024, arXiv:2310.04406）用 MCTS 四步（Selection/Expansion/Evaluation/Backup）+ UCB 选择 + self-reflection，单篇命中 worktree 并行、评功择优、军功簿 backup、事后反思四项机制，是竞功模式映射最丰富的论文。Self-Consistency（Wang 等, 2022, ICLR 2023, arXiv:2203.11171）多次采样 + majority voting，是评功推官 vote 策略的隐式实现。RAP（Reasoning via Planning, 2023，见 TS-LLM arXiv:2309.17179）用 LLM-as-world-model + MCTS 蒙特卡洛 rollouts，对应 worktree 并行 + 评功择优 + value 反向传播。

这五篇共同支撑竞功模式"复制分发 + 择优融合"的核心：ToT/GoT/LATS/RAP 对应 worktree 并行与评功择优，Self-Consistency 对应 vote 策略。它们都在单 Agent 内用推理预算"模拟"多路竞争，是 market 拓扑的微观形态。

### 5.2 多 Agent 框架中的并行竞争

多 Agent 框架中以竞争择优组织的有两篇。Multi-Agent Debate（Du 等, 2023, ICML 2024, arXiv:2305.14325）让多个 LLM 独立生成、多轮辩论、收敛聚合，各路只通过答案间接交换（不允许战术协商），对应评功推官的 tournament 择优与"禁止横向通信"的公平性约束。MoA / Mixture of Agents（Wang 等, 2024, arXiv:2406.04692）用分层聚合，每层多 Agent 并行、下层基于上层输出提炼，对应 worktree 并行 + 评功推官 merge 聚合。

这两篇把单 Agent 内的微观市场推广为真正的多 Agent 并行竞争，与竞功模式的 worktree 隔离 + 评功融合在拓扑上同构。

### 5.3 评功推官择优策略的论文映射

竞功模式评功推官支持 best/merge/hybrid/vote 四策略（见 `13-jinggong-mode.md` 第 12 节）。四策略在论文中各有先例：

| 策略 | 论文先例 | 说明 |
|------|----------|------|
| best（择优） | ToT（arXiv:2305.10601）、LATS（arXiv:2310.04406） | 自评估/UCB 选最优分支 |
| merge（融合） | GoT（arXiv:2308.09687）、MoA（arXiv:2406.04692） | aggregation/分层提炼 |
| hybrid（合进） | LATS（backup 反向传播） | 以最优为基础吸收他路 |
| vote（投票） | Self-Consistency（arXiv:2203.11171）、Multi-Agent Debate（arXiv:2305.14325） | majority vote/收敛聚合 |

四策略均有论文支撑，说明评功推官的策略空间是对开源择优机制的完备覆盖。

### 5.4 竞功模式映射论文汇总表

| 论文 | 类别 | 映射机制 | arXiv |
|------|------|----------|-------|
| Multi-Agent Debate | 多 Agent 框架 | 多轮辩论择优 + 禁止横向通信 | 2305.14325 |
| MoA (Mixture of Agents) | 多 Agent 框架 | 分层聚合 + 并行执行 | 2406.04692 |
| Self-Consistency | 推理/规划 | majority voting（vote 策略） | 2203.11171 |
| Tree of Thoughts | 推理/规划 | 多分支 + 自评估择优（best） | 2305.10601 |
| Graph of Thoughts | 推理/规划 | 图结构 aggregation（merge） | 2308.09687 |
| LATS | 推理/规划 | MCTS + UCB + self-reflection | 2310.04406 |
| RAP | 推理/规划 | 蒙特卡洛 rollouts + value | 2309.17179 |

---

## 6. 璇玑 v4 微内核不变量的文献佐证

本节把 璇玑 v4 的核心机制逐一对照论文生态，分强佐证、中等佐证、璇玑 原创三档。这些机制跨越三模式，多数由微内核代码强制（决策 78/79/80/81/82）。

### 6.1 强佐证机制（≥5 篇论文支撑）

| 机制 | 论文数 | 代表论文 |
|------|--------|----------|
| 多规划者协商 | 8 | MetaGPT、ChatDev、CrewAI、MacNet、Plan-and-Solve、SwiftSage、Self-Discover、Skeleton of Thought（arXiv:2307.15337） |
| 评功择优融合 | 8 | Multi-Agent Debate、MoA、Self-Consistency、ToT、GoT、LATS、RAP、Agentless（arXiv:2407.01489） |
| worktree 并行执行 | 7 | ToT、GoT、LATS、Self-Consistency、MoA、RAP、Skeleton of Thought |
| 事后审计 | 5 | Reflexion（arXiv:2303.11366）、Voyager（arXiv:2305.16291）、CoVe、LATS、HELM |
| 军功簿反馈 | 5 | Reflexion、Voyager、BabyAGI、LATS、RAP |

多规划者协商与评功择优融合各有 8 篇支撑，是 璇玑 三模式最扎实的文献基础。事后审计与军功簿反馈的 5 篇共同说明"跨任务学习闭环"在论文生态中有 Reflexion 的 episodic memory、Voyager 的技能库持久化、LATS 的 MCTS backup 等多种先例。

### 6.2 中等佐证机制（1-4 篇支撑）

| 机制 | 论文数 | 代表论文 |
|------|--------|----------|
| 翻译层（可逆翻译） | 2 | CoVe（draft→verify 分离）、ReAct（arXiv:2210.03629，reasoning-acting 分离） |
| 代批（预授权快速通道） | 2 | GSM8K（arXiv:2110.14168，verifier 代行审批）、EvalPlus（arXiv:2305.01210，测试套件作最终审批） |
| 紧急通道（预设降级） | 3 | AgentScope（arXiv:2402.14034，容错降级）、ToT、LATS（回溯即放弃当前路径） |
| 图状通信 | 3 | GoT（图结构 thoughts）、MoA（分层聚合通信）、AutoGen（arXiv:2308.08155，可编程多拓扑对话） |
| 事件溯源 | 1 | Generative Agents（arXiv:2304.03442，memory stream append-only） |
| 横向通信规则 | 5 | 允许侧：MetaGPT、AutoGen、Generative Agents；禁止侧：ToT、Reflexion |

这些机制在论文中有先例但数量有限。事件溯源仅 Generative Agents 的 memory stream 弱映射，是论文生态最薄弱的一环。横向通信规则因模式对立（朝廷模式允许、竞功模式禁止）而同时有允许侧与禁止侧的论文。

### 6.3 璇玑 原创机制（论文生态盲区）

| 机制 | 论文数 | 说明 |
|------|--------|------|
| 过程监察的独立暂停权 | 0 | 无论文实现"独立于执行的实时暂停权"，监察多与执行混合 |
| 高风险复核的强制推翻层 | 0 | 无论文设独立于审计的"强制推翻"层，CoVe/HELM 仅建议性或多指标评价 |
| 暂停-恢复权硬性分离 | 0 | 无论文把暂停者与恢复者拆为不同实体（决策 81） |

这三项是 璇玑 v4 在监察与权力分配上的独创贡献，开源论文生态尚无对应实现。

### 6.4 14 核心机制 × 论文佐证数矩阵

| # | 核心机制 | 佐证档 | 论文数 |
|---|----------|--------|--------|
| 1 | 多规划者协商 | 强 | 8 |
| 2 | 评功择优融合 | 强 | 8 |
| 3 | worktree 并行执行 | 强 | 7 |
| 4 | 事后审计 | 强 | 5 |
| 5 | 军功簿反馈 | 强 | 5 |
| 6 | 横向通信规则 | 中 | 5 |
| 7 | 图状通信 | 中 | 3 |
| 8 | 紧急通道 | 中 | 3 |
| 9 | 翻译层 | 中 | 2 |
| 10 | 代批 | 中 | 2 |
| 11 | 事件溯源 | 中 | 1 |
| 12 | 过程监察独立暂停权 | 原创 | 0 |
| 13 | 高风险复核强制推翻 | 原创 | 0 |
| 14 | 暂停-恢复权分离 | 原创 | 0 |

11 项有论文佐证（79%），3 项为 璇玑 原创（21%）。

---

## 7. 研究空白与 璇玑 v4 的补充

### 7.1 论文生态的三个局限

第一，监察与执行混合。开源论文中监察角色多与执行耦合（如 Self-Refine 的 FEEDBACK→REFINE 自我迭代，arXiv:2303.17651），或仅做事后建议（Reflexion 的 verbal reflection），没有论文把"实时暂停"设为独立于执行的权力。

第二，无强制推翻层。论文的复核多为建议性或评分性（HELM 多指标、CoVe 验证），缺乏一个能强制推翻执行结果并要求重做的独立裁决层。

第三，暂停恢复不分离。论文的迭代控制（ToT 回溯、LATS backup）由同一主体同时决定暂停与恢复，无硬性分离。

### 7.2 璇玑 v4 的三个独创贡献

璇玑 v4 的三项原创机制（§6.3）正对应上述三个空白：过程监察的独立暂停权（朝廷模式六科给事中、竞功模式监军御史）只暂停不恢复；高风险复核层（朝廷模式大理寺）有强制推翻权、独立于事后审计；暂停-恢复权分离（决策 81）由代码强制，暂停者与恢复者分属不同 Identity。这三项使 璇玑 的监察体系比论文生态更完备。

### 7.3 大明模式的定位

大明模式对应混合编排（Coordination × Execution 动态组合或 council 复合态）。在本次 47 篇论文样本中，无论文直接对应"同一系统内可切换 hierarchy/market 拓扑"或"council 四策略按任务路由"的混合形态。AutoGen（arXiv:2308.08155）的"可编程多拓扑对话"最接近，但其切换由用户显式配置而非系统自适应路由，仅作弱映射。大明模式的文献空白恰恰说明 璇玑 在该方向的原创性。

### 7.4 朝廷模式与竞功模式的互补性

两者共享 6 个核心不变量（决策 78/79/80/81/82 等代码级强制约束），底层骨架高度同源；差异仅在 Coordination 拓扑选择（见 `01-overview.md` 第 6 节）。璇玑 v4 用同一个微内核容纳两种范式，互补而非互斥。

---

## 8. 数量统计与主要发现

### 8.1 论文映射统计表

| 类别 × 模式 | 朝廷 | 竞功 | 大明 | 不映射 | 小计 |
|-------------|------|------|------|--------|------|
| 多 Agent 框架 | 5 | 2 | 0 | 7 | 14 |
| 推理/规划 | 4 | 5 | 0 | 6 | 15 |
| 代码 Agent harness | 0 | 0 | 0 | 7 | 7 |
| LLM 评测 harness | 0 | 0 | 0 | 11 | 11 |
| 总计 | 9 | 7 | 0 | 31 | 47 |

### 8.2 五条主要发现

1. **34% 论文直接映射三模式**：16/47 篇（朝廷 9 + 竞功 7 + 大明 0）以 hierarchy 或 market 拓扑组织协作。
2. **79% 核心机制有论文佐证**：14 项核心机制中 11 项至少有 1 篇论文先例。
3. **21% 核心机制是 璇玑 原创**：过程监察独立暂停权、高风险复核强制推翻、暂停-恢复权分离三项无论文对应。
4. **两模式论文数量对称**：朝廷模式 9 篇 vs 竞功模式 7 篇，大明模式尚无直接对应，说明混合编排是 璇玑 的前沿方向。
5. **璇玑 是论文生态的总结与升华**：三模式把分散的协商派与竞争派先例整合为可切换的完整 Preset，并在监察与权力分离上补足了论文生态的空白。

---

## 9. 术语对照表

| 中文 | 英文 |
|------|------|
| 层级协商 | hierarchy（Coordination） |
| 市场竞争 | market（Coordination） |
| 混合编排 | hybrid orchestration |
| 协调模式 | Coordination Pattern |
| 执行模式 | Execution Pattern |
| 单 Agent | single-agent |
| 评测 harness | evaluation harness |
| 辩论 | debate |
| 同辈网状 | peer-mesh |
| 角色扮演 | roleplay |
| 可配置 | configurable |
| 朝廷模式 | Chaoting |
| 竞功模式 | Jinggong |
| 大明模式 | Daming |
| 规划-执行分离 | planning-execution separation |
| 多分支择优 | multi-branch selection |
| 评功择优融合 | merit selection/merge |
| worktree 并行 | worktree parallelism |
| 事后审计 | post-hoc audit |
| 军功簿反馈 | WeightRegistry feedback |
| 过程监察 | process supervision |
| 高风险复核 | high-risk review |
| 暂停-恢复权分离 | pause/resume separation |

---

## 10. 相关文档

- `12-chaoting-mode.md` — 朝廷模式完整定义（七层架构、司礼监代批、三层监察）
- `13-jinggong-mode.md` — 竞功模式完整定义（七层架构、worktree 并行、评功四策略、军功簿闭环）
- `14-daming-mode.md` — 大明模式完整定义（混合编排、效率转模）
- `19-minggong-frameworks.md` — 两框架设计来源归档
- `01-overview.md` — 全景概览（6 一等概念、双层 Pattern、双宪法体系）
- `03-execution-modes.md` — Coordination × Execution 两层 Pattern 与组合矩阵
- `README.md` — 阅读指南与文档地图

---

> 文档版本：v1.10
> 本版变更（累积最近 3 条，最新在上）：
>   - v1.10：项目更名 wuwo→璇玑（ORBITA），全文品牌/路径/标识符替换（见决策 146）
>   - v1.9：计数同步 102→112/25→29
>   - v1.8：v4.3.2 T7 自检同步——Phase 3-4 + Pattern 矩阵 + 多用户 + coding-pack v0.7 + TUI
> 基于：librarian 调研（47 篇论文）+ 璇玑 v4 架构设计
> 决策总数：112 条
> 文档总数：29 份
> 原则总数：33 条
