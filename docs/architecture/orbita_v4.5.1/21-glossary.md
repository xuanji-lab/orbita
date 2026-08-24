[AI 生成]

# 中英双语术语表（Bilingual Glossary）

> 璇玑（ORBITA）v4 明朝隐喻术语中英对照。英文为简注（essence, not translation），供非中文母语者快速理解。
> 状态：stable
> 维护：@XZF（主笔）
> 讨论：无
> 待决：无

---

## 品牌名 / Brand

| 中文 | 英文 | 说明 |
|------|------|------|
| 璇玑 | ORBITA | 项目名（2026-08 由代号 wuwo 更名，见决策 146）。璇玑为北斗魁四星/古代天文仪器，喻「多星在列、枢纽定序」 |

---

## 朝廷模式 / Chaoting Mode（内阁制 / Neige System）

### 机构与层级 / Institutions & Hierarchy

| 中文 | 英文 | 说明 |
|------|------|------|
| 皇帝 | Emperor | 最高决策者，总控 Agent |
| 司礼监 | Sijian | 前置关口，有限代批权 |
| 秉笔太监 | Eunuch Scribe | 司礼监执行者 |
| 内阁 | Grand Secretariat | 规划决策层 |
| 大学士 | Grand Secretary | 规划 Agent，票拟方案 |
| 首辅 | Chief Grand Secretary | 首席规划 Agent，加权裁决 |
| 六部 | Six Ministries | 执行层 |
| 尚书 | Minister | 六部负责人 |
| 司级 | Bureau-level | 部门调度 |
| 科级 | Section-level | 原子操作执行 |
| 主事 | Section Chief | 科级负责人 |
| 清吏司 | Clear Court | 按领域分工 |
| 都察院 | Censorate | 总监督 Agent 映射（汇总监察，都御史审查弹劾决定上报） |
| 大理寺 | Court of Judicature | 高风险复核 |
| 六科给事中 | Six Offices of Scrutiny | 过程监督（有暂停权） |
| 东厂 | Eastern Depot | 秘密监察，直接对皇帝负责 |
| 锦衣卫 | Jinyiwei | 强制隔离/诏狱执行 |
| 通政使司 | Transmission Office | 通政司 Agent（司礼监 subagent）映射（收文/翻译/贴黄/读工作区文档/急递判定） |
| 通政使 | Tongzhengshi | 模式判定 Agent 映射（判定奏章呈递路径=模式路由） |
| 通政司 Agent | TongzhengAgent | 司礼监的组合 subagent（决策 139）：收文登记/查看工作区文档/翻译/分类/分发；不决定内容对错 |
| 皇史宬 | Imperial Archives | 档籍持久化 |
| 行人司 | Court of Envoys | 外部反馈收集 |
| 子监督 Agent | Sub-Check | 检查单个执行 Agent 完成情况（六科给事中映射） |
| 总监督 Agent | Chief Check | 汇总所有子监督报告+对照完整方案（都察院都御史映射） |
| 复核 Agent | Reviewer | 高风险结果安全复核，可推翻监督结论（大理寺映射） |

> 注：掌院学士（翰林院）已不再是模式判定的映射。模式判定改为通政使（决策 137）。

### 流程与机制 / Processes & Mechanisms

| 中文 | 英文 | 说明 |
|------|------|------|
| 票拟 | Piao-ni (draft proposal) | 多名规划 Agent 各自生成方案 |
| 批红 | Pi-hong (ratification) | 总控/司礼监批注生效 |
| 条陈 | BatchApproveCharter | 代批授权清单 |
| 度支票拟 | Budget proposal | 户部核定 Token 预算 |
| 考成簿 | Performance record | 任务执行考成记录 |
| 考成法 | Kaochengfa | 考核与时限制度 |
| 贴黄 | Tiehuang (abstract) | 用户输入的结构化摘要 |
| 奏章 | Memorial | 正式请求文档 |
| 封驳 | Fengbo rejection | 交互层驳回不合规输出 |
| 锁院 | Court lockdown | 全局熔断 |
| 会推 | Huitui recommendation | 跨部协同 |
| 会审 | Huishen review | 多机构联合审查 |
| 科抄 | Ke chao comparison | 交互审核前后比对 |
| 关白 | Cross-bu notification | 跨部通知 |
| 转行 | Document routing | 文书路由分发 |
| 急递通道 | Express dispatch | 中止/转向/新任务的紧急路由 |
| 中途复核 | Mid-execution review | 高风险子任务在关键节点强制复核 |
| 问策入口 | Feedback channel | 最终输出附带的用户反馈入口 |
| 偏离度评分 | Deviation score | 封驳校验翻译可逆性 |
| 密奏 | Secret memorial | 监军御史直送总控的通道 |

