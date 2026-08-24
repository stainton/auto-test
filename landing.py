"""把最终状态渲染成人可读的交付物。

只做渲染,不做任何计算——报告里的每个数字都已经由 metrics.py 算好、由报告
节点写进状态。这里再算一次就等于埋了一处口径不一致的隐患。

一条贯穿全文的规则:**缺陷分析或回归没跑时,对应章节标记为"未执行",而不是
省略。** 省略会让读报告的人误以为"没有缺陷",而实际情况是"还不知道"。
"""

from __future__ import annotations

import json
from typing import Any

from metrics import effective_results

_STATE_ROOT = "auto_test_state"

_LEVEL_TITLE = {
    "L1": "L1 执行报告(仅执行结果,缺陷分析与回归尚未进行)",
    "L2": "L2 缺陷报告(含缺陷分析,回归尚未进行)",
    "L3": "L3 完整报告(含缺陷分析与回归)",
}

_NOT_EXECUTED = "> **未执行** —— 该环节尚未运行,本节内容不代表「没有问题」,只代表「还不知道」。"


def render_report_json(snapshot: dict[str, Any]) -> str:
    """报告的机器可读版本:报告本体 + 它引用到的缺陷/缺口/回归结论。"""
    state = snapshot.get(_STATE_ROOT, {}) or {}
    payload = {
        "report": state.get("report") or {},
        "run_meta": state.get("run_meta") or {},
        "defects": state.get("defects") or [],
        "test_gaps": state.get("test_gaps") or [],
        "regression_plan": state.get("regression_plan") or [],
        "regression_conclusion": state.get("regression_conclusion") or {},
    }
    return json.dumps(payload, ensure_ascii=False, indent=2)


