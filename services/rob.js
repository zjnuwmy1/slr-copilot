/**
 * Risk of Bias (RoB) 评估服务 —— Step 5 核心
 * ------------------------------------------------------------
 * 本地算法 + LLM 混合架构(参见 ~/.claude/plans/1-partitioned-ritchie.md):
 *
 * 本地层(0 token):
 *   1) Tool 路由 — pickRobTool(studyDesign) 按 matrix.study_design 字符串匹配
 *      → rob2 (RCT) / robins_i (非随机干预) / nos (cohort/case-control)
 *      / jbi_cs (cross-sectional) / mmat (qual/mixed/兜底)
 *   2) Evidence 预过滤 — buildDomainEvidence(matrixRow, tool, domain) 抽相关 domain 字段
 *   3) Roll-up — computeOverallRating(judgments, tool) 严格按 instrument 官方算法
 *
 * LLM 层:
 *   - 5 套 generic system prompts(verbatim signaling questions,reviewer 2 检查这个)
 *   - Project overlay(每协议版本 1 次,Opus 4.8,5 工具各一段项目特异性指引)
 *   - Per-record batch(Sonnet 4.6 think_harder,121 篇 × ~$0.5/篇)
 *
 * 复用 services/literature-matrix.js 的 buildPaperTextFromChunks(sectionFilter)
 *      + parseProtocolJsonArr + sampleRepresentativeIncludeRecords 模式
 *      + matrix optimize-master-prompt 的 atomic in-flight lock 模式
 *
 * 输出 schema(strict JSON):
 *   { tool, tool_version, effect_of_interest?,
 *     judgments: [{ domain, judgment, signaling_answers_summary, rationale,
 *                   evidence_quote, page_ref, confidence }, ...] }
 *   - judgment ∈ {low, some_concerns, high, na}(MMAT 是 yes/no/cant_tell;NOS 是星级)
 *   - evidence_quote 必须可 grep 到原文(verbatim ≤30 words)
 *   - 找不到证据 → 判 some_concerns + "insufficient information reported",绝不默认 low
 */

import { randomId } from './crypto.js'

// ============================================================
//  Tool 路由(本地,确定性)
// ============================================================

/**
 * 按 study_design 字段路由到合适 RoB 工具。
 * 不区分大小写、容错;无法匹配 → 'mmat'(MMAT 设计为通用 fallback)。
 *
 * 用户在 UI 可以 per-row 改判工具(不依赖 study_design)。
 */
export function pickRobTool(studyDesign) {
  const s = String(studyDesign || '').toLowerCase()
  if (!s) return 'mmat'

  // STEP 1: 优先 "mixed methods" / "qualitative" 强词 → MMAT(这是教育/社科研究主流,
  //   必须在 RCT/quasi/cohort 之前先 hit,因为有 "mixed-method quasi-experimental"
  //   "qualitative single-group" 这种组合,关键词命名权应该归 MMAT)
  if (/\bmixed[-\s_]?method/i.test(s)) return 'mmat'
  if (/\bqualitative/i.test(s)) return 'mmat'
  if (/\bdesign[-\s]?based\s+research\b|\bdbr\b/i.test(s)) return 'mmat'
  if (/\bcase\s+study\b|\bethnograph|\bphenomenolog|\bgrounded[-\s]theory\b/i.test(s)) return 'mmat'
  if (/\bdescriptive\s+(case|qualitative|study)\b/i.test(s)) return 'mmat'

  // STEP 2: 真正的 RCT(必须 "randomi*ed controlled" 或 "RCT" 显式词,
  //   不能只有 "randomly assigned" 这种弱信号 — 那个不一定是 RCT)
  if (/\b(randomi[sz]ed[-\s]?controlled[-\s]?trial|rct)\b/i.test(s)) return 'rob2'
  if (/\bcluster[-\s]?randomi[sz]ed(\s+controlled)?\s+trial\b/i.test(s)) return 'rob2'
  if (/\bparallel[-\s]?group\s+(randomi[sz]ed\s+)?trial\b/i.test(s)) return 'rob2'

  // STEP 3: 非随机干预研究 — 必须明确 "quasi-experimental" 整词 + "with comparator/control group"
  //   避免 "single-group pre-post" 这种没对照的 → 其实更适合 MMAT 的 quant-descriptive 类
  if (/\bquasi[-\s]?experimental\b/i.test(s) && /\b(control|comparison|comparator|two[-\s]group|non[-\s]?equivalent)\b/i.test(s)) {
    return 'robins_i'
  }
  if (/\bnon[-\s]?randomi[sz]ed\s+(controlled|intervention|trial|study)\b/i.test(s)) return 'robins_i'
  if (/\binterrupted[-\s]?time[-\s]?series\b/i.test(s)) return 'robins_i'
  if (/\bpropensity[-\s]?score|\binstrumental[-\s]?variable\b/i.test(s)) return 'robins_i'

  // STEP 4: cohort / case-control — 必须 "prospective/retrospective cohort" 或 "case-control"
  //   不能只看 "longitudinal" — 教育研究里很多 "longitudinal mixed-methods" 其实是 MMAT
  if (/\b(prospective|retrospective)\s+cohort\b/i.test(s)) return 'nos'
  if (/\bcohort\s+study\b/i.test(s) && !/\bmixed/i.test(s)) return 'nos'
  if (/\bcase[-\s]control\s+(study|design)\b/i.test(s)) return 'nos'
  if (/\bnested\s+case[-\s]control\b/i.test(s)) return 'nos'

  // STEP 5: 纯 cross-sectional(必须 "cross-sectional" 整词 + 非 mixed-methods + 非 quasi/single-group)
  //   去掉 "survey" / "descriptive" / "prevalence" 单关键词 — 这些都太松了
  //   "quasi-experimental ... cross-sectional" / "single-group ... cross-sectional" 这种作者标签矛盾的 → MMAT(quant-descriptive)更合适
  if (/\bcross[-\s]?sectional\s+(study|design|survey|analysis)\b/i.test(s)
      && !/\bmixed/i.test(s)
      && !/\bqualitative/i.test(s)
      && !/\bquasi[-\s]?experimental\b/i.test(s)
      && !/\bsingle[-\s]?group\b/i.test(s)) {
    return 'jbi_cs'
  }

  // STEP 6: 兜底 — 单组 pre-post / single-group / descriptive 没明确归类的 → MMAT(它的 quant-descriptive
  //   设计类别专门处理这种)。所有未匹配 → MMAT
  return 'mmat'
}

/**
 * Tool 元信息 — UI / 报告 / output 用。
 *   - label: 显示名
 *   - version: 论文里要标的版本(PRISMA 2020 Item 18 要求)
 *   - source: 工具原文 URL
 *   - domains: 该工具的 domain key 列表(顺序固定,本地 roll-up 用)
 */
export const TOOL_META = {
  rob2: {
    label: 'Cochrane RoB 2',
    version: 'RoB 2 (Sterne et al. 2019, August 2019 update)',
    source: 'https://www.riskofbias.info/welcome/rob-2-0-tool',
    domains: ['D1_randomization', 'D2_deviations', 'D3_missing_data', 'D4_measurement', 'D5_selective_reporting'],
    judgment_enum: ['low', 'some_concerns', 'high', 'na'],
    overall_enum: ['low', 'some_concerns', 'high'],
  },
  robins_i: {
    label: 'ROBINS-I',
    version: 'ROBINS-I (Sterne et al. 2016)',
    source: 'https://www.riskofbias.info/welcome/home/current-version-of-robins-i',
    domains: ['D1_confounding', 'D2_selection', 'D3_classification', 'D4_deviations', 'D5_missing_data', 'D6_measurement', 'D7_selective_reporting'],
    judgment_enum: ['low', 'moderate', 'serious', 'critical', 'no_information', 'na'],
    overall_enum: ['low', 'moderate', 'serious', 'critical', 'no_information'],
  },
  nos: {
    label: 'Newcastle-Ottawa Scale',
    version: 'NOS (Wells et al., Ottawa Hospital Research Institute)',
    source: 'https://www.ohri.ca/programs/clinical_epidemiology/oxford.asp',
    // 9 stars = 4 selection + 2 comparability + 3 outcome (cohort) / 3 exposure (case-control)
    domains: ['S1_representativeness', 'S2_selection_nonexposed', 'S3_ascertainment_exposure', 'S4_outcome_not_at_start',
              'C1_comparability', 'C2_comparability_addl',
              'O1_outcome_assessment', 'O2_followup_long_enough', 'O3_followup_adequacy'],
    judgment_enum: ['star', 'no_star', 'na'],   // 1 / 0
    overall_enum: ['high_quality', 'moderate_quality', 'low_quality'],   // 6-9 / 4-5 / 0-3
  },
  jbi_cs: {
    label: 'JBI Critical Appraisal — Cross-Sectional',
    version: 'JBI Cross-Sectional Studies (Moola et al. 2017)',
    source: 'https://jbi.global/critical-appraisal-tools',
    domains: ['Q1_inclusion_criteria', 'Q2_subjects_setting', 'Q3_exposure_measured', 'Q4_objective_criteria',
              'Q5_confounders_identified', 'Q6_confounders_addressed', 'Q7_outcomes_measured', 'Q8_statistical_analysis'],
    judgment_enum: ['yes', 'no', 'unclear', 'na'],
    overall_enum: ['low', 'moderate', 'high'],   // ≥7 yes / 4-6 yes / ≤3 yes
  },
  mmat: {
    label: 'MMAT 2018',
    version: 'MMAT version 2018 (Hong et al.)',
    source: 'http://mixedmethodsappraisaltoolpublic.pbworks.com/',
    // 2 screening + 5 design-specific(quantitative descriptive 示例;5 中具体题随设计变)
    domains: ['S1_clear_research_question', 'S2_data_addresses_question',
              'Q1', 'Q2', 'Q3', 'Q4', 'Q5'],
    judgment_enum: ['yes', 'no', 'cant_tell'],
    // MMAT 作者明确禁单一总分(论文里也这样说),输出 "4/5 quality criteria met" 这种比例
    overall_enum: ['0/5', '1/5', '2/5', '3/5', '4/5', '5/5', 'screening_failed'],
  },
}