### 考核体系 / Evaluation System

| 中文 | 英文 | 说明 |
|------|------|------|
| 京察 | Jingcha review | 周期性综合考核（京官） |
| 大计 | Daji review | 周期性综合考核（外官） |
| 考功司 | Kao Gong Si | 吏部下属，京察大计综合考核（审计 Agent 明朝别名） |
| 审计 Agent | Auditor | 事后成本审计/经验记录/权重反馈（考功司映射） |
| 考绩簿 | Performance ledger | 朝廷模式下的权重记录（即 WeightRegistry） |
| 卓异 | Zhuoyi (outstanding) | 最高考核等级 |
| 停俸 | Salary suspension | 超期/超支降权惩罚 |
| 废黜待议池 | FeichuPool | 连续不称职者待议淘汰 |

### 财政与资源配置 / Treasury & Resources

| 中文 | 英文 | 说明 |
|------|------|------|
| 户部（财政面） | HubuFinance | 预算核定与偏差监控 |
| 太仓库 | Taicangku | 实际资源存放与硬约束 |
| 内承运库 | Neichengyunku | 皇帝内库，大额拨付需亲批 |
| 御马监 | Yumajian | 快速可调动资源池 |

### 特殊机制 / Special Mechanisms

| 中文 | 英文 | 说明 |
|------|------|------|
| 诏狱 | Zhaoyu | 严重违规隔离审查 |
| 效率转模 | Efficiency mode-switch | 朝廷子任务超预算自动切竞功 |
| 行在六部 | XingzaiLibu | 灾备模式下的降级执行 |
| 沙盘推演 | Shapan Tuiyan | 冷启动前标准化模拟测试 |
| 天子 | Son of Heaven | 总控 Agent 的最高权威象征 |

---

## 竞功模式 / Jinggong Mode（军事体制 / Military System）

### 机构与角色 / Institutions & Roles

| 中文 | 英文 | 说明 |
|------|------|------|
| 总督 | Governor | 总指挥官，分发任务 |
| 提督 | Commander | 各 Worktree 的独立执行者 |
| 军情转译使 | Intel Translator | 竞功交互层，翻译用户意图 |
| 监军御史 | Military Supervisor | 过程监察，有暂停权和密奏通道 |
| 评功推官 | Merit Evaluator | 五道验功评估排名 |
| 军功勘验使 | Merit Auditor | 事后复盘评分，更新权重 |
| 参谋校正组 | Staff Correction Group | 运行中校正建议 |

### 流程与机制 / Processes & Mechanisms

| 中文 | 英文 | 说明 |
|------|------|------|
| 军功簿 | Military Merit Registry | 竞功模式下的权重记录（即 WeightRegistry） |
| 五道验功 | Five-stage Verification | 评功推官的多维度评估 |
| 叙功册 | Merit Record | 评估结果记录 |
| 白旗 | Pause flag | 监军御史暂停信号 |
| 选锋 | Xuanfeng | 标签系统，记录擅长领域偏好 |
| 九边坐镇 | Jiubian Stationed | 长连接频道的持续监听 |
| 主路/客路 | Main Branch / Guest Branch | 并行竞争的执行分支 |
| 功赏量规 | Evaluation Rubric | Pack 提供的功赏评估维度和权重 |
| 签批 | Sign approval | 替代批红的竞功术语 |

---

## 谋士型 / Moushi Type（智囊团 / Council System）

### 机构与角色 / Institutions & Roles

| 中文 | 英文 | 说明 |
|------|------|------|
| 翰林 | Hanlin | 增益与学术辅助体系 |
| 翰林格物学士 | HanlinEnricher | 横切增益模块，输出《格物引》 |
| 翰林学士 | HanlinScholar | 帝皇模式中的审议辅助 |
| 经筵学士 | JingyanScholar | 门客模式中的灵感扩展 |
| 格物引 | GewuCitation | 翰林增益产物的上下文引用 |
| 门客 | Menke | fan-out 创意发散 |
| 幕僚 | Muliao | chain 专家链式落地 |
| 帝皇 | Dihuang | tournament 层级审议 |
| 总智囊 | Zhinang Router | opt-in 融合，内部路由 |
| 朝会 | Chaohui | 复合运行态（在总智囊内部） |
| 谏院御史 | Jianyuan Critic | 替代性观点审查 |
| 资源御史 | Resource Censor | 资源/时间/风险可行性审查 |
| 圣裁Agent | Dihuang Synthesizer | 帝皇模式的最终裁决 |
| 创意池管理器 | IdeaPool Manager | 门客层创意收集去重 |
| 合规师爷 | Compliance Aide | 幕僚 chain 中法规审查 |
| 钱粮师爷 | Treasury Aide | 幕僚 chain 中资源和预算估算 |
| 文案师爷 | Drafting Aide | 幕僚 chain 中沟通包装 |
| 总办调度 | Dispatch Coordinator | 幕僚 chain 收口节点 |
| 批红Agent | Ratification Agent | 谋士型最终的批红裁决者 |
| 问题诊断器 | Diagnoser | 总智囊内部的问题类型分析 |
| 模式路由器 | Mode Router | 总智囊内部的分发路由 |
| 朝会主持人 | Chaohui Moderator | 朝会复合态运行调度 |

