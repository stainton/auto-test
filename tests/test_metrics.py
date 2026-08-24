"""metrics.py 的单测。

这部分是"能算的不交给模型判断"的落点,也是报告里唯一不能出错的数字来源,
所以边界条件要逐个钉住。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from metrics import compute_coverage, compute_release_gate, compute_summary, effective_results


def _case(case_id: str, model_id: str = "BM-01", dims: list[str] | None = None) -> dict:
    return {
        "case_id": case_id,
        "model_id": model_id,
        "scenario_id": "SC-01",
        "test_dimensions": dims if dims is not None else ["并发"],
    }


def _result(case_id: str, verdict: str, round_: str = "initial") -> dict:
    return {"case_id": case_id, "verdict": verdict, "round": round_}


class EffectiveResultsTest(unittest.TestCase):
    def test_latest_result_wins(self) -> None:
        results = [
            _result("TC-01", "FAIL"),
            _result("TC-02", "PASS"),
            _result("TC-01", "PASS", "regression"),
        ]
        latest = effective_results(results)
        self.assertEqual(latest["TC-01"]["verdict"], "PASS")
        self.assertEqual(latest["TC-01"]["round"], "regression")

    def test_results_without_case_id_are_dropped(self) -> None:
        # 执行节点会盖 case_id,但状态文件可能是手工改过的;没有 case_id 的
        # 记录挂不到任何用例上,只能丢弃,不能让它污染统计。
        self.assertEqual(effective_results([{"verdict": "PASS"}]), {})


class SummaryTest(unittest.TestCase):
    def test_counts_and_rates(self) -> None:
        cases = [_case(f"TC-0{i}") for i in range(1, 5)]
        results = [
            _result("TC-01", "PASS"),
            _result("TC-02", "FAIL"),
            _result("TC-03", "BLOCKED"),
            _result("TC-04", "INCONCLUSIVE"),
        ]
        summary = compute_summary(cases, results)
        self.assertEqual(
            summary,
            {
                "total": 4, "passed": 1, "failed": 1, "blocked": 1, "inconclusive": 1,
                # 分母只含 PASS + FAIL:阻塞/判不了的用例不稀释失败率。
                "pass_rate": 0.5,
                # 4 条里只有 2 条给出了确定结论。
                "valid_rate": 0.5,
            },
        )

    def test_unexecuted_cases_drag_down_valid_rate(self) -> None:
        """没跑起来的用例必须拖低 valid_rate,不能在报告里隐身。"""
        cases = [_case("TC-01"), _case("TC-02")]
        summary = compute_summary(cases, [_result("TC-01", "PASS")])
        self.assertEqual(summary["total"], 2)
        self.assertEqual(summary["valid_rate"], 0.5)
        self.assertEqual(summary["pass_rate"], 1.0)

    def test_empty(self) -> None:
        summary = compute_summary([], [])
        self.assertEqual(summary["total"], 0)
        self.assertEqual(summary["pass_rate"], 0.0)
        self.assertEqual(summary["valid_rate"], 0.0)


class CoverageTest(unittest.TestCase):
    def setUp(self) -> None:
        self.models = [
            {"model_id": "BM-01", "function": "下单", "test_depth": "critical"},
            {"model_id": "BM-02", "function": "退款", "test_depth": "low"},
        ]
        self.scenarios = [
            {"scenario_id": "SC-01", "scenario_name": "下单"},
            {"scenario_id": "SC-09", "scenario_name": "没出用例的场景"},
        ]

    def test_groups_and_uncovered(self) -> None:
        cases = [_case("TC-01", "BM-01", ["并发", "输入"])]
        coverage = compute_coverage(cases, self.models, self.scenarios, [_result("TC-01", "FAIL")])

        self.assertEqual(
            [(r["name"], r["total"], r["failed"]) for r in coverage["by_function"]],
            [("下单", 1, 1)],
        )
        self.assertEqual([r["name"] for r in coverage["by_risk_level"]], ["critical"])
        # 一条用例打了两个维度,两行各计一次。
        self.assertEqual(
            sorted(r["name"] for r in coverage["by_test_dimension"]), ["并发", "输入"]
        )

        uncovered = " | ".join(coverage["uncovered"])
        self.assertIn("BM-02", uncovered)     # 行为模型没用例
        self.assertIn("SC-09", uncovered)     # 场景没出用例

    def test_unexecuted_cases_listed_as_uncovered(self) -> None:
        coverage = compute_coverage([_case("TC-01", "BM-01")], self.models, [], [])
        self.assertTrue(any("未被执行" in item for item in coverage["uncovered"]))

    def test_rows_sorted_by_problem_count(self) -> None:
        """问题多的排前面,读报告的人一眼看到该看哪里。"""
        models = [
            {"model_id": "BM-01", "function": "甲", "test_depth": "low"},
            {"model_id": "BM-02", "function": "乙", "test_depth": "low"},
        ]
        cases = [_case("TC-01", "BM-01"), _case("TC-02", "BM-02")]
        results = [_result("TC-01", "PASS"), _result("TC-02", "FAIL")]
        coverage = compute_coverage(cases, models, [], results)
        self.assertEqual([r["name"] for r in coverage["by_function"]], ["乙", "甲"])


class ReleaseGateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.models = [
            {"model_id": "BM-01", "function": "下单", "test_depth": "critical"},
            {"model_id": "BM-02", "function": "退款", "test_depth": "low"},
        ]

    def _gate(self, cases, results):
        return compute_release_gate(cases, self.models, results)

    def test_passes_when_high_risk_all_green(self) -> None:
        passed, violations = self._gate(
            [_case("TC-01", "BM-01"), _case("TC-02", "BM-02")],
            [_result("TC-01", "PASS"), _result("TC-02", "FAIL")],   # 低风险失败不拦
        )
        self.assertTrue(passed)
        self.assertEqual(violations, [])

    def test_blocked_and_inconclusive_also_block_release(self) -> None:
        """"不知道有没有问题"在发布决策里和"有问题"是同一档。"""
        for verdict in ("FAIL", "BLOCKED", "INCONCLUSIVE"):
            with self.subTest(verdict=verdict):
                passed, violations = self._gate(
                    [_case("TC-01", "BM-01")], [_result("TC-01", verdict)]
                )
                self.assertFalse(passed)
                self.assertIn(verdict, violations[0])

    def test_unexecuted_high_risk_case_blocks_release(self) -> None:
        passed, violations = self._gate([_case("TC-01", "BM-01")], [])
        self.assertFalse(passed)
        self.assertIn("未执行", violations[0])

    def test_high_risk_function_without_any_case_blocks_release(self) -> None:
        passed, violations = self._gate([_case("TC-02", "BM-02")], [_result("TC-02", "PASS")])
        self.assertFalse(passed)
        self.assertIn("没有任何用例覆盖", violations[0])


if __name__ == "__main__":
    unittest.main()
