"""测试报告的可计算部分 —— nodes/docs/8_test_report.md 的"口径约定"。

统计、覆盖率、发布闸门全都是**算得出来的**,所以一律放在代码里,不交给模型
判断(这是开发指南反复强调的一条:能算的别问模型)。报告节点里 Agent 只写
结论文字,而且必须忠实于这里算出的数字。

本模块是纯函数,不碰 RunContext / StateStore,便于单测。
"""

from __future__ import annotations

from typing import Any, Iterable

VERDICTS = ("PASS", "FAIL", "BLOCKED", "INCONCLUSIVE")
HIGH_RISK_LEVELS = ("critical", "high")

_VERDICT_TO_KEY = {
    "PASS": "passed",
    "FAIL": "failed",
    "BLOCKED": "blocked",
    "INCONCLUSIVE": "inconclusive",
}


def effective_results(execution_results: Iterable[dict]) -> dict[str, dict]:
    """每条用例取**最后一次**执行结果。

    同一条用例会被首轮和回归各执行一次(两条记录都留在状态里,回归报告要能
    对比修复前后)。而报告的 summary 回答的是"现在这个版本是什么状态",所以
    按 case_id 取最后写入的那条——回归结果覆盖首轮结果。
    """
    latest: dict[str, dict] = {}
    for result in execution_results or []:
        case_id = result.get("case_id")
        if case_id:
            latest[case_id] = result
    return latest


def _blank_row(name: str) -> dict[str, Any]:
    return {"name": name, "total": 0, "passed": 0, "failed": 0, "blocked": 0, "inconclusive": 0}


def _tally(row: dict[str, Any], verdict: str | None) -> None:
    row["total"] += 1
    key = _VERDICT_TO_KEY.get(verdict or "")
    if key:
        row[key] += 1


def compute_summary(test_cases: list[dict], execution_results: list[dict]) -> dict[str, Any]:
    """按 nodes/docs/8_test_report.md 的口径算 summary。

    · total 是**设计出来的**用例数,不是执行过的用例数——没跑起来的用例同样
      要拖低 valid_rate,否则"一半用例压根没执行"会在报告里彻底隐身。
    · pass_rate 的分母只含 PASS + FAIL,不含 BLOCKED / INCONCLUSIVE:阻塞和
      判不了的用例不该被用来稀释失败率。
    · valid_rate = (PASS + FAIL) / total,单独衡量本次执行有多少用例真的给出了
      结论;它偏低时,报告结论必须显式声明置信度低。
    """
    latest = effective_results(execution_results)
    counts = {"passed": 0, "failed": 0, "blocked": 0, "inconclusive": 0}
    for case in test_cases or []:
        result = latest.get(case.get("case_id"))
        key = _VERDICT_TO_KEY.get((result or {}).get("verdict") or "")
        if key:
            counts[key] += 1

    total = len(test_cases or [])
    decided = counts["passed"] + counts["failed"]
    return {
        "total": total,
        **counts,
        "pass_rate": round(counts["passed"] / decided, 4) if decided else 0.0,
        "valid_rate": round(decided / total, 4) if total else 0.0,
    }