def _coverage_table(rows: list[dict]) -> list[str]:
    if not rows:
        return ["_(无数据)_", ""]
    out = [
        "| 名称 | 合计 | PASS | FAIL | BLOCKED | INCONCLUSIVE |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for row in rows:
        out.append(
            f"| {row.get('name','')} | {row.get('total',0)} | {row.get('passed',0)} | "
            f"{row.get('failed',0)} | {row.get('blocked',0)} | {row.get('inconclusive',0)} |"
        )
    out.append("")
    return out


def _bullets(items: list[str], empty: str = "_(无)_") -> list[str]:
    if not items:
        return [empty, ""]
    return [f"- {item}" for item in items] + [""]


def render_report_markdown(snapshot: dict[str, Any]) -> str:
    state = snapshot.get(_STATE_ROOT, {}) or {}
    report = state.get("report") or {}
    meta = state.get("run_meta") or {}
    summary = report.get("summary") or {}
    coverage = report.get("coverage") or {}
    conclusion = report.get("conclusion") or {}
    level = report.get("level") or "L1"

    cases = {c.get("case_id"): c for c in (state.get("test_cases") or [])}
    results = state.get("execution_results") or []
    defects = state.get("defects") or []
    gaps = state.get("test_gaps") or []
    regression_plan = state.get("regression_plan") or []
    regression = state.get("regression_conclusion") or {}

    lines: list[str] = [
        f"# 测试报告 {report.get('report_id', '')}",
        "",
        f"**级别**:{_LEVEL_TITLE.get(level, level)}",
        "",
        f"- 运行 ID:{meta.get('run_id', '')}",
        f"- 环境:{meta.get('env') or '_(未指定)_'}",
        f"- 被测版本:{meta.get('build') or '_(未指定)_'}",
        f"- 需求来源:{meta.get('requirement_ref', '')}",
        f"- 开始时间:{meta.get('started_at', '')}",
        f"- 报告生成时间:{report.get('generated_at', '')}",
        "",
        "## 一、执行概况",
        "",
        f"| 合计 | PASS | FAIL | BLOCKED | INCONCLUSIVE |",
        "| ---: | ---: | ---: | ---: | ---: |",
        f"| {summary.get('total', 0)} | {summary.get('passed', 0)} | {summary.get('failed', 0)} "
        f"| {summary.get('blocked', 0)} | {summary.get('inconclusive', 0)} |",
        "",
        f"- **pass_rate = {summary.get('pass_rate', 0.0):.1%}** "
        f"(分母只含 PASS + FAIL,不含 BLOCKED / INCONCLUSIVE)",
        f"- **valid_rate = {summary.get('valid_rate', 0.0):.1%}** "
        f"(真正给出了结论的用例占设计用例总数的比例)",
        "",
    ]

    if summary.get("valid_rate", 0.0) < 0.6:
        lines += [
            "> ⚠️ valid_rate 偏低:大量用例没能给出确定结论(BLOCKED / INCONCLUSIVE),"
            "本报告的结论置信度有限,详见「四、测试能力缺口」。",
            "",
        ]

    lines += ["## 二、覆盖率", "", "### 按功能", ""]
    lines += _coverage_table(coverage.get("by_function") or [])
    lines += ["### 按风险级别", ""]
    lines += _coverage_table(coverage.get("by_risk_level") or [])
    lines += ["### 按测试维度", "", "> 一条用例可同时打多个维度,各行合计之和大于用例总数属正常。", ""]
    lines += _coverage_table(coverage.get("by_test_dimension") or [])
    lines += ["### 未覆盖", ""]
    lines += _bullets(coverage.get("uncovered") or [], "_(无未覆盖项)_")

    # ---- 失败明细:每条都要能回溯到 case → observation → assertion → evidence
    #
    # 只列**每条用例最后一次**执行的结果,和上面 summary 的口径保持一致——
    # 否则一条首轮 FAIL、回归已修复的用例会一边被算进 PASS、一边出现在失败
    # 明细里,读报告的人无从判断它到底修没修好。被回归取代的那些失败不会丢:
    # 缺陷在第五节,修复验证在第七节。
    latest = effective_results(results)
    current = list(latest.values())
    superseded = len(results) - len(current)

    lines += ["## 三、失败用例明细", ""]
    if superseded:
        lines += [
            f"> 本节按每条用例**最后一次**执行的结果列出,与执行概况口径一致;"
            f"另有 {superseded} 条已被后续执行取代的历史结果未在此展开,"
            f"见「五、缺陷」与「七、回归」。",
            "",
        ]
    failures = [r for r in current if r.get("verdict") == "FAIL"]
    if not failures:
        lines += ["_(本次执行没有判为 FAIL 的用例)_", ""]
    for result in failures:
        case = cases.get(result.get("case_id"), {})
        lines += [
            f"### {result.get('case_id')} · {case.get('case_name', '')}",
            "",
            f"- 执行轮次:{result.get('round', '')}",
            f"- 判定理由:{result.get('verdict_reason', '')}",
            f"- 被违反的断言:{', '.join(result.get('failed_assertion_ids') or []) or '_(未指明)_'}",
            "",
            "| 观测点 | 是否取到 | 实际值 |",
            "| --- | :---: | --- |",
        ]
        for observed in result.get("observed") or []:
            mark = "✅" if observed.get("obtained") else "❌"
            lines.append(
                f"| {observed.get('observation_id','')} | {mark} | {observed.get('actual','')} |"
            )
        lines += [""]
        lines += ["**留痕**:", ""]
        lines += _bullets(result.get("evidence") or [], "_(无留痕)_")

    # ---- 阻塞与无法判定
    lines += ["## 四、阻塞与无法判定", ""]
    stuck = [r for r in current if r.get("verdict") in ("BLOCKED", "INCONCLUSIVE")]
    if not stuck:
        lines += ["_(没有 BLOCKED / INCONCLUSIVE 的用例)_", ""]
    else:
        lines += ["| 用例 | 结论 | 原因 |", "| --- | --- | --- |"]
        for result in stuck:
            lines.append(
                f"| {result.get('case_id','')} | {result.get('verdict','')} | "
                f"{result.get('verdict_reason','')} |"
            )
        lines += [""]

    # ---- 缺陷(L1 时未执行)
    lines += ["## 五、缺陷", ""]
    if level == "L1":
        lines += [_NOT_EXECUTED, ""]
    elif not defects:
        lines += ["_(缺陷分析已执行,未归因出缺陷)_", ""]
    else:
        lines += [
            "| 缺陷 | 标题 | 严重级别 | 优先级 | 类型 | 关联用例 | 状态 |",
            "| --- | --- | --- | --- | --- | --- | --- |",
        ]
        for defect in defects:
            lines.append(
                f"| {defect.get('defect_id','')} | {defect.get('title','')} | "
                f"{defect.get('severity','')} | {defect.get('priority','')} | "
                f"{defect.get('defect_type','')} | "
                f"{', '.join(defect.get('related_case_ids') or [])} | {defect.get('status','')} |"
            )
        lines += [""]
        for defect in defects:
            lines += [
                f"### {defect.get('defect_id','')} · {defect.get('title','')}",
                "",
                f"- 现象:{defect.get('symptom','')}",
                f"- 期望:{defect.get('expected','')}",
                f"- 根因假设:{defect.get('root_cause_hypothesis','')}",
                f"- 可复现性:{defect.get('reproducibility','')}",
                f"- 影响面:{json.dumps(defect.get('impact_scope') or {}, ensure_ascii=False)}",
                "",
                "**复现步骤**:",
                "",
            ]
            lines += _bullets(defect.get("reproduce_steps") or [])

    # ---- 测试能力缺口(L1 时未执行)
    lines += ["## 六、测试能力缺口", "", "> BLOCKED / INCONCLUSIVE 不是缺陷,而是环境、数据、可观测性的缺口;"
              "它们遮蔽的风险是「不知道有没有问题」,不是「没问题」。", ""]
    if level == "L1":
        lines += [_NOT_EXECUTED, ""]
    elif not gaps:
        lines += ["_(缺陷分析已执行,未发现测试能力缺口)_", ""]
    else:
        lines += [
            "| 编号 | 来源 | 分类 | 描述 | 被遮蔽的风险 | 改进动作 |",
            "| --- | --- | --- | --- | --- | --- |",
        ]
        for gap in gaps:
            lines.append(
                f"| {gap.get('issue_id','')} | {gap.get('source_verdict','')} | "
                f"{gap.get('category','')} | {gap.get('description','')} | "
                f"{gap.get('masked_risk','')} | {gap.get('action','')} |"
            )
        lines += [""]

    # ---- 回归(L1/L2 时未执行)
    lines += ["## 七、回归", ""]
    if level != "L3":
        lines += [_NOT_EXECUTED, ""]
    # 注意不能直接用 `not regression` 判断:StateSchema.empty() 生成的
    # regression_conclusion 是一个字段齐备、值为零值的 dict,本身是真值。
    elif not regression_plan and not regression.get("conclusion"):
        lines += ["_(没有需要回归的缺陷,本轮未执行回归)_", ""]
    else:
        lines += ["**回归范围**:", ""]
        lines += _bullets(
            [
                f"{item.get('regression_id','')}({item.get('scope_reason','')},触发:"
                f"{item.get('trigger','')}/{item.get('trigger_ref','')}):"
                f"{', '.join(item.get('case_ids') or [])}"
                for item in regression_plan
            ]
        )
        lines += [f"**回归结论**:{regression.get('conclusion') or '_(未给出)_'}", ""]
        verifications = regression.get("defect_verification") or []
        if verifications:
            lines += ["| 缺陷 | 验证结果 | 留痕 |", "| --- | --- | --- |"]
            for item in verifications:
                lines.append(
                    f"| {item.get('defect_id','')} | {item.get('result','')} | "
                    f"{'; '.join(item.get('evidence') or [])} |"
                )
            lines += [""]
        lines += ["**新增缺陷**:", ""]
        lines += _bullets(regression.get("new_defect_ids") or [], "_(无)_")
        lines += ["**复发缺陷**:", ""]
        lines += _bullets(regression.get("reopened_defect_ids") or [], "_(无)_")
        lines += ["**仍未验证**:", ""]
        lines += _bullets(regression.get("uncovered") or [], "_(无)_")

    # ---- 结论
    lines += ["## 八、结论", ""]
    gate_passed = report.get("release_gate_passed", True)
    lines += [
        f"- 发布闸门:{'✅ 通过' if gate_passed else '❌ 未通过'}"
        "(高风险功能存在 FAIL / BLOCKED / INCONCLUSIVE 即判未通过)",
        "",
    ]
    if not gate_passed:
        lines += ["**闸门违规项**:", ""]
        lines += _bullets(report.get("gate_violations") or [])
    lines += [
        f"- **质量评价**:{conclusion.get('quality_assessment') or '_(未给出)_'}",
        f"- **发布建议**:{conclusion.get('release_suggestion') or '_(未给出)_'}",
        f"- **结论置信度**:{conclusion.get('confidence_note') or '_(未给出)_'}",
        "",
        "**遗留风险**:",
        "",
    ]
    lines += _bullets(conclusion.get("residual_risk") or [])
    lines += ["**后续动作**:", ""]
    lines += _bullets(conclusion.get("next_actions") or [])

    return "\n".join(lines).rstrip() + "\n"
