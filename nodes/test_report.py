"""测试报告输出 —— nodes/docs/8_test_report.md。

**这个节点只强依赖执行结果**,缺陷分析与回归是可选的增量输入——所以执行一
结束就能出报告,不必等归因与回归跑完。这一点在 workflow.py 里的落法是:同一个
build_test_report_node() 被装配三次,分别放在执行之后(L1)、缺陷分析之后
(L2)、回归之后(L3),三次写的是同一份 report(状态里 patch 对 dict 是浅
合并,所以后面两级只覆盖它们各自更新的部分),对外始终只有一份可追溯的报告。

一次报告输出由三个 Stage 组成:

    report_metrics_<level>     纯函数:算统计、覆盖率、发布闸门
    report_conclusion_<level>  Agent:只写结论文字,且必须忠实于上面的数字
    report_output_<level>      纯函数:渲染 Markdown + JSON 落地

为什么把统计和闸门放在代码里:它们全是算得出来的,交给模型只会得到一份
似是而非、且每次都不一样的数字。模型负责的是"这些数字说明了什么",不是
"这些数字是多少"。
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from bumaren_agent_workflow.engine import Node, RunContext, Stage
from bumaren_agent_workflow.engine.primitives import Sequence
from bumaren_agent_workflow.llm.client import LLMClient

import landing
import prompts
from metrics import compute_coverage, compute_release_gate, compute_summary
from nodes.common import Isolated, make_agent
from schemas.state import (
    BEHAVIOR_MODELS_PATH,
    DEFECTS_PATH,
    EXECUTION_RESULTS_PATH,
    REGRESSION_CONCLUSION_PATH,
    REPORT_CONCLUSION_AGENT_OUTPUT_SCHEMA,
    REPORT_CONCLUSION_OUTPUT_SCHEMA,
    REPORT_METRICS_OUTPUT_SCHEMA,
    REPORT_PATH,
    RUN_META_PATH,
    TEST_CASES_PATH,
    TEST_GAPS_PATH,
    TEST_SCENARIOS_PATH,
)

REPORT_LEVELS = ("L1", "L2", "L3")

# 闸门没过时,模型仍然给出"可发布"的兜底处理:降一档,而不是直接采信。
_GATE_FALLBACK_SUGGESTION = "有条件发布"


def _build_metrics_stage(level: str) -> Node:
    def _compute(ctx: RunContext, inputs: dict) -> dict:
        state = inputs.get("state", {})
        cases = state.get(TEST_CASES_PATH) or []
        models = state.get(BEHAVIOR_MODELS_PATH) or []
        scenarios = state.get(TEST_SCENARIOS_PATH) or []
        results = state.get(EXECUTION_RESULTS_PATH) or []
        run_id = (state.get(RUN_META_PATH) or {}).get("run_id") or "unknown-run"

        gate_passed, violations = compute_release_gate(cases, models, results)
        return {
            REPORT_PATH: {
                # report_id 绑定 run_id 而不是 level:L2/L3 是对同一份报告的增量
                # 刷新,不是三份互不相干的报告。
                "report_id": f"RPT-{run_id}",
                "run_id": run_id,
                "level": level,
                "generated_at": datetime.now().isoformat(timespec="seconds"),
                "summary": compute_summary(cases, results),
                "coverage": compute_coverage(cases, models, scenarios, results),
                "release_gate_passed": gate_passed,
                "gate_violations": violations,
            }
        }

    return Stage(
        name=f"report_metrics_{level}",
        executor=_compute,
        reads=[
            RUN_META_PATH,
            TEST_CASES_PATH,
            BEHAVIOR_MODELS_PATH,
            TEST_SCENARIOS_PATH,
            EXECUTION_RESULTS_PATH,
        ],
        writes=[REPORT_PATH],
        output_schema=REPORT_METRICS_OUTPUT_SCHEMA,
    )


def _build_conclusion_stage(client: LLMClient, level: str) -> Node:
    agent = make_agent(
        client=client,
        system_prompt=prompts.REPORT_CONCLUSION,
        output_schema=REPORT_CONCLUSION_AGENT_OUTPUT_SCHEMA,
    )

    def _executor(ctx: RunContext, inputs: dict) -> dict:
        outputs = agent.run(ctx, inputs)
        conclusion = dict(outputs.get("conclusion") or {})

        # 代码算出的硬约束压住模型的乐观判断:发布闸门没过时不允许"可发布"。
        # 提示词里已经写了这条纪律,这里再兜一道——发布决策这种代价不对称的
        # 判断,不能只靠模型自觉。
        report = ctx.state.get(REPORT_PATH, default={}) or {}
        if not report.get("release_gate_passed", True) and conclusion.get(
            "release_suggestion"
        ) == "可发布":
            violations = report.get("gate_violations") or []
            conclusion["release_suggestion"] = _GATE_FALLBACK_SUGGESTION
            conclusion["residual_risk"] = [
                f"发布闸门未通过(共 {len(violations)} 项),原结论「可发布」已被自动下调为"
                f"「{_GATE_FALLBACK_SUGGESTION}」",
                *violations,
                *(conclusion.get("residual_risk") or []),
            ]
            ctx.emit("report.release_gate_override", {"level": level, "violations": violations})

        return {REPORT_PATH: {"conclusion": conclusion}}

    return Isolated(
        Stage(
            name=f"report_conclusion_{level}",
            executor=_executor,
            # 缺陷/缺口/回归三份在 L1 时是空的——那正是"尚未执行"的信号,
            # 提示词按 level 告诉模型该怎么措辞,不能把"还没分析"说成"没缺陷"。
            reads=[REPORT_PATH, DEFECTS_PATH, TEST_GAPS_PATH, REGRESSION_CONCLUSION_PATH],
            writes=[REPORT_PATH],
            output_schema=REPORT_CONCLUSION_OUTPUT_SCHEMA,
        )
    )


def _build_output_stage(level: str, output_dir: Path) -> Node:
    def _write(ctx: RunContext, inputs: dict) -> dict:
        snapshot = ctx.state.snapshot()
        md_path = output_dir / "test_report.md"
        json_path = output_dir / "test_report.json"
        output_dir.mkdir(parents=True, exist_ok=True)
        md_path.write_text(landing.render_report_markdown(snapshot), encoding="utf-8")
        json_path.write_text(
            landing.render_report_json(snapshot), encoding="utf-8"
        )
        return {"report_level": level, "report_markdown": str(md_path), "report_json": str(json_path)}

    # 落地要看整棵状态树(缺陷、缺口、回归都要进报告正文),用 snapshot() 取,
    # 不声明 reads —— 这里不是喂给 LLM 的上下文切片,没有成本问题。
    return Stage(name=f"report_output_{level}", executor=_write)


def build_test_report_node(client: LLMClient, level: str, output_dir: str | Path) -> Node:
    """构建一次报告输出。

    Args:
        client: LLMClient(只有结论那一步用得到)。
        level: "L1" 执行报告 / "L2" 缺陷报告 / "L3" 完整报告。
        output_dir: 报告落地目录。三级写的是同一对文件,后一级覆盖前一级。
    """
    if level not in REPORT_LEVELS:
        raise ValueError(f"未知的报告级别 {level!r},应为 {REPORT_LEVELS} 之一")
    return Sequence(
        name=f"test_report_{level}",
        nodes=[
            _build_metrics_stage(level),
            _build_conclusion_stage(client, level),
            _build_output_stage(level, Path(output_dir)),
        ],
    )
