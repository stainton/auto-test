"""把 nodes/ 下的节点拼成完整的自动化测试工作流。

对应 nodes/docs/ 下的八份设计文档,加上一个抽象的用例执行节点:

    需求输入 ─ 需求建模 ─ 风险分析 ─ 测试策略        (docs 1/2/3)
        │
        └─ 场景设计 ─ ForEach(每个场景)用例设计      (docs 4/5)
            │
            └─ ForEach(每条用例)用例执行             (抽象节点,能力靠 ToolSet 挂)
                │
                ├─→ 测试报告 L1  ← 执行一结束就能出报告
                │
                ├─ 缺陷分析                            (docs 6)
                │   └─→ 测试报告 L2
                │
                └─ 回归(无缺陷则整段跳过)             (docs 7)
                    ├─ 回归范围 ─ 解析回归用例 ─ ForEach 回归执行 ─ 回归判定
                    └─→ 测试报告 L3

三个设计要点:

1. **报告出现三次,不是三份报告。** docs/8 的核心要求是"测试报告具备在测试
   执行之后就能输出的能力":报告节点只强依赖执行结果,缺陷与回归是可选的
   增量输入。落法就是把同一个 build_test_report_node() 装配三次,分别写入
   L1/L2/L3——三次写的是同一份 report(patch 对 dict 是浅合并),对外只有
   一份可追溯的报告,只是越往后内容越全。

2. **ForEach 而不是一次性生成。** 用例设计与用例执行都按项遍历:前者让每轮
   只对着一个场景想(用例带 observations 与 oracle,是全流程最长的产物),
   后者让每条用例的执行相互隔离、失败不影响其余用例,而且下标游标天然支持
   断点续跑。

3. **回归整段可跳过。** 没有缺陷时跑回归是好几次白花钱的 LLM 调用。顶层没有
   Loop 能接住 Breaker 抛的 LoopBreak,所以用场景侧的 SkipIf 包装(见
   nodes/common.py 的说明)。
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable, Sequence as TSequence

from bumaren_agent_workflow.agent import ToolSet
from bumaren_agent_workflow.engine.primitives import ForEach, Sequence
from bumaren_agent_workflow.engine.primitives.foreach import foreach_item_path
from bumaren_agent_workflow.engine.workflow import Workflow
from bumaren_agent_workflow.llm.client import LLMClient

from nodes.common import SkipIf
from nodes.defect_analysis import build_defect_analysis_node
from nodes.regression import (
    build_regression_cases_node,
    build_regression_scope_node,
    build_regression_verdict_node,
)
from nodes.requirement_input import build_requirement_input_node
from nodes.requirement_model import build_requirement_model_node
from nodes.risk_analyze import build_risk_analyze_node
from nodes.scenario_design import build_scenario_design_node
from nodes.test_execution import build_test_execution_node
from nodes.test_report import build_test_report_node
from nodes.test_strategy import build_test_strategy_node
from nodes.testcase_design import build_testcase_design_node
from schemas.state import (
    AUTO_TEST_STATE_SCHEMA,
    DEFECTS_PATH,
    REGRESSION_CASES_PATH,
    TEST_CASES_PATH,
    TEST_SCENARIOS_PATH,
)

# args: stage_name, model_name
ClientFactory = Callable[[str, str | None], LLMClient]

# ForEach 的名字决定游标路径,两处(ForEach 自己与 body 的 reads)必须一致,
# 所以提成常量,并一律用 foreach_item_path() 拼路径,不手写字符串。
SCENARIO_FOREACH = "scenario_loop"
CASE_FOREACH = "case_execution_loop"
REGRESSION_FOREACH = "regression_execution_loop"


def build_workflow(
    client_factory: ClientFactory,
    requirement_doc: str,
    output_dir: str | Path,
    run_id: str,
    started_at: str,
    env: str = "",
    build: str = "",
    execution_toolsets: TSequence[ToolSet] = (),
) -> Workflow:
    """构建自动化测试工作流。

    Args:
        client_factory: (stage_name, model) -> LLMClient。
        requirement_doc: 需求文档 Markdown 路径。
        output_dir: 报告落地目录。
        run_id / started_at / env / build: 本次运行的元信息,写进报告抬头。
        execution_toolsets: 挂给用例执行节点的能力。**这是把这套流程接到真实
            被测系统上的唯一改动点**——HTTP、数据库、消息队列、浏览器(MCP)
            等能力从这里传进去,工作流结构与其余节点一个字都不用改。不传时
            执行节点够不到任何观测通道,只会产出 BLOCKED / INCONCLUSIVE。
    """

    def client_for(stage_name: str, model: str | None = None) -> LLMClient:
        return client_factory(stage_name, model)

    # --- 需求分析:一份需求文档 → 一组被逐步补齐的行为模型 -------------------
    requirement_analysis = Sequence(
        name="requirement_analysis",
        nodes=[
            build_requirement_input_node(
                requirement_doc_path=requirement_doc,
                run_id=run_id,
                started_at=started_at,
                env=env,
                build=build,
            ),
            build_requirement_model_node(client=client_for("requirement_model")),
            build_risk_analyze_node(client=client_for("risk_analyze")),
            build_test_strategy_node(client=client_for("test_strategy")),
        ],
    )

    # --- 测试设计:行为模型 → 场景 → 用例 -----------------------------------
    test_design = Sequence(
        name="test_design",
        nodes=[
            build_scenario_design_node(client=client_for("scenario_design")),
            ForEach(
                name=SCENARIO_FOREACH,
                items_path=TEST_SCENARIOS_PATH,
                body=build_testcase_design_node(
                    client=client_for("testcase_design"),
                    scenario_item_path=foreach_item_path(SCENARIO_FOREACH),
                ),
            ),
        ],
    )

    # --- 首轮执行 -----------------------------------------------------------
    test_execution = ForEach(
        name=CASE_FOREACH,
        items_path=TEST_CASES_PATH,
        body=build_test_execution_node(
            client=client_for("test_execution"),
            case_item_path=foreach_item_path(CASE_FOREACH),
            name="test_execution",
            round_="initial",
            toolsets=execution_toolsets,
        ),
    )

    # --- 回归:没有缺陷就整段跳过 -------------------------------------------
    regression = SkipIf(
        Sequence(
            name="regression",
            nodes=[
                build_regression_scope_node(client=client_for("regression_scope")),
                build_regression_cases_node(),
                ForEach(
                    name=REGRESSION_FOREACH,
                    items_path=REGRESSION_CASES_PATH,
                    body=build_test_execution_node(
                        client=client_for("regression_execution"),
                        case_item_path=foreach_item_path(REGRESSION_FOREACH),
                        # 名字要和首轮区分开,否则日志里分不清哪条是回归跑的。
                        name="regression_execution",
                        round_="regression",
                        toolsets=execution_toolsets,
                    ),
                ),
                build_regression_verdict_node(client=client_for("regression_verdict")),
            ],
        ),
        predicate=lambda ctx, _inputs: not ctx.state.get(DEFECTS_PATH),
        reason="缺陷分析没有产出任何缺陷,无需回归",
    )

    nodes = [
        requirement_analysis,
        test_design,
        test_execution,
        # L1:执行一结束就能出的报告,不等缺陷分析与回归。
        build_test_report_node(client_for("report_conclusion"), "L1", output_dir),
        build_defect_analysis_node(client=client_for("defect_analysis")),
        # L2:补上缺陷与测试能力缺口。
        build_test_report_node(client_for("report_conclusion"), "L2", output_dir),
        regression,
        # L3:补上回归结论,得到最终报告。
        build_test_report_node(client_for("report_conclusion"), "L3", output_dir),
    ]

    return Workflow(
        name="auto_test_workflow",
        nodes=nodes,
        state_schema=AUTO_TEST_STATE_SCHEMA,
    )