def compute_coverage(
    test_cases: list[dict],
    behavior_models: list[dict],
    test_scenarios: list[dict],
    execution_results: list[dict],
) -> dict[str, Any]:
    """按功能 / 风险级别 / 测试维度分组统计,并列出没被覆盖到的部分。"""
    latest = effective_results(execution_results)
    models_by_id = {m.get("model_id"): m for m in behavior_models or []}

    by_function: dict[str, dict] = {}
    by_risk: dict[str, dict] = {}
    by_dimension: dict[str, dict] = {}
    covered_models: set[str] = set()
    covered_scenarios: set[str] = set()
    unexecuted: list[str] = []

    for case in test_cases or []:
        model_id = case.get("model_id") or ""
        model = models_by_id.get(model_id, {})
        verdict = (latest.get(case.get("case_id")) or {}).get("verdict")
        if verdict is None:
            unexecuted.append(case.get("case_id") or "<无 case_id>")
        covered_models.add(model_id)
        covered_scenarios.add(case.get("scenario_id") or "")

        function = model.get("function") or model_id or "<未关联行为模型>"
        _tally(by_function.setdefault(function, _blank_row(function)), verdict)

        depth = model.get("test_depth") or "<未评估风险>"
        _tally(by_risk.setdefault(depth, _blank_row(depth)), verdict)

        # 一条用例可以同时打多个测试维度,会在多行里各计一次:这几行的 total
        # 之和大于用例总数是正常的,它们回答的是"每个维度被打了几次",不是
        # 用例的一次划分。
        for dimension in case.get("test_dimensions") or ["<未标注测试维度>"]:
            _tally(by_dimension.setdefault(dimension, _blank_row(dimension)), verdict)

    uncovered: list[str] = []
    for model in behavior_models or []:
        if model.get("model_id") not in covered_models:
            uncovered.append(
                f"行为模型 {model.get('model_id')}({model.get('function')})没有任何用例覆盖"
                f",风险深度 {model.get('test_depth')}"
            )
    for scenario in test_scenarios or []:
        if scenario.get("scenario_id") not in covered_scenarios:
            uncovered.append(
                f"测试场景 {scenario.get('scenario_id')}({scenario.get('scenario_name')})没有产出任何用例"
            )
    if unexecuted:
        uncovered.append(f"{len(unexecuted)} 条用例未被执行:{', '.join(unexecuted)}")

    def _rows(grouped: dict[str, dict]) -> list[dict]:
        # 问题多的排前面,一眼看到该看哪里。
        return sorted(
            grouped.values(),
            key=lambda r: (-(r["failed"] + r["blocked"] + r["inconclusive"]), r["name"]),
        )

    return {
        "by_function": _rows(by_function),
        "by_risk_level": _rows(by_risk),
        "by_test_dimension": _rows(by_dimension),
        "uncovered": uncovered,
    }


def compute_release_gate(
    test_cases: list[dict],
    behavior_models: list[dict],
    execution_results: list[dict],
) -> tuple[bool, list[str]]:
    """发布闸门:高风险功能只要不是干干净净地通过,就不许给"可发布"。

    设计文档的原话是"高风险(critical/high)功能存在 FAIL、BLOCKED 或
    INCONCLUSIVE 时,release_suggestion 不得给出'可发布'"。这是一条纯粹的
    可计算约束,所以在这里算成硬结果,再去压住模型可能给出的乐观结论——
    注意 BLOCKED 与 INCONCLUSIVE 同样拦截:它们代表"不知道有没有问题",
    在发布决策里和"有问题"是同一档,不能当成通过。
    """
    latest = effective_results(execution_results)
    models_by_id = {m.get("model_id"): m for m in behavior_models or []}
    violations: list[str] = []

    high_risk_ids = {
        m.get("model_id")
        for m in behavior_models or []
        if (m.get("test_depth") or "") in HIGH_RISK_LEVELS
    }
    covered: set[str] = set()

    for case in test_cases or []:
        model_id = case.get("model_id") or ""
        if model_id not in high_risk_ids:
            continue
        covered.add(model_id)
        verdict = (latest.get(case.get("case_id")) or {}).get("verdict")
        if verdict == "PASS":
            continue
        function = (models_by_id.get(model_id) or {}).get("function") or model_id
        violations.append(
            f"高风险功能「{function}」的用例 {case.get('case_id')} 结论为 "
            f"{verdict or '未执行'},未通过"
        )

    for model_id in sorted(high_risk_ids - covered, key=lambda x: x or ""):
        function = (models_by_id.get(model_id) or {}).get("function") or model_id
        violations.append(f"高风险功能「{function}」({model_id})没有任何用例覆盖")

    return (not violations), violations