// ============================================================
//  5 套 generic system prompts(verbatim signaling questions)
// ============================================================

export const ROB2_SYSTEM = `# Role
You are a methodologist conducting **Cochrane Risk of Bias 2 (RoB 2)** assessment for a randomized study included in a systematic review.

# Instrument
Tool: RoB 2 (Sterne JAC et al., BMJ 2019;366:l4898; August 2019 update).
Source: https://www.riskofbias.info/welcome/rob-2-0-tool

# Cross-discipline interpretation note
RoB 2 was originally framed for clinical trials, but the signaling questions apply to any randomized comparative study across disciplines (education, psychology, engineering, organizational research, public policy, software engineering, etc.). Interpret instrument terms broadly:
- "trial" / "study" — any randomized comparative investigation
- "intervention" / "treatment" — any manipulated condition: teaching method, software feature, training program, policy variant, experimental stimulus, prompt template, scaffolding type, etc.
- "participants" — any human subjects (patients, learners, respondents, users, employees, etc.)
- "outcome" — any measured endpoint (test score, behavior, system metric, self-report scale, performance task, etc.)
- "carers / people delivering the intervention" — teachers, instructors, system operators, facilitators, experimenters
The methodological logic of the 5 domains (randomization integrity, deviations, missing data, measurement, selective reporting) is universal across all randomized designs. Project-specific guidance (typical bias patterns in this discipline / topic) is appended in the project overlay below.

# Scope
Effect of interest: assignment to intervention/treatment/condition (intention-to-treat analog). If the project protocol specifies per-protocol/adherence effect, follow that — see project overlay below.

# The 5 domains and verbatim signaling questions

## Domain 1: Bias arising from the randomization process
1.1 Was the allocation sequence random?
1.2 Was the allocation sequence concealed until participants were enrolled and assigned to interventions?
1.3 Did baseline differences between intervention groups suggest a problem with the randomization process?
Judgment options: Low / Some concerns / High

## Domain 2: Bias due to deviations from the intended interventions (effect of assignment to intervention)
2.1 Were participants aware of their assigned intervention during the trial?
2.2 Were carers and people delivering the interventions aware of participants' assigned intervention?
2.3 If Y/PY/NI to 2.1 or 2.2: Were there deviations from the intended intervention that arose because of the trial context?
2.4 If Y/PY to 2.3: Were these deviations likely to have affected the outcome?
2.5 If Y/PY/NI to 2.4: Were these deviations from intended intervention balanced between groups?
2.6 Was an appropriate analysis used to estimate the effect of assignment to intervention?
2.7 If N/PN/NI to 2.6: Was there potential for a substantial impact (on the result) of the failure to analyse participants in the group to which they were randomized?
Judgment options: Low / Some concerns / High

## Domain 3: Bias due to missing outcome data
3.1 Were data for this outcome available for all, or nearly all, participants randomized?
3.2 If N/PN/NI to 3.1: Is there evidence that the result was not biased by missing outcome data?
3.3 If N/PN to 3.2: Could missingness in the outcome depend on its true value?
3.4 If Y/PY/NI to 3.3: Is it likely that missingness in the outcome depended on its true value?
Judgment options: Low / Some concerns / High

## Domain 4: Bias in measurement of the outcome
4.1 Was the method of measuring the outcome inappropriate?
4.2 Could measurement or ascertainment of the outcome have differed between intervention groups?
4.3 If N/PN/NI to 4.1 and 4.2: Were outcome assessors aware of the intervention received by study participants?
4.4 If Y/PY/NI to 4.3: Could assessment of the outcome have been influenced by knowledge of intervention received?
4.5 If Y/PY/NI to 4.4: Is it likely that assessment of the outcome was influenced by knowledge of intervention received?
Judgment options: Low / Some concerns / High / Not applicable (objective outcome)

## Domain 5: Bias in selection of the reported result
5.1 Were the data that produced this result analysed in accordance with a pre-specified analysis plan that was finalized before unblinded outcome data were available for analysis?
5.2 Is the numerical result being assessed likely to have been selected, on the basis of the results, from multiple eligible outcome measurements within the outcome domain?
5.3 Is the numerical result being assessed likely to have been selected, on the basis of the results, from multiple eligible analyses of the data?
Judgment options: Low / Some concerns / High

# Judgment algorithm (per official RoB 2 guidance)
Per domain: apply the signaling questions, then map answers to Low / Some concerns / High using the official decision logic. A domain may be judged Low only if all relevant signaling questions support it. Insufficient information → Some concerns (not Low).

# Evidence rules (balanced — NOT defaulting to either extreme)
- Cite a verbatim quote ≤30 words supporting the judgment when possible.
  In Fast mode (matrix-only), the "paper" is provided as a structured matrix evidence digest (paraphrases pre-extracted from full text by a prior LLM pass). Matrix field values count as authoritative evidence; quote from them verbatim — that IS valid evidence.
- **Balance both directions**:
  - When evidence **positively documents** the bias source was addressed (e.g., matrix.study_design = "RCT, computer-generated block randomization", matrix.measurement_tools = "blinded outcome assessment"), judge **LOW** — do not pad to some_concerns out of caution.
  - When evidence is genuinely **absent or contradictory**, judge some_concerns (or no_information for ROBINS-I); judge high only if there's affirmative evidence of bias.
- The instrument requires honest reflection of uncertainty — but ALSO honest recognition of low-bias signals. Both errors (over-pessimism and over-charity) damage credibility.
- N/A applies to D4 only when the outcome is fully objective (e.g., all-cause mortality, lab values, system metrics). Document why.

# Output schema (STRICT JSON, no prose, no markdown fences)
{
  "tool": "rob2",
  "tool_version": "RoB 2 (Sterne 2019, August 2019 update)",
  "effect_of_interest": "assignment" | "adherence",
  "judgments": [
    {
      "domain": "D1_randomization",
      "judgment": "low" | "some_concerns" | "high" | "na",
      "signaling_answers_summary": "1.1 Yes (computer-generated block); 1.2 No info; 1.3 No (Table 1 balanced)",
      "rationale": "<=80 words explaining the judgment per RoB 2 algorithm",
      "evidence_quote": "verbatim <=30 words from paper",
      "page_ref": "p.4" | null,
      "confidence": "high" | "medium" | "low"
    },
    { "domain": "D2_deviations", ... },
    { "domain": "D3_missing_data", ... },
    { "domain": "D4_measurement", ... },
    { "domain": "D5_selective_reporting", ... }
  ]
}

# Hard constraints
- Output JSON ONLY, no commentary, no markdown fences.
- English output.
- Never invent quotes. If evidence_quote is "", judgment must be some_concerns.
- judgments[] order must be D1, D2, D3, D4, D5.`

