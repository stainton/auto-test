"""回归 —— nodes/docs/7_regression.md。

三个节点:
  · regression_scope    —— 按 6 档优先级挑回归范围(不是全量重跑)。
  · regression_cases    —— 纯函数:把 regression_plan 里的 case_ids 解析成完整
                           用例对象,供回归那一段的 ForEach 直接遍历。
  · regression_verdict  —— 判定修复是否生效、有没有引入新问题。

回归用例本身复用设计期的用例与 Oracle,不另立判定标准——所以这里没有"回归
用例设计"节点,执行也直接复用 nodes/test_execution.py 的同一个节点。
"""

from __future__ import annotations

from bumaren_agent_workflow.engine import Node, RunContext, Stage
from bumaren_agent_workflow.llm.client import LLMClient

import prompts
from nodes.common import Isolated, make_agent
from schemas.state import (
    BEHAVIOR_MODELS_PATH,
    DEFECTS_PATH,
    EXECUTION_RESULTS_PATH,
    REGRESSION_CASES_OUTPUT_SCHEMA,
    REGRESSION_CASES_PATH,
    REGRESSION_PLAN_PATH,
    REGRESSION_SCOPE_OUTPUT_SCHEMA,
    REGRESSION_VERDICT_OUTPUT_SCHEMA,
    REGRESSION_CONCLUSION_PATH,
    TEST_CASES_PATH,
    TEST_GAPS_PATH,
)


def build_regression_scope_node(client: LLMClient) -> Node:
    agent = make_agent(
        client=client,
        system_prompt=prompts.REGRESSION_SCOPE,
        output_schema=REGRESSION_SCOPE_OUTPUT_SCHEMA,
    )
    return Isolated(
        Stage(
            name="regression_scope",
            executor=agent.run,
            # test_gaps 也要读:环境/观测缺口补上之后,上一轮被遮蔽的用例属于
            # 回归范围的第 6 档("未验证补跑"),漏掉它就等于让那部分风险
            # 一直悬着。
            reads=[DEFECTS_PATH, TEST_GAPS_PATH, BEHAVIOR_MODELS_PATH, TEST_CASES_PATH],
            writes=[REGRESSION_PLAN_PATH],
            output_schema=REGRESSION_SCOPE_OUTPUT_SCHEMA,
        )
    )


def build_regression_cases_node() -> Node:
    """纯函数节点:把回归范围里的 case_ids 解析成完整用例对象。

    不用 LLM 的理由很直接:这是一次按 id 的查表,算得出来的事不交给模型判断
    ——让模型"复述"用例只会引入抄错的风险,而回归执行必须跑的是**和首轮一模
    一样的那条用例**,否则"修复是否生效"根本没有可比性。

    模型引用了不存在的 case_id 时在这里被发现(记进 trace),而不是等到执行
    节点拿到一条空用例才莫名其妙地判 BLOCKED。
    """

    def _resolve(ctx: RunContext, inputs: dict) -> dict:
        state = inputs.get("state", {})
        cases = state.get(TEST_CASES_PATH) or []
        plan = state.get(REGRESSION_PLAN_PATH) or []
        by_id = {c.get("case_id"): c for c in cases}

        selected: list[dict] = []
        seen: set[str] = set()
        missing: list[str] = []
        for item in plan:
            for case_id in item.get("case_ids") or []:
                if case_id in seen:
                    continue          # 多组回归范围命中同一条用例,只跑一次
                case = by_id.get(case_id)
                if case is None:
                    missing.append(case_id)
                    continue
                seen.add(case_id)
                selected.append(case)

        if missing:
            ctx.emit("regression.unknown_case_ids", {"case_ids": missing})
        return {REGRESSION_CASES_PATH: selected}

    return Stage(
        name="regression_cases",
        executor=_resolve,
        reads=[TEST_CASES_PATH, REGRESSION_PLAN_PATH],
        writes=[REGRESSION_CASES_PATH],
        output_schema=REGRESSION_CASES_OUTPUT_SCHEMA,
    )


def build_regression_verdict_node(client: LLMClient) -> Node:
    agent = make_agent(
        client=client,
        system_prompt=prompts.REGRESSION_VERDICT,
        output_schema=REGRESSION_VERDICT_OUTPUT_SCHEMA,
    )
    return Isolated(
        Stage(
            name="regression_verdict",
            executor=agent.run,
            reads=[DEFECTS_PATH, REGRESSION_PLAN_PATH, EXECUTION_RESULTS_PATH],
            writes=[REGRESSION_CONCLUSION_PATH],
            output_schema=REGRESSION_VERDICT_OUTPUT_SCHEMA,
        )
    )