### 概念 / Concepts

| 中文 | 英文 | 说明 |
|------|------|------|
| 横切增益模块 | Cross-cutting Enricher | 增益非关卡，只加上下文不拦截 |
| 馆阁选士 | Talent Selection | 门客模式中的参与者遴选 |

---

## 通用 / Shared

| 中文 | 英文 | 说明 |
|------|------|------|
| 朝廷模式 | Chaoting Mode | hierarchy Coordination 的完整 Preset |
| 竞功模式 | Jinggong Mode | market Coordination 的完整 Preset |
| 大明模式 | Daming Mode | 朝廷+竞功混编，含效率转模 |
| 谋士型 | Moushi Type | council Coordination 的完整 Preset |
| 任事型 | Renshi Type | 朝廷/竞功/大明的顶层分类 |
| 律例 | Lvli (rules) | 可审计的规则库 |
| 档籍 | Dangji (archives) | 持久化与索引 |
| 四格八法 | Four-grade Eight-rule | 考核劣汰标准 |
| WeightRegistry | WeightRegistry | 跨任务权重记录（技术名，军功簿/考绩簿的统一核心接口名） |
| 费率表 | PricingTable | Cost 派生接口，核心记原始 tokens，cost 由 computeCost(tokens,model) 计算 |
| 入口适配器 | EntryAdapter | 入口层适配接口，adapt(RawInput)→InternalCommand |
| 预算分配器 | BudgetAllocator | 派发预算分配接口，Phase 1 均分，Phase 2+ 接入 WeightRegistry 加权 |
| 状态验证器 | StateValidator | sessionStateSchema Zod 校验接口 |
| 运行时配置 | OrbitaConfig | 璇玑运行时参数接口，Phase 2+ 可配置硬编码值 |
| 均分分配器 | EvenSplitAllocator | BudgetAllocator 的 Phase 1 实现（tokens/cost 均分） |
| 并发策略 | ConcurrencyPolicy | 并发上限动态调整接口，Phase 3 基于负载计算 max |
| EventSourcedState | EventSourcedState | 事件溯源状态 |
| CaseLibrary | CaseLibrary | 案例库/则例库，审计经验记录存储（Phase 2+ Infrastructure） |
| ChiefCheckReport | ChiefCheckReport | 总监督产出，汇总报告（overallPassed/taskSummaries/planAlignment） |
| SubCheckReport | SubCheckReport | 子监督产出，单个检查报告（taskId/passed/summary/issues） |
| ReviewVerdict | ReviewVerdict | 复核 Agent 产出（verdict: pass/abort/adjust + reasoning） |
| TaskRecord | TaskRecord | 审计 Agent 经验记录（taskSummary/approach/outcome/cost/tags） |
| ExecutionPlan | ExecutionPlan | 规划 Agent 产出（reasoning/steps/estimatedCost/riskLevel） |

| 上下文屏障引擎 | CheckAgent | 所有监督角色共用的压缩屏障+通信引擎（06 §3a） |
| 覆奏 | ProgressReport | 执行过程中向上报告进度（06 §3a.4） |
| 塘报急递 | TangbaoExpress | 紧急通道——执行受阻时不排队直报（06 §3a.5） |
| 密奏 | SecretMemo | 密奏通道——绕过中间层直达主 Agent（06 §3a.5） |
| 层层筛选 | LayeredFiltering | 小事消化大事上报——每层压缩+筛选（06 §3a.6） |
---

> 文档版本：v1.7
> 本版变更（累积最近 3 条，最新在上）：
>   - v1.7：项目更名 wuwo→璇玑（ORBITA）：新增品牌词条，全文品牌替换（见决策 146）
>   - v1.5：新增5个监督通信术语（CheckAgent/覆奏/塘报急递/密奏/层层筛选）
> 基于：璇玑 v4 全 29 份文档术语扫描
> 决策总数：139 条
> 文档总数：29 份
> 原则总数：33 条