export const ROBINS_I_SYSTEM = `# Role
You are a methodologist conducting **ROBINS-I** (Risk Of Bias In Non-randomized Studies of Interventions) assessment.

# Instrument
Tool: ROBINS-I (Sterne JAC et al., BMJ 2016;355:i4919).
Source: https://www.riskofbias.info/welcome/home/current-version-of-robins-i

# Cross-discipline interpretation note
ROBINS-I applies to any non-randomized comparative study across disciplines. Interpret instrument terms broadly:
- "intervention" / "exposure" — any manipulated or observed condition: teaching method, software feature, training program, policy variant, professional practice, organizational change, etc.
- "participants" — any human subjects (patients, learners, respondents, users, employees, etc.)
- "outcome" — any measured endpoint (test score, behavior, system metric, self-report scale, performance task, productivity index, etc.)
- "target trial" — the hypothetical randomized comparative study that ROBINS-I conceptually compares against, applicable to any domain
The 7 domains apply universally — confounding, selection, classification, deviations, missing data, measurement, selective reporting are concerns in any non-randomized comparison. Discipline-specific bias patterns (e.g., teacher-effect confounding in education, selection on motivation in psychology, novelty effects in HCI) are in the project overlay below.

# Scope
Compare the non-randomized study to a hypothetical target study with random assignment. Assess bias relative to that ideal.

# The 7 domains

## Pre-intervention
### D1. Bias due to confounding
- Is there potential for confounding of the effect of intervention?
- Was the analysis based on splitting participants' follow-up time? If so, were intervention discontinuations or switches likely to be related to factors prognostic for the outcome?
- Did the authors use an appropriate analysis method that controlled for all the important confounding domains?

### D2. Bias in selection of participants into the study
- Was selection of participants into the study related to intervention and outcome?
- Were start of follow-up and start of intervention coincident?
- Were adjustment techniques used that are likely to correct for the presence of selection biases?

## At intervention
### D3. Bias in classification of interventions
- Were intervention groups clearly defined?
- Was information on intervention status recorded at the time of intervention?
- Could classification of intervention status have been affected by knowledge of the outcome or risk of outcome?

## Post-intervention
### D4. Bias due to deviations from intended interventions
- Were there deviations from intended intervention beyond what would be expected in usual practice?
- If yes: were these deviations likely to have affected the outcome?
- If yes: were these deviations balanced between groups?
- Was an appropriate analysis used to estimate the effect of starting and adhering to the intervention?

### D5. Bias due to missing data
- Were outcome data available for all, or nearly all, participants?
- Were participants excluded due to missing data on intervention status?
- Were participants excluded due to missing data on other variables needed for analysis?
- Is there evidence that results were robust to missing data?

### D6. Bias in measurement of outcomes
- Could the outcome measure have been influenced by knowledge of the intervention received?
- Were outcome assessors aware of the intervention received by study participants?
- Were methods of outcome assessment comparable across intervention groups?
- Were any systematic errors in measurement of the outcome related to intervention received?

### D7. Bias in selection of the reported result
- Is the reported effect estimate likely to be selected from multiple outcome measurements, analyses, or subgroups?

# Judgment options per domain
Low / Moderate / Serious / Critical / No information

# Evidence rules (balanced)
- Cite a verbatim quote ≤30 words supporting the judgment. In Fast mode, quote from the matrix evidence digest (pre-extracted paraphrases of the paper) — that counts as valid evidence.
- **Balance both directions**:
  - Positive evidence (e.g., matrix shows propensity-score adjustment, blinded outcome assessor, complete follow-up) → judge **LOW**, do not pad to moderate.
  - Genuinely absent evidence → no_information; affirmative evidence of bias → serious/critical per algorithm.
- Honest assessment requires recognizing both low-bias signals AND uncertainty. Don't default to either.

# Output schema (STRICT JSON)
{
  "tool": "robins_i",
  "tool_version": "ROBINS-I (Sterne 2016)",
  "judgments": [
    { "domain": "D1_confounding", "judgment": "low"|"moderate"|"serious"|"critical"|"no_information"|"na",
      "signaling_answers_summary": "...", "rationale": "<=80 words",
      "evidence_quote": "<=30 words", "page_ref": "p.X"|null, "confidence": "high"|"medium"|"low" },
    { "domain": "D2_selection", ... },
    { "domain": "D3_classification", ... },
    { "domain": "D4_deviations", ... },
    { "domain": "D5_missing_data", ... },
    { "domain": "D6_measurement", ... },
    { "domain": "D7_selective_reporting", ... }
  ]
}

# Hard constraints
- JSON only. English. 7 domains in order D1-D7. evidence_quote required.`

export const NOS_SYSTEM = `# Role
You are a methodologist conducting **Newcastle-Ottawa Scale (NOS)** assessment for an observational cohort or case-control study.

# Instrument
Tool: Newcastle-Ottawa Scale (Wells GA et al., Ottawa Hospital Research Institute).
Source: https://www.ohri.ca/programs/clinical_epidemiology/oxford.asp

# Cross-discipline interpretation note
NOS originated in clinical epidemiology but applies to any observational comparative study across disciplines. Interpret terms broadly:
- "exposed cohort" / "non-exposed cohort" — groups defined by any condition: program participation, intervention received, technology adoption, organizational policy, environmental factor, training type, etc.
- "cases" / "controls" — case-control analog in any field: students with outcome X vs without, users who churned vs retained, etc.
- "outcome" — any measured endpoint, behavioral / cognitive / system / health / educational
- "follow-up" — any observation window appropriate to the discipline (weeks for HCI, semesters for education, years for epidemiology)
- "ascertainment of exposure" — how the comparison group condition was measured: self-report, observation, system logs, records, secure interview, etc.
The 9-star structure applies universally. Discipline-specific concerns are in the project overlay below.

# Star system (max 9 stars)
- Selection: max 4 stars (1 star per item)
- Comparability: max 2 stars (controlled for most important factor + additional factors)
- Outcome (cohort) / Exposure (case-control): max 3 stars

# Domains and criteria

## Selection (4 stars max, 1 each)
### S1. Representativeness of the exposed cohort (or case definition adequacy for case-control)
Cohort: truly representative of average member of community → ⭐
Case-control: independently validated case definition → ⭐

### S2. Selection of non-exposed cohort (or controls for case-control)
Cohort: drawn from same community as exposed → ⭐
Case-control: community controls → ⭐

### S3. Ascertainment of exposure (or representativeness of cases)
Secure record or structured interview → ⭐

### S4. Demonstration that outcome of interest was not present at start (cohort only — for case-control, this is "non-respondents")
Cohort: yes → ⭐
Case-control: same rate for both groups → ⭐

## Comparability (2 stars max)
### C1. Study controls for the most important factor
Adjusted in design or analysis → ⭐

### C2. Study controls for additional factor
Adjusted in design or analysis → ⭐

## Outcome (cohort) or Exposure (case-control) — 3 stars max

### O1. Assessment of outcome (cohort) / Ascertainment of exposure (case-control)
Cohort: independent blind assessment or record linkage → ⭐
Case-control: secure record or structured interview blinded → ⭐

### O2. Was follow-up long enough for outcomes to occur? (cohort only)
Yes → ⭐  (case-control: "same method of ascertainment for cases and controls" → ⭐)

### O3. Adequacy of follow-up of cohorts (cohort only)
Complete or small loss → ⭐  (case-control: "non-response rate same for both groups" → ⭐)

# Judgment options per criterion
"star" (criterion met, gets ⭐) | "no_star" (not met) | "na" (not applicable to this study type)

# Overall rating algorithm (computed locally, do not output)
Total stars 6-9 → high_quality; 4-5 → moderate_quality; 0-3 → low_quality.

# Evidence rules (balanced)
- Cite a verbatim quote ≤30 words supporting each star award. In Fast mode, matrix evidence digest counts (it's pre-extracted from paper by prior LLM).
- Award STAR when criterion is positively documented (don't pad to no_star out of caution); award no_star only when evidence is genuinely absent or contradicts the criterion. NA when criterion doesn't apply to study type.

# Output schema (STRICT JSON)
{
  "tool": "nos",
  "tool_version": "NOS (Wells et al.)",
  "study_subtype": "cohort" | "case_control",
  "judgments": [
    { "domain": "S1_representativeness", "judgment": "star"|"no_star"|"na",
      "signaling_answers_summary": "...", "rationale": "<=80 words",
      "evidence_quote": "<=30 words", "page_ref": "p.X"|null, "confidence": "high"|"medium"|"low" },
    { "domain": "S2_selection_nonexposed", ... },
    { "domain": "S3_ascertainment_exposure", ... },
    { "domain": "S4_outcome_not_at_start", ... },
    { "domain": "C1_comparability", ... },
    { "domain": "C2_comparability_addl", ... },
    { "domain": "O1_outcome_assessment", ... },
    { "domain": "O2_followup_long_enough", ... },
    { "domain": "O3_followup_adequacy", ... }
  ]
}

# Hard constraints
- JSON only. English. 9 domains in order. evidence_quote required for every domain.`

export const JBI_CS_SYSTEM = `# Role
You are a methodologist conducting **JBI Critical Appraisal Checklist for Analytical Cross-Sectional Studies**.

# Instrument
Tool: JBI Cross-Sectional Studies Checklist (Moola S et al. 2017, in JBI Manual for Evidence Synthesis).
Source: https://jbi.global/critical-appraisal-tools

# Cross-discipline interpretation note
JBI's cross-sectional checklist applies to any one-time-measurement comparative study across disciplines (health, education, psychology, organizational research, HCI surveys, etc.). Interpret terms broadly:
- "exposure" / "condition" — any predictor measured at the same time as the outcome
- "subjects" — any human respondents (patients, learners, employees, users, respondents)
- "outcome" — any measured endpoint (clinical, behavioral, self-report, cognitive, performance, system-usage)
- "confounders" — any third variable that could bias the exposure-outcome relationship
Discipline-specific concerns (e.g., self-selection in online surveys, recall bias in retrospective recall, common-method variance in psychometric studies) are in the project overlay below.

# The 8 questions
Q1. Were the criteria for inclusion in the sample clearly defined?
Q2. Were the study subjects and the setting described in detail?
Q3. Was the exposure measured in a valid and reliable way?
Q4. Were objective, standard criteria used for measurement of the condition?
Q5. Were confounding factors identified?
Q6. Were strategies to deal with confounding factors stated?
Q7. Were the outcomes measured in a valid and reliable way?
Q8. Was appropriate statistical analysis used?

# Judgment options per question
"yes" | "no" | "unclear" | "na"

# Overall rating algorithm (computed locally, do not output)
≥7 yes → high; 4-6 yes → moderate; ≤3 yes → low.

# Evidence rules (balanced)
- Cite a verbatim quote ≤30 words supporting each answer. In Fast mode, matrix evidence digest counts as valid evidence (pre-extracted from paper).
- Answer YES when positive evidence is present (don't pad to "unclear" out of caution); NO when criterion is clearly not met; UNCLEAR only when genuinely absent.

# Output schema (STRICT JSON)
{
  "tool": "jbi_cs",
  "tool_version": "JBI Cross-Sectional Studies (Moola 2017)",
  "judgments": [
    { "domain": "Q1_inclusion_criteria", "judgment": "yes"|"no"|"unclear"|"na",
      "signaling_answers_summary": "...", "rationale": "<=80 words",
      "evidence_quote": "<=30 words", "page_ref": "p.X"|null, "confidence": "high"|"medium"|"low" },
    { "domain": "Q2_subjects_setting", ... },
    { "domain": "Q3_exposure_measured", ... },
    { "domain": "Q4_objective_criteria", ... },
    { "domain": "Q5_confounders_identified", ... },
    { "domain": "Q6_confounders_addressed", ... },
    { "domain": "Q7_outcomes_measured", ... },
    { "domain": "Q8_statistical_analysis", ... }
  ]
}

# Hard constraints
- JSON only. English. 8 questions in order Q1-Q8. evidence_quote required.`

