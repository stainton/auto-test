"""端到端装配测试:用假 LLMClient 把整条流程跑一遍。

验的是接线,不是模型质量:reads/writes 接得对不对、ForEach 的游标与累积写入
对不对、报告三级刷新是不是同一份、发布闸门有没有真的压住乐观结论。
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bumaren_agent_workflow.engine.context import RunContext
from bumaren_agent_workflow.state.backends.json_file import JsonFileStateStore

from schemas.state import empty_state
from tests import data
from tests.fakes import ScriptedLLMClient
from workflow import build_workflow

_REQUIREMENT_DOC = "# 需求\n下单与取消订单。\n"

# key = response_schema 顶层字段名排序后的元组,见 tests/fakes.py
_K_MODELS = ("auto_test_state.behavior_models",)
_K_SCENARIOS = ("auto_test_state.test_scenarios",)
_K_CASES = ("designed_cases",)
_K_EXEC = ("execution_result",)
_K_DEFECTS = ("auto_test_state.defects", "auto_test_state.test_gaps")
_K_REG_PLAN = ("auto_test_state.regression_plan",)
_K_REG_VERDICT = ("auto_test_state.regression_conclusion",)
_K_CONCLUSION = ("conclusion",)


def _script() -> dict:
    return {
        _K_MODELS: [
            {"auto_test_state.behavior_models": data.BEHAVIOR_MODELS_CORE},
            {"auto_test_state.behavior_models": data.BEHAVIOR_MODELS_RISKED},
            {"auto_test_state.behavior_models": data.BEHAVIOR_MODELS_FULL},
        ],
        _K_SCENARIOS: [{"auto_test_state.test_scenarios": data.TEST_SCENARIOS}],
        _K_CASES: [
            {"designed_cases": data.CASES_SC01},
            {"designed_cases": data.CASES_SC02},
        ],
        _K_EXEC: [
            {"execution_result": data.EXECUTION_INITIAL_FAIL},      # TC-01 首轮
            {"execution_result": data.EXECUTION_INITIAL_PASS},      # TC-02 首轮
            {"execution_result": data.EXECUTION_REGRESSION_PASS},   # TC-01 回归
        ],
        _K_DEFECTS: [
            {
                "auto_test_state.defects": data.DEFECTS,
                "auto_test_state.test_gaps": data.TEST_GAPS,
            }
        ],
        _K_REG_PLAN: [{"auto_test_state.regression_plan": data.REGRESSION_PLAN}],
        _K_REG_VERDICT: [{"auto_test_state.regression_conclusion": data.REGRESSION_CONCLUSION}],
        _K_CONCLUSION: [data.OPTIMISTIC_CONCLUSION],
    }


class WorkflowAssemblyTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.out = Path(self._tmp.name)
        doc = self.out / "req.md"
        doc.write_text(_REQUIREMENT_DOC, encoding="utf-8")

        self.client = ScriptedLLMClient(_script())
        self.store = JsonFileStateStore(self.out / "state.json")
        self.store.load(empty_state())
        self.ctx = RunContext(state=self.store)
        self.workflow = build_workflow(
            client_factory=lambda _stage, _model: self.client,
            requirement_doc=str(doc),
            output_dir=self.out,
            run_id="run-test",
            started_at="2026-08-24T00:00:00",
            env="staging",
            build="abc123",
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _state(self) -> dict:
        return self.store.snapshot()["auto_test_state"]

    def test_end_to_end(self) -> None:
        self.workflow.run(self.ctx, {})
        state = self._state()

        # 1/2/3:行为模型被逐步补齐,而不是被后一步覆盖成半份。
        self.assertEqual(len(state["behavior_models"]), 2)
        self.assertEqual(state["behavior_models"][0]["test_depth"], "critical")
        self.assertTrue(state["behavior_models"][0]["test_dimensions"])
        self.assertTrue(state["behavior_models"][0]["side_effects"])

        # 5:ForEach 逐场景设计的用例是累积的,不是最后一轮覆盖前面的。
        self.assertEqual([c["case_id"] for c in state["test_cases"]], ["TC-01", "TC-02"])

        # 6:执行结果按用例累积,case_id 与 round 由代码盖章。
        initial = [r for r in state["execution_results"] if r["round"] == "initial"]
        self.assertEqual([(r["case_id"], r["verdict"]) for r in initial],
                         [("TC-01", "FAIL"), ("TC-02", "PASS")])

        # 8:回归只跑了去重且存在的用例(计划里 TC-01 重复一次、TC-99 不存在)。
        self.assertEqual([c["case_id"] for c in state["regression_cases"]], ["TC-01"])
        regression = [r for r in state["execution_results"] if r["round"] == "regression"]
        self.assertEqual([(r["case_id"], r["verdict"]) for r in regression], [("TC-01", "PASS")])
        self.assertEqual(state["regression_conclusion"]["conclusion"], "回归通过")

        # 9:最终报告是 L3,统计按"每条用例的最后一次执行"算 —— 回归通过后
        # TC-01 应当被算成 PASS,而不是还挂着首轮的 FAIL。
        report = state["report"]
        self.assertEqual(report["level"], "L3")
        self.assertEqual(report["report_id"], "RPT-run-test")
        self.assertEqual(report["summary"], {
            "total": 2, "passed": 2, "failed": 0, "blocked": 0, "inconclusive": 0,
            "pass_rate": 1.0, "valid_rate": 1.0,
        })
        self.assertTrue(report["release_gate_passed"])
        self.assertTrue((self.out / "test_report.md").is_file())
        self.assertTrue((self.out / "test_report.json").is_file())

        # 失败明细的口径必须和 summary 一致:TC-01 首轮 FAIL、回归已 PASS,
        # 报告里不能既算它 PASS、又把它列进失败明细。
        md = (self.out / "test_report.md").read_text("utf-8")
        failure_section = md.split("## 三、失败用例明细")[1].split("## 四、")[0]
        self.assertIn("没有判为 FAIL 的用例", failure_section)
        self.assertIn("已被后续执行取代的历史结果", failure_section)

    def test_report_is_emitted_right_after_execution(self) -> None:
        """docs/8 的核心要求:执行一结束就能出报告,不必等缺陷分析与回归。"""
        seen: list[tuple[str, str | None]] = []
        self.ctx.hooks = _RecordingHooks(seen, self.store)
        self.workflow.run(self.ctx, {})

        stages = [name for name, _ in seen]
        self.assertLess(stages.index("report_output_L1"), stages.index("defect_analysis"))

        # L1 落地那一刻,报告里已经有完整的执行统计,但缺陷分析还没跑。
        level_at_l1 = dict(seen)["report_output_L1"]
        self.assertEqual(level_at_l1, "L1")

        # 三级写的是同一份报告(report_id 不变),不是三份互不相干的报告。
        self.assertEqual(self._state()["report"]["report_id"], "RPT-run-test")

    def test_release_gate_overrides_optimistic_model(self) -> None:
        """高风险功能首轮 FAIL 时,L1/L2 报告不得给出"可发布"。"""
        captured: dict[str, dict] = {}

        def after_stage(name: str, _outputs: dict) -> None:
            if name == "report_output_L2":
                captured["L2"] = json.loads((self.out / "test_report.json").read_text("utf-8"))

        self.ctx.hooks = _AfterStageHooks(after_stage)
        self.workflow.run(self.ctx, {})

        report = captured["L2"]["report"]
        self.assertFalse(report["release_gate_passed"])
        self.assertTrue(report["gate_violations"])
        # 假模型给的是"可发布",代码必须把它压下去。
        self.assertNotEqual(report["conclusion"]["release_suggestion"], "可发布")
        self.assertTrue(
            any("发布闸门未通过" in risk for risk in report["conclusion"]["residual_risk"])
        )

    def test_regression_skipped_when_no_defects(self) -> None:
        script = _script()
        script[_K_DEFECTS] = [{"auto_test_state.defects": [], "auto_test_state.test_gaps": []}]
        self.client = ScriptedLLMClient(script)
        doc = self.out / "req.md"
        self.workflow = build_workflow(
            client_factory=lambda _stage, _model: self.client,
            requirement_doc=str(doc),
            output_dir=self.out,
            run_id="run-test",
            started_at="2026-08-24T00:00:00",
        )
        seen: list[tuple[str, str | None]] = []
        self.ctx.hooks = _RecordingHooks(seen, self.store)
        self.workflow.run(self.ctx, {})

        stages = [name for name, _ in seen]
        self.assertNotIn("regression_scope", stages)
        self.assertNotIn("regression_execution", stages)
        # 跳过回归不等于跳过报告:仍然要出最终报告,并如实说明没有回归。
        self.assertIn("report_output_L3", stages)
        md = (self.out / "test_report.md").read_text("utf-8")
        self.assertIn("没有需要回归的缺陷", md)


class _RecordingHooks:
    """记录每个 stage 结束时的报告级别,用来断言"报告在什么时刻出过"。"""

    def __init__(self, sink: list, store) -> None:
        self._sink = sink
        self._store = store
        self.before_stage = None
        self.before_loop_iteration = None
        self.after_loop_iteration = None
        self.on_checkpoint = None

    def after_stage(self, name: str, _outputs: dict) -> None:
        report = self._store.get("auto_test_state.report") or {}
        self._sink.append((name, report.get("level")))


class _AfterStageHooks:
    def __init__(self, fn) -> None:
        self.after_stage = fn
        self.before_stage = None
        self.before_loop_iteration = None
        self.after_loop_iteration = None
        self.on_checkpoint = None


if __name__ == "__main__":
    unittest.main()