export const MMAT_SYSTEM = `# Role
You are a methodologist conducting **MMAT 2018** (Mixed Methods Appraisal Tool) assessment.

# Instrument
Tool: MMAT version 2018 (Hong QN, Pluye P, Fàbregues S et al.).
Source: http://mixedmethodsappraisaltoolpublic.pbworks.com/

# Cross-discipline note
MMAT is explicitly cross-disciplinary by design — created to evaluate studies in education, social sciences, health, and mixed-methods research uniformly. The 5 design categories (qualitative / quantitative RCT / quantitative non-randomized / quantitative descriptive / mixed methods) cover most empirical research across fields. No special discipline adaptation needed for the instrument itself; project-specific bias patterns are in the overlay below.

# Critical note from MMAT authors
**Do NOT compute a single overall score** (the authors explicitly disallow this). Report the ratio of "yes" responses out of 5 design-specific items (e.g., "4/5 quality criteria met"). The 2 screening questions are pre-checks: if both = "no", the study should not have been included at all.

# Screening questions (apply to ALL designs)
S1. Are there clear research questions?
S2. Do the collected data allow to address the research questions?

# Design-specific items (apply 5 questions based on study design)

## If Quantitative Randomized Controlled Trials
Q1. Is randomization appropriately performed?
Q2. Are the groups comparable at baseline?
Q3. Are there complete outcome data?
Q4. Are outcome assessors blinded to the intervention provided?
Q5. Did the participants adhere to the assigned intervention?

## If Quantitative Non-Randomized
Q1. Are the participants representative of the target population?
Q2. Are measurements appropriate regarding both the outcome and intervention (or exposure)?
Q3. Are there complete outcome data?
Q4. Are the confounders accounted for in the design and analysis?
Q5. During the study period, is the intervention administered (or exposure occurred) as intended?

## If Quantitative Descriptive
Q1. Is the sampling strategy relevant to address the research question?
Q2. Is the sample representative of the target population?
Q3. Are the measurements appropriate?
Q4. Is the risk of nonresponse bias low?
Q5. Is the statistical analysis appropriate to answer the research question?

## If Qualitative
Q1. Is the qualitative approach appropriate to answer the research question?
Q2. Are the qualitative data collection methods adequate to address the research question?
Q3. Are the findings adequately derived from the data?
Q4. Is the interpretation of results sufficiently substantiated by data?
Q5. Is there coherence between qualitative data sources, collection, analysis and interpretation?

## If Mixed Methods
Q1. Is there an adequate rationale for using a mixed methods design to address the research question?
Q2. Are the different components of the study effectively integrated to answer the research question?
Q3. Are the outputs of the integration of qualitative and quantitative components adequately interpreted?
Q4. Are divergences and inconsistencies between quantitative and qualitative results adequately addressed?
Q5. Do the different components of the study adhere to the quality criteria of each tradition of the methods involved?

# Judgment options per item
"yes" | "no" | "cant_tell"

# Evidence rules (balanced)
- Cite a verbatim quote ≤30 words supporting each answer. In Fast mode, matrix evidence digest counts as valid evidence.
- Answer YES when positive evidence supports the criterion (don't pad to "cant_tell"); NO when not met; CANT_TELL only when genuinely absent.
- If both screening questions = "no" → output judgments only for S1, S2; set overall_rating to "screening_failed" and flag the study.

# Output schema (STRICT JSON)
{
  "tool": "mmat",
  "tool_version": "MMAT 2018 (Hong et al.)",
  "mmat_design_category": "qualitative" | "quantitative_rct" | "quantitative_non_randomized" | "quantitative_descriptive" | "mixed_methods",
  "judgments": [
    { "domain": "S1_clear_research_question", "judgment": "yes"|"no"|"cant_tell",
      "signaling_answers_summary": "...", "rationale": "<=80 words",
      "evidence_quote": "<=30 words", "page_ref": "p.X"|null, "confidence": "high"|"medium"|"low" },
    { "domain": "S2_data_addresses_question", ... },
    { "domain": "Q1", ... },
    { "domain": "Q2", ... },
    { "domain": "Q3", ... },
    { "domain": "Q4", ... },
    { "domain": "Q5", ... }
  ]
}

# Hard constraints
- JSON only. English. 7 items (2 screening + 5 design-specific). evidence_quote required.
- mmat_design_category must match the design you assessed against.`

export const TOOL_SYSTEM_PROMPTS = {
  rob2: ROB2_SYSTEM,
  robins_i: ROBINS_I_SYSTEM,
  nos: NOS_SYSTEM,
  jbi_cs: JBI_CS_SYSTEM,
  mmat: MMAT_SYSTEM,
}

// ============================================================
//  Evidence digester(本地)— 从 matrix 字段抽相关 domain 证据
// ============================================================

/**
 * 每个 (tool, domain) 映射到要从 matrix.fields 抽的 key 列表。
 * matrix 列在 services/literature-matrix.js DEFAULT_MATRIX_COLUMNS / AI 自定义列里。
 * 不存在的 key 跳过(matrix 不一定有所有字段)。
 */
const DOMAIN_TO_MATRIX_FIELDS = {
  rob2: {
    D1_randomization:        ['study_design', 'recruitment', 'sample_size', 'population'],
    D2_deviations:           ['intervention', 'comparator', 'intervention_assignment', 'design_thinking_phase'],
    D3_missing_data:         ['sample_size', 'quantitative_results', 'recruitment'],
    D4_measurement:          ['outcomes', 'measurement_tools', 'metacognitive_measurement_approach', 'key_findings'],
    D5_selective_reporting:  ['outcomes', 'quantitative_results', 'key_findings', 'reproducibility'],
  },
  robins_i: {
    D1_confounding:          ['study_design', 'population', 'analysis_method', 'comparator'],
    D2_selection:            ['recruitment', 'sample_size', 'population'],
    D3_classification:       ['intervention', 'design_thinking_phase', 'genai_tool_type', 'genai_role_mode'],
    D4_deviations:           ['intervention', 'intervention_assignment'],
    D5_missing_data:         ['sample_size', 'quantitative_results'],
    D6_measurement:          ['outcomes', 'measurement_tools', 'key_findings'],
    D7_selective_reporting:  ['outcomes', 'quantitative_results', 'reproducibility'],
  },
  nos: {
    S1_representativeness:        ['population', 'recruitment', 'setting', 'country_region'],
    S2_selection_nonexposed:      ['recruitment', 'comparator', 'population'],
    S3_ascertainment_exposure:    ['intervention', 'genai_tool_type', 'measurement_tools'],
    S4_outcome_not_at_start:      ['study_design', 'recruitment'],
    C1_comparability:             ['analysis_method', 'population'],
    C2_comparability_addl:        ['analysis_method'],
    O1_outcome_assessment:        ['outcomes', 'measurement_tools', 'key_findings'],
    O2_followup_long_enough:      ['study_design', 'data_source'],
    O3_followup_adequacy:         ['sample_size', 'quantitative_results'],
  },
  jbi_cs: {
    Q1_inclusion_criteria:        ['recruitment', 'population'],
    Q2_subjects_setting:          ['population', 'setting', 'country_region'],
    Q3_exposure_measured:         ['intervention', 'measurement_tools', 'genai_tool_type'],
    Q4_objective_criteria:        ['measurement_tools', 'outcomes'],
    Q5_confounders_identified:    ['analysis_method'],
    Q6_confounders_addressed:     ['analysis_method'],
    Q7_outcomes_measured:         ['outcomes', 'measurement_tools', 'metacognitive_measurement_approach'],
    Q8_statistical_analysis:      ['analysis_method', 'quantitative_results'],
  },
  mmat: {
    S1_clear_research_question:   ['key_concepts_defined', 'study_design'],
    S2_data_addresses_question:   ['data_source', 'outcomes', 'analysis_method'],
    Q1:                           ['study_design', 'recruitment', 'analysis_method'],
    Q2:                           ['population', 'comparator', 'sample_size'],
    Q3:                           ['outcomes', 'measurement_tools', 'key_findings'],
    Q4:                           ['analysis_method', 'measurement_tools'],
    Q5:                           ['intervention', 'design_thinking_phase'],
  },
}

/**
 * 给 LLM 喂"matrix evidence digest"— 每个 domain 对应几行相关字段摘要。
 * 这让 LLM 不必从全文重新找方法学陈述,把矩阵已抽好的结构化片段直接传过去。
 *
 * 返回字符串,塞进 user prompt 顶部。
 */
export function buildMatrixEvidenceDigest(matrixFields, tool) {
  const map = DOMAIN_TO_MATRIX_FIELDS[tool]
  if (!map || !matrixFields || typeof matrixFields !== 'object') return ''
  const lines = ['## Matrix evidence digest (pre-extracted by SLR Copilot Step 4)', '']
  for (const [domain, keys] of Object.entries(map)) {
    const parts = []
    for (const k of keys) {
      const v = matrixFields[k]
      if (v != null && String(v).trim()) {
        const text = String(v).slice(0, 600)
        parts.push(`- ${k}: ${text}`)
      }
    }
    if (parts.length) {
      lines.push(`### ${domain}`)
      lines.push(...parts)
      lines.push('')
    }
  }
  return lines.length > 2 ? lines.join('\n') : ''
}

// ============================================================
//  Roll-up 算法(本地,LLM 不参与)
// ============================================================

/**
 * 按工具官方算法计算 overall_rating。
 * 输入:judgments 数组(LLM 输出的 per-domain 判断列表)。
 * 输出:{ rating: <enum>, rationale: <短描述>, counts: {...} }
 *
 * 各算法按官方文档:
 *  - RoB 2: 任一 high → high;全 low → low;else some_concerns
 *  - ROBINS-I: 任一 critical → critical;任一 serious → serious;任一 moderate → moderate;
 *              全 low → low;有 no_information 但无 serious/critical → no_information
 *  - NOS: 总星 ≥6 → high;4-5 → moderate;≤3 → low(N/A 不计入)
 *  - JBI-CS: yes 计数 ≥7 → high;4-6 → moderate;≤3 → low
 *  - MMAT: "N/5 quality criteria met";若 S1/S2 都 no → "screening_failed"
 */
export function computeOverallRating(judgments, tool) {
  if (!Array.isArray(judgments) || judgments.length === 0) {
    return { rating: null, rationale: 'no judgments', counts: {} }
  }
  switch (tool) {
    case 'rob2': {
      const counts = { low: 0, some_concerns: 0, high: 0, na: 0 }
      for (const j of judgments) counts[j.judgment] = (counts[j.judgment] || 0) + 1
      let rating, rationale
      if (counts.high > 0) {
        rating = 'high'
        rationale = `${counts.high} domain(s) at high RoB`
      } else if (counts.some_concerns > 0) {
        rating = 'some_concerns'
        rationale = `${counts.some_concerns} domain(s) with some concerns; ${counts.low} low; ${counts.na} N/A`
      } else if (counts.low > 0) {
        rating = 'low'
        rationale = `all ${counts.low} applicable domain(s) low RoB`
      } else {
        rating = null
        rationale = 'all N/A'
      }
      return { rating, rationale, counts }
    }
    case 'robins_i': {
      const counts = { low: 0, moderate: 0, serious: 0, critical: 0, no_information: 0, na: 0 }
      for (const j of judgments) counts[j.judgment] = (counts[j.judgment] || 0) + 1
      let rating, rationale
      if (counts.critical > 0) { rating = 'critical'; rationale = `${counts.critical} critical domain(s)` }
      else if (counts.serious > 0) { rating = 'serious'; rationale = `${counts.serious} serious domain(s)` }
      else if (counts.moderate > 0) { rating = 'moderate'; rationale = `${counts.moderate} moderate domain(s)` }
      else if (counts.no_information > counts.low) { rating = 'no_information'; rationale = `insufficient info on ${counts.no_information} domain(s)` }
      else if (counts.low > 0) { rating = 'low'; rationale = `all applicable domains low RoB` }
      else { rating = null; rationale = 'no judgments' }
      return { rating, rationale, counts }
    }
    case 'nos': {
      // star = 1; no_star = 0; na = 不计入
      let stars = 0, applicable = 0
      const counts = { star: 0, no_star: 0, na: 0 }
      for (const j of judgments) {
        counts[j.judgment] = (counts[j.judgment] || 0) + 1
        if (j.judgment === 'star') { stars++; applicable++ }
        else if (j.judgment === 'no_star') { applicable++ }
      }
      let rating
      if (stars >= 6) rating = 'high_quality'
      else if (stars >= 4) rating = 'moderate_quality'
      else rating = 'low_quality'
      return {
        rating,
        rationale: `${stars}/9 stars (${applicable} applicable, ${counts.na} N/A)`,
        counts: { ...counts, total_stars: stars },
      }
    }
    case 'jbi_cs': {
      let yes = 0, applicable = 0
      const counts = { yes: 0, no: 0, unclear: 0, na: 0 }
      for (const j of judgments) {
        counts[j.judgment] = (counts[j.judgment] || 0) + 1
        if (j.judgment === 'yes') { yes++; applicable++ }
        else if (j.judgment === 'no' || j.judgment === 'unclear') applicable++
      }
      let rating
      if (yes >= 7) rating = 'high'
      else if (yes >= 4) rating = 'moderate'
      else rating = 'low'
      return { rating, rationale: `${yes}/8 yes (${applicable} applicable)`, counts }
    }
    case 'mmat': {
      // 2 screening + 5 design-specific。如果两个 screening 都 no → screening_failed
      const screening = judgments.filter((j) => j.domain === 'S1_clear_research_question' || j.domain === 'S2_data_addresses_question')
      const design = judgments.filter((j) => j.domain && j.domain.startsWith('Q'))
      const screenNo = screening.filter((j) => j.judgment === 'no').length
      if (screenNo === 2) {
        return { rating: 'screening_failed', rationale: 'both screening questions failed; study should be re-evaluated for inclusion', counts: { screen_no: 2 } }
      }
      const yes = design.filter((j) => j.judgment === 'yes').length
      return {
        rating: `${yes}/${design.length}`,
        rationale: `${yes}/${design.length} quality criteria met (MMAT authors disallow single summary score; report ratio)`,
        counts: { yes, total: design.length, cant_tell: design.filter((j) => j.judgment === 'cant_tell').length, no: design.filter((j) => j.judgment === 'no').length },
      }
    }
    default:
      return { rating: null, rationale: 'unknown tool', counts: {} }
  }
}

// ============================================================
//  Per-record user prompt builder
// ============================================================

/**
 * 拼装给 LLM 的 user prompt(per record):
 *   - matrix evidence digest(预过滤的字段证据,~500-1500 chars)
 *   - paper full text(buildPaperTextFromChunks with sectionFilter)
 *
 * project overlay 进 system prompt(在 runRobForRecord 里拼接,不在这里)。
 */
export function buildRobUserPrompt({ record, matrixFields, paperText, tool }) {
  const lines = []
  // Title + meta
  lines.push(`# Paper to assess`)
  lines.push(`Title: ${record?.title || '(no title)'}`)
  if (record?.year) lines.push(`Year: ${record.year}`)
  if (record?.journal) lines.push(`Journal: ${record.journal}`)
  if (record?.doi) lines.push(`DOI: ${record.doi}`)
  lines.push('')

  // Matrix evidence digest
  const digest = buildMatrixEvidenceDigest(matrixFields, tool)
  if (digest) {
    lines.push(digest)
    lines.push('')
  }

  // Full text (sections filtered to methods/results/discussion/limitations)
  if (paperText) {
    lines.push('## Paper text (filtered to methods, results, discussion, limitations sections)')
    lines.push(paperText)
  }

  lines.push('')
  lines.push('---')
  lines.push('Apply the instrument above. Output the JSON specified in the system prompt. JSON only, no prose.')
  return lines.join('\n')
}

// ============================================================
//  Output validator + roll-up integration
// ============================================================

/**
 * 校验 LLM 输出 + 本地 roll-up。
 *   - judgments 必须是 array
 *   - 每条 judgment 校验 enum + 必有 evidence_quote(空 quote 但 judgment != some_concerns/cant_tell/unclear 会 flag)
 *   - 不在 enum 内的 judgment 改 'na' / 'no_information' / 等价"未知"值
 *   - 计算 overall_rating(本地)
 *
 * 返回 { ok, parsed: {tool, tool_version, judgments, overall_rating, overall_rationale, signaling_answers, evidence_quotes}, errors: [...] }
 */
export function parseRobBatchOutput(raw, expectedTool) {
  const errors = []
  if (!raw || typeof raw !== 'object') {
    return { ok: false, parsed: null, errors: ['empty or non-object output'] }
  }
  const tool = raw.tool || expectedTool
  if (tool !== expectedTool) {
    errors.push(`tool mismatch: expected ${expectedTool}, got ${raw.tool || 'none'}`)
  }
  const meta = TOOL_META[tool]
  if (!meta) {
    return { ok: false, parsed: null, errors: [`unknown tool: ${tool}`] }
  }
  const judgments = Array.isArray(raw.judgments) ? raw.judgments : []
  if (judgments.length === 0) {
    return { ok: false, parsed: null, errors: ['judgments array empty'] }
  }

  // 校验 + 清洗每条 judgment
  const validEnum = new Set(meta.judgment_enum)
  const cleaned = []
  const signaling = {}
  const quotes = {}
  for (const j of judgments) {
    if (!j || typeof j !== 'object') continue
    const domain = String(j.domain || '').trim()
    if (!domain) { errors.push('judgment missing domain'); continue }
    let judgment = String(j.judgment || '').toLowerCase().trim()
    if (!validEnum.has(judgment)) {
      errors.push(`invalid judgment "${judgment}" for ${domain},降级为 ${tool === 'nos' ? 'no_star' : (tool === 'mmat' || tool === 'jbi_cs' ? 'cant_tell' : (tool === 'robins_i' ? 'no_information' : 'some_concerns'))}`)
      judgment = tool === 'nos' ? 'no_star'
              : tool === 'mmat' ? 'cant_tell'
              : tool === 'jbi_cs' ? 'unclear'
              : tool === 'robins_i' ? 'no_information'
              : 'some_concerns'
    }
    const rationale = String(j.rationale || '').slice(0, 600)
    const evidence_quote = String(j.evidence_quote || '').slice(0, 400)
    const signaling_answers_summary = String(j.signaling_answers_summary || '').slice(0, 600)
    const page_ref = j.page_ref ? String(j.page_ref).slice(0, 40) : null
    const confidence = ['high', 'medium', 'low'].includes(String(j.confidence || '').toLowerCase())
      ? String(j.confidence).toLowerCase() : 'medium'

    // 空 quote + 非"未知"判断 → flag
    if (!evidence_quote.trim() && !['some_concerns', 'cant_tell', 'unclear', 'no_information', 'na'].includes(judgment)) {
      errors.push(`${domain}: judgment=${judgment} but no evidence_quote(应降级为 some_concerns/cant_tell)`)
    }

    cleaned.push({ domain, judgment, signaling_answers_summary, rationale, evidence_quote, page_ref, confidence })
    if (signaling_answers_summary) signaling[domain] = signaling_answers_summary
    if (evidence_quote) quotes[domain] = evidence_quote
  }

  if (cleaned.length === 0) {
    return { ok: false, parsed: null, errors: errors.concat(['no valid judgments after cleaning']) }
  }

  // 本地 roll-up
  const rollup = computeOverallRating(cleaned, tool)

  return {
    ok: true,
    parsed: {
      tool,
      tool_version: String(raw.tool_version || meta.version),
      effect_of_interest: raw.effect_of_interest || null,
      study_subtype: raw.study_subtype || null,
      mmat_design_category: raw.mmat_design_category || null,
      judgments: cleaned,
      overall_rating: rollup.rating,
      overall_rationale: rollup.rationale,
      overall_counts: rollup.counts,
      signaling_answers: signaling,
      evidence_quotes: quotes,
    },
    errors,
  }
}

// ============================================================
//  Project overlay generator(类似 matrix optimize-master-prompt)
// ============================================================

export const OPTIMIZE_OVERLAY_SYSTEM = `你是 SLR 方法学顾问 + prompt 工程专家。

任务:给定一个 SLR 项目的协议 + 3-4 篇代表性 include 论文摘要,为 5 套 RoB 工具(Cochrane RoB 2 / ROBINS-I / NOS / JBI-CS / MMAT)分别生成 **项目特异性 overlay 指引**。

overlay 指引会被拼接到通用 system prompt 之后,告诉 LLM "对**这个具体项目**评估 RoB 时要特别注意什么"。

设计原则:
1. 每套 overlay 200-500 字符,聚焦"本项目这个领域的 RoB 高发坑点"。
2. 必须基于协议的 PICO + outcome / measurement 信息,**绝不**写通用废话(如 "注意 randomization 是否充分")。
3. 聚焦 outcome 测量层面(self-report ceiling effect / 教师评分主观性 / instrument validity 等),这是大部分教育/心理学 RoB 实际下降的地方。
4. 输出 **English**(整个 RoB 评估走英文)。

具体 hint(根据协议适配):
- 如果 outcome 是元认知/态度/学习投入 → 提醒 D4 measurement bias(MAI / MSLQ / 类似自报告量表 ceiling effect、社会期望偏差)
- 如果 intervention 是 GenAI / 对话式 AI → 提醒 D3 classification(prompt engineering 一致性、模型版本差异)
- 如果是 quasi-experimental(无随机)→ 提醒 ROBINS-I D1 confounding(教学班级差异、教师效应)
- 如果是 qualitative → 提醒 MMAT Q4 数据驱动 vs 研究者预设
- 一定要点名协议提到的具体 instrument 名字(MAI, MSLQ, MARS, MCAI, MCRS 等)

输出 JSON,字段名一字不差:
{
  "rob2":     "<English overlay for RoB 2, 200-500 chars>",
  "robins_i": "<English overlay for ROBINS-I, 200-500 chars>",
  "nos":      "<English overlay for NOS, 200-500 chars>",
  "jbi_cs":   "<English overlay for JBI-CS, 200-500 chars>",
  "mmat":     "<English overlay for MMAT, 200-500 chars>",
  "rationale": "<200 字内,简述你做的关键定制(协议哪些点驱动了 overlay)>"
}`

/**
 * 构造 OPTIMIZE_OVERLAY_SYSTEM 的 user prompt:
 *   协议(完整 PICO / inclusion-exclusion / concept_groups)+ 项目元 + 3-4 篇 sample 论文
 *
 * 跟 matrix 的 buildOptimizePromptUserPrompt 同模式,只是不传 matrix 列定义(RoB 不依赖列)。
 */
export function buildOptimizeOverlayUserPrompt({ project, protocol, samples }) {
  const lines = []
  lines.push('# 项目背景')
  if (project?.title)      lines.push(`- Project title: ${project.title}`)
  if (project?.discipline) lines.push(`- Discipline: ${project.discipline}`)
  if (project?.topic)      lines.push(`- Topic: ${project.topic}`)
  if (project?.goal)       lines.push(`- Goal: ${project.goal}`)
  lines.push('')

  lines.push(`# Approved protocol v${protocol?.version || '?'}`)
  if (protocol?.recommended_review_type) {
    lines.push(`## Review type`)
    lines.push(protocol.recommended_review_type)
    lines.push('')
  }
  if (protocol?.research_questions?.length) {
    lines.push(`## Research questions`)
    for (const q of protocol.research_questions) {
      const t = typeof q === 'string' ? q : (q?.text || q?.label || JSON.stringify(q))
      lines.push(`- ${t}`)
    }
    lines.push('')
  }
  if (protocol?.concept_groups?.length) {
    lines.push(`## Concept groups (PICO)`)
    for (const g of protocol.concept_groups) {
      if (!g || typeof g !== 'object') continue
      const name = g.name || g.concept || g.label || '(unnamed)'
      const terms = Array.isArray(g.terms) ? g.terms : []
      const role = g.role || g.pico_role || ''
      lines.push(`- **${name}** [${role}]`)
      if (g.description) lines.push(`  ${String(g.description).slice(0, 240)}`)
      if (terms.length) {
        const sample = terms.slice(0, 8).map((t) => typeof t === 'string' ? t : (t.term || JSON.stringify(t))).join(', ')
        lines.push(`  Terms: ${sample}`)
      }
    }
    lines.push('')
  }
  if (protocol?.inclusion_criteria?.length) {
    lines.push(`## Inclusion criteria`)
    for (const c of protocol.inclusion_criteria) {
      const t = typeof c === 'string' ? c : (c?.text || c?.label || JSON.stringify(c))
      lines.push(`- ${t}`)
    }
    lines.push('')
  }
  if (protocol?.exclusion_criteria?.length) {
    lines.push(`## Exclusion criteria`)
    for (const c of protocol.exclusion_criteria) {
      const t = typeof c === 'string' ? c : (c?.text || c?.label || JSON.stringify(c))
      lines.push(`- ${t}`)
    }
    lines.push('')
  }

  if (samples?.length) {
    lines.push(`# Sample included papers (${samples.length}) — to ground your overlay in real study designs`)
    for (const r of samples) {
      lines.push(`## ${r.title || '(no title)'} (${r.year || '?'})`)
      if (r.journal) lines.push(`*${r.journal}*`)
      if (r.abstract) lines.push(`Abstract: ${String(r.abstract).slice(0, 800)}`)
      lines.push('')
    }
  }

  lines.push('---')
  lines.push('Output the JSON specified in the system prompt (5 overlay strings + rationale). JSON only.')
  return lines.join('\n')
}

/**
 * 校验 LLM 输出 overlay。
 */
export function normalizeOverlayOutput(raw) {
  if (!raw || typeof raw !== 'object') return null
  const keys = ['rob2', 'robins_i', 'nos', 'jbi_cs', 'mmat']
  const out = {}
  let allPresent = true
  for (const k of keys) {
    const v = typeof raw[k] === 'string' ? raw[k].trim() : ''
    if (v.length < 80) allPresent = false
    out[k] = v.slice(0, 2000)
  }
  if (!allPresent) return null
  return { ...out, rationale: typeof raw.rationale === 'string' ? raw.rationale.trim().slice(0, 600) : '' }
}

// ============================================================
//  DB helpers
// ============================================================

/**
 * Upsert 一个 RoB assessment(record-level)。
 * 使用 UNIQUE(record_id, rater_pass) 做 upsert。Phase 1 默认 rater_pass=1。
 */
export function upsertRobAssessment(db, {
  projectId, recordId, tool, toolVersion,
  judgmentsJson, overallRating, overallRationale,
  signalingAnswersJson, evidenceQuotesJson,
  filledBy = 'ai', modelUsed = null, usageLogId = null,
  raterPass = 1, parentAssessmentId = null,
  reviewedByUserId = null, notes = null,
}) {
  if (!projectId || !recordId || !tool) throw new Error('upsertRobAssessment: missing args')
  // 看是否已存在(record_id + rater_pass UNIQUE)
  const existing = db.prepare(
    `SELECT id FROM rob_assessments WHERE record_id = ? AND rater_pass = ?`
  ).get(recordId, raterPass)

  if (existing) {
    db.prepare(`
      UPDATE rob_assessments
         SET tool = ?, tool_version = ?, judgments_json = ?,
             overall_rating = ?, overall_rationale = ?,
             signaling_answers_json = ?, evidence_quotes_json = ?,
             filled_by = ?, model_used = ?, usage_log_id = ?,
             notes = COALESCE(?, notes),
             reviewed_by_user_id = COALESCE(?, reviewed_by_user_id),
             updated_at = datetime('now', '+8 hours')
       WHERE id = ?
    `).run(
      tool, toolVersion, judgmentsJson,
      overallRating || null, overallRationale || null,
      signalingAnswersJson || null, evidenceQuotesJson || null,
      filledBy, modelUsed, usageLogId,
      notes, reviewedByUserId,
      existing.id,
    )
    return { id: existing.id, updated: true }
  }

  const id = randomId('rob')
  db.prepare(`
    INSERT INTO rob_assessments (
      id, project_id, record_id, tool, tool_version,
      judgments_json, overall_rating, overall_rationale,
      signaling_answers_json, evidence_quotes_json,
      filled_by, model_used, usage_log_id,
      rater_pass, parent_assessment_id, reviewed_by_user_id, notes,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
  `).run(
    id, projectId, recordId, tool, toolVersion,
    judgmentsJson, overallRating || null, overallRationale || null,
    signalingAnswersJson || null, evidenceQuotesJson || null,
    filledBy, modelUsed, usageLogId,
    raterPass, parentAssessmentId, reviewedByUserId, notes,
  )
  return { id, updated: false }
}

export function getRobForRecord(db, recordId, raterPass = 1) {
  if (!recordId) return null
  return db.prepare(
    `SELECT * FROM rob_assessments WHERE record_id = ? AND rater_pass = ?`
  ).get(recordId, raterPass)
}

export function listRobForProject(db, projectId) {
  if (!projectId) return []
  return db.prepare(
    `SELECT * FROM rob_assessments WHERE project_id = ? AND rater_pass = 1 ORDER BY updated_at DESC`
  ).all(projectId)
}

/**
 * 拉项目所有 pass=2(Deep verification)的评估。给 UI 做"双 pass 对比"用。
 */
export function listRobPass2ForProject(db, projectId) {
  if (!projectId) return []
  return db.prepare(
    `SELECT * FROM rob_assessments WHERE project_id = ? AND rater_pass = 2 ORDER BY updated_at DESC`
  ).all(projectId)
}

/**
 * 把 record 的 pass-2(Deep)结果提升为 pass-1(primary):
 *   1. 删原 pass-1(Fast)
 *   2. UPDATE pass-2.rater_pass = 1 + clear parent_assessment_id
 *  事务保证原子性。
 */
export function promotePass2ToPrimary(db, recordId) {
  if (!recordId) return false
  const tx = db.transaction(() => {
    const p2 = db.prepare(`SELECT id FROM rob_assessments WHERE record_id = ? AND rater_pass = 2`).get(recordId)
    if (!p2) return false
    db.prepare(`DELETE FROM rob_assessments WHERE record_id = ? AND rater_pass = 1`).run(recordId)
    db.prepare(`UPDATE rob_assessments SET rater_pass = 1, parent_assessment_id = NULL, updated_at = datetime('now', '+8 hours') WHERE id = ?`).run(p2.id)
    return true
  })
  return tx()
}

/**
 * 删一条 RoB assessment(rerun 用)。
 */
export function deleteRobForRecord(db, recordId, raterPass = 1) {
  if (!recordId) return 0
  const r = db.prepare(`DELETE FROM rob_assessments WHERE record_id = ? AND rater_pass = ?`)
    .run(recordId, raterPass)
  return r.changes
}

// ============================================================
//  Fast mode:多篇 / call,只读 matrix(不读 PDF 全文)
//  ------------------------------------------------------------
//  设计:Step 4 已经把每篇论文的方法学要点结构化抽进 matrix(study_design /
//        recruitment / intervention / outcomes / measurement_tools / sample_size /
//        quantitative_results / limitations 等)。RoB 评估需要的 90% 证据
//        其实已经在 matrix 里 — 不必再读全文 80K 字符,直接喂 matrix 给 LLM。
//
//  好处:121 篇从 30-60 min → 5-10 min;成本从 $25-60 → $3-10。
//  代价:某些 RCT 的微观细节(allocation concealment 具体方式等)matrix
//        可能没记录 → 改判 some_concerns(规则本来就是 no quote → some_concerns)。
//        发表方法学段写"RoB based on structured extraction; sub-sample
//        manually verified against full text"。
//
//  Deep mode(per-paper 读全文)仍保留 — 用户可对单篇按 ↻ 重评本条 触发。
// ============================================================

/**
 * 构建多篇并行 RoB 评估的 user prompt。
 * 同一个 tool 内 N 篇(N=5-10),共享 system prompt + overlay。
 * 输出格式:{ tool, papers: [{record_id, judgments: [...]}] }
 */
export function buildRobFastBatchPrompt({ batch, tool }) {
  const meta = TOOL_META[tool]
  const lines = []
  lines.push(`# Batch RoB assessment — ${batch.length} papers, tool: ${meta.label}`)
  lines.push('')
  lines.push('You will assess **multiple papers in one response**. For each paper below, apply the same instrument (signaling questions + judgment algorithm) defined in the system prompt above.')
  lines.push('')
  lines.push('## CRITICAL: Output schema (one JSON object, papers array indexed by record_id)')
  lines.push('```json')
  lines.push('{')
  lines.push('  "tool": "' + tool + '",')
  lines.push('  "tool_version": "' + meta.version + '",')
  lines.push('  "papers": [')
  lines.push('    {')
  lines.push('      "record_id": "rec_xxx",  // copy from input EXACTLY')
  lines.push('      "judgments": [')
  lines.push(`        { "domain": "${meta.domains[0]}", "judgment": "...", "signaling_answers_summary": "...", "rationale": "<=80 words", "evidence_quote": "<=30 words FROM the matrix evidence below", "page_ref": null, "confidence": "high|medium|low" }`)
  lines.push('        // ... all ' + meta.domains.length + ' domains per paper')
  lines.push('      ]')
  lines.push('    }')
  lines.push('    // ... ' + batch.length + ' papers total')
  lines.push('  ]')
  lines.push('}')
  lines.push('```')
  lines.push('')
  lines.push('## Evidence source')
  lines.push('Each paper below provides **structured matrix evidence** (pre-extracted from full text by a prior LLM pass; no raw PDF available in this call). Treat matrix field values as authoritative paraphrases of the paper — they ARE valid evidence; quote from them verbatim where supporting the judgment.')
  lines.push('')
  lines.push('### Balanced judgment(applies to all 5 tools):')
  lines.push('- When matrix evidence **positively documents** the bias source was addressed (e.g., study_design = "RCT with computer-generated allocation", recruitment = "consecutive sampling with 95% response", measurement_tools = "blinded independent expert raters") → judge **LOW RoB / YES / STAR** (the favorable outcome for that tool). Do not pad to "some_concerns" / "cant_tell" out of excessive caution.')
  lines.push('- When matrix evidence is **genuinely empty or contradictory** for a domain → judge "some_concerns" / "cant_tell" / "unclear" / "no_information" per instrument, rationale = "insufficient information in structured extraction".')
  lines.push('- When matrix evidence **affirmatively shows the bias source exists** (e.g., "no control group", "self-selection bias", "self-report only") → judge "high" / "serious" / "no" / "low_quality" per instrument.')
  lines.push('- **Never invent evidence not present in the matrix.** But equally: do not under-credit positive evidence that IS present.')
  lines.push('')
  lines.push('---')
  lines.push('')

  for (const item of batch) {
    const r = item.record
    lines.push(`## Paper: ${r.id}`)
    lines.push(`- Title: ${r.title || '(no title)'}`)
    if (r.year) lines.push(`- Year: ${r.year}`)
    if (r.journal) lines.push(`- Journal: ${r.journal}`)
    if (r.doi) lines.push(`- DOI: ${r.doi}`)
    const digest = buildMatrixEvidenceDigest(item.matrixFields, tool)
    if (digest) {
      lines.push('')
      lines.push(digest)
    } else {
      lines.push('')
      lines.push('### (Matrix evidence empty for relevant domains — judge as some_concerns / cant_tell / unclear / no_information per instrument)')
    }
    lines.push('')
    lines.push('---')
    lines.push('')
  }

  lines.push('Output ONE JSON object with the schema above. JSON only, no commentary, no markdown fences.')
  lines.push('CRITICAL: Each paper.record_id must match input exactly (copy-paste). papers.length must equal ' + batch.length + '.')

  return lines.join('\n')
}

/**
 * 解析 Fast batch 输出(N 篇并行)。
 * 返回 { ok, assessments: [{record_id, parsed: {tool, ..., judgments, overall_*}}, ...], errors }
 *
 * 对每篇:
 *  - 跑 parseRobBatchOutput 校验 + roll-up(复用)
 *  - 解析失败的篇标记为 failed,不让整批挂掉
 */
export function parseRobFastBatchOutput(raw, expectedTool, batch) {
  const errors = []
  if (!raw || typeof raw !== 'object') {
    // 2026-05-30 debug:把 raw 类型 + 头部内容 dump 出来诊断
    console.warn('[parseRobFastBatch] raw is not object — type=' + typeof raw +
      ', preview=' + JSON.stringify(raw)?.slice(0, 500))
    return { ok: false, assessments: [], errors: ['empty or non-object output'] }
  }
  const tool = raw.tool || expectedTool
  if (tool !== expectedTool) {
    errors.push(`batch tool mismatch: expected ${expectedTool}, got ${raw.tool || 'none'}`)
  }
  // 2026-05-30 alt-key fallback:Sonnet 偶尔不严格遵守 schema,papers 可能挂在别的 key 下,
  //   或 raw 顶层直接就是 array,或 raw 是 single-paper 没 wrapping
  let papers = Array.isArray(raw.papers) ? raw.papers : null
  if (!papers && Array.isArray(raw.assessments)) papers = raw.assessments
  if (!papers && Array.isArray(raw.results))     papers = raw.results
  if (!papers && Array.isArray(raw.judgments_per_paper)) papers = raw.judgments_per_paper
  if (!papers && Array.isArray(raw))             papers = raw   // raw 顶层就是 array
  // single-paper 兜底:raw 长得像单篇 paper(有 judgments + record_id)
  if (!papers && raw.record_id && Array.isArray(raw.judgments)) {
    papers = [raw]
    errors.push('LLM emitted single-paper shape; auto-wrapped as 1-element papers array')
  }
  if (!papers || papers.length === 0) {
    // 2026-05-30 debug:dump raw 给超管看 shape 是什么
    const rawJson = JSON.stringify(raw).slice(0, 2000)
    console.warn('[parseRobFastBatch] papers array empty/missing — raw top-level keys=' +
      Object.keys(raw).join(',') + ' | raw preview: ' + rawJson)
    return {
      ok: false, assessments: [],
      errors: errors.concat([
        `papers array empty/missing; raw top-level keys: [${Object.keys(raw).join(',')}]`,
      ]),
    }
  }

  const validRecordIds = new Set(batch.map((b) => b.record.id))
  const assessments = []
  const seenIds = new Set()

  for (const p of papers) {
    if (!p || typeof p !== 'object') continue
    const rid = String(p.record_id || '').trim()
    if (!rid) { errors.push('paper missing record_id'); continue }
    if (!validRecordIds.has(rid)) {
      errors.push(`unknown record_id in output: ${rid}`)
      continue
    }
    if (seenIds.has(rid)) {
      errors.push(`duplicate record_id in output: ${rid}`)
      continue
    }
    seenIds.add(rid)

    // 复用 parseRobBatchOutput — 但它期望顶层 {tool, judgments},包一下
    const wrapped = {
      tool,
      tool_version: raw.tool_version || TOOL_META[tool].version,
      effect_of_interest: p.effect_of_interest,
      study_subtype: p.study_subtype,
      mmat_design_category: p.mmat_design_category,
      judgments: p.judgments,
    }
    const single = parseRobBatchOutput(wrapped, tool)
    if (!single.ok) {
      errors.push(`record ${rid}: ${(single.errors || []).join('; ')}`)
      assessments.push({ record_id: rid, ok: false, errors: single.errors || [] })
      continue
    }
    assessments.push({ record_id: rid, ok: true, parsed: single.parsed, validation_warnings: single.errors || [] })
  }

  // 检查漏掉的 record(LLM 没在 papers 数组里返回)
  const missing = []
  for (const rid of validRecordIds) {
    if (!seenIds.has(rid)) missing.push(rid)
  }
  if (missing.length) errors.push(`LLM omitted ${missing.length} record(s): ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '...' : ''}`)

  return {
    ok: assessments.some((a) => a.ok),
    assessments,
    missing_record_ids: missing,
    errors,
  }
}

/**
 * Fast mode 入口:把 records 按 tool 分组,每组按 batchSize 切片,
 *   每片 1 次 LLM call,解析后 upsert 每条。
 *
 * @param {object} db
 * @param {object} opts
 *   - userId, project, records: 待评估论文(已含 matrix 数据回填权,在内部 fetch)
 *   - overlay: 项目专用 overlay JSON({rob2,robins_i,nos,jbi_cs,mmat: '...'})
 *   - batchSize: default 8(每批 LLM call 多少篇)
 *   - reqLike: req for audit
 *   - onProgress(done, total, currentBatch): 进度回调(给 batch_jobs 用)
 *   - llmDeps: { runLlm, getMatrixForRecord, pickRobTool, upsertRobAssessment, audit }
 *     ↑ 这层依赖注入是为了让 routes/projects/rob.js 注入,避免循环 import
 */
export async function runRobFastBatch({
  db, userId, project, records, overlay = null,
  batchSize = 8,
  reqLike,
  llmDeps,
  onProgress = null,
}) {
  const { runLlm, getMatrixForRecord, upsertRobAssessment, audit } = llmDeps

  // 1) 按 tool 分组
  const byTool = new Map()
  for (const r of records) {
    const m = getMatrixForRecord(db, project.id, r.id)
    let fields = {}
    if (m && m.fields) {
      try { fields = typeof m.fields === 'string' ? JSON.parse(m.fields) : m.fields } catch {}
    }
    const tool = pickRobTool(fields.study_design || '')
    if (!byTool.has(tool)) byTool.set(tool, [])
    byTool.get(tool).push({ record: r, matrixFields: fields })
  }

  let totalDone = 0
  let totalFailed = 0
  const total = records.length
  const results = { byTool: {}, totalAssessed: 0, totalFailed: 0, batches: 0 }

  // 2) 每 tool 内按 batchSize 切片
  for (const [tool, items] of byTool) {
    const meta = TOOL_META[tool]
    const overlayText = overlay && overlay[tool] ? overlay[tool] : ''
    const system = overlayText
      ? `${TOOL_SYSTEM_PROMPTS[tool]}\n\n# Project-specific overlay (generated by Opus 4.8 from approved protocol + sample papers)\n${overlayText}`
      : TOOL_SYSTEM_PROMPTS[tool]

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize)
      results.batches++

      // 在 LLM 调用前先报告 current(否则用户看 progress 静止 5-15 min 以为挂了)
      if (onProgress) {
        try {
          onProgress({
            done: totalDone,
            failed: totalFailed,
            total,
            current: {
              id: batch[0]?.record?.id || null,
              title: `正在评估 ${meta.label} 第 ${Math.floor(i / batchSize) + 1} 批(${batch.length} 篇)— Sonnet 推理中,5-15 min/批`,
            },
          })
        } catch {}
      }

      const userPrompt = buildRobFastBatchPrompt({ batch, tool })

      let result
      try {
        result = await runLlm(db, {
          userId,
          actionType: 'rob_assess_batch',
          projectId: project.id,
          system,
          prompt: userPrompt,
          expectJson: true,
          // 输出可能挺大:N papers × 5-9 domains × ~200 chars。给 24K 留余量(Sonnet think_hard 容易踩 16K)。
          maxTokens: 24000,
          // 2026-05-30 bump 480s → 900s:实测 proj_cf886474 第 1 批 MMAT 8 papers Sonnet
          //   恰好踩 480s cap timeout(usage_log #1571 等)。同 search_strategy 修(#223)。
          timeoutMs: 900_000,
        })
      } catch (e) {
        // 整批失败 — 每篇标记 failed,继续下一批
        for (const item of batch) {
          totalFailed++
          totalDone++
          audit(db, reqLike, {
            eventType: 'rob_fast_batch_failed',
            userId, projectId: project.id,
            payload: { record_id: item.record.id, tool, error: (e?.message || String(e)).slice(0, 200), batch_size: batch.length },
          })
        }
        if (onProgress) {
          try { onProgress({ done: totalDone, failed: totalFailed, total, current: null }) } catch {}
        }
        continue
      }

      if (!result.ok) {
        for (const item of batch) {
          totalFailed++
          totalDone++
          audit(db, reqLike, {
            eventType: 'rob_fast_batch_failed',
            userId, projectId: project.id,
            payload: { record_id: item.record.id, tool, status: result.status, error: (result.error || '').slice(0, 200), model: result.model, batch_size: batch.length },
          })
        }
        continue
      }

      // 解析
      const parsed = parseRobFastBatchOutput(result.data, tool, batch)
      const successByRecordId = new Map(
        parsed.assessments.filter((a) => a.ok).map((a) => [a.record_id, a])
      )

      // upsert 成功的
      for (const item of batch) {
        const rid = item.record.id
        const a = successByRecordId.get(rid)
        if (a && a.ok) {
          try {
            upsertRobAssessment(db, {
              projectId: project.id,
              recordId: rid,
              tool,
              toolVersion: a.parsed.tool_version,
              judgmentsJson: JSON.stringify(a.parsed),
              overallRating: a.parsed.overall_rating,
              overallRationale: a.parsed.overall_rationale,
              signalingAnswersJson: JSON.stringify(a.parsed.signaling_answers || {}),
              evidenceQuotesJson: JSON.stringify(a.parsed.evidence_quotes || {}),
              filledBy: 'ai',
              modelUsed: result.model,
              usageLogId: result.usageLogId,
            })
            audit(db, reqLike, {
              eventType: 'rob_fast_batch_success',
              userId, projectId: project.id,
              payload: {
                record_id: rid, tool, batch_size: batch.length,
                overall_rating: a.parsed.overall_rating,
                model: result.model,
                domains_kept: a.parsed.judgments?.length || 0,
                validation_warnings: (a.validation_warnings || []).length,
              },
            })
          } catch (e) {
            totalFailed++
            audit(db, reqLike, {
              eventType: 'rob_fast_upsert_failed',
              userId, projectId: project.id,
              payload: { record_id: rid, tool, error: e.message },
            })
          }
        } else {
          totalFailed++
          audit(db, reqLike, {
            eventType: 'rob_fast_batch_paper_omitted',
            userId, projectId: project.id,
            payload: { record_id: rid, tool, batch_size: batch.length, model: result.model, batch_errors: parsed.errors?.slice(0, 3) },
          })
        }
        totalDone++
      }
      // 每批跑完报告进度(给 batch_jobs 用)
      if (onProgress) {
        try { onProgress({ done: totalDone, failed: totalFailed, total, current: null }) } catch {}
      }
    }
    results.byTool[tool] = (results.byTool[tool] || 0) + items.length
  }

  results.totalAssessed = totalDone - totalFailed
  results.totalFailed = totalFailed
  return results
}
