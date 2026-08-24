"""用例执行 —— 抽象执行节点(设计文档里没有对应条目,规格见本 docstring)。

**这是一个刻意保持抽象的节点。** 它只规定"拿一条用例、想办法执行掉、按
Oracle 给出 PASS/FAIL/BLOCKED/INCONCLUSIVE 之一",不规定用什么手段执行。

怎么适配到真实环境:给 `toolsets` 传能力即可,节点结构一个字都不用改——
这正是框架"换场景 = 换 ToolSet,不改结构"的落点。典型的挂法:

    from bumaren_agent_workflow.agent.toolset import ToolSet
    from bumaren_agent_workflow.tools.mcp import MCPServer

    http_tools = ToolSet.from_funcs("http", [get, post, ...])       # 接口执行
    db_tools   = ToolSet.from_funcs("db", [query, ...])             # 数据库观测
    with MCPServer.stdio("playwright", command="npx",
                         args=["@playwright/mcp@latest"]) as srv:   # UI 执行
        node = build_test_execution_node(client, item_path,
                                         toolsets=(http_tools, db_tools, srv.toolset()))

没挂任何 ToolSet 时,这个节点仍然能跑完整个流程,但它够不到任何观测通道,
按 prompts.TEST_EXECUTION 的纪律只能产出 BLOCKED / INCONCLUSIVE。这不是
退化,而是正确行为:执行结论必须来自真的观测到的现象,推理出来的 PASS 会让
一个从未被验证过的功能带着"已通过"进入发布决策。
"""

from __future__ import annotations

from typing import Sequence

from bumaren_agent_workflow.agent import ToolSet
from bumaren_agent_workflow.engine import Node, RunContext, Stage
from bumaren_agent_workflow.llm.client import LLMClient

import prompts
from nodes.common import AppendToState, Isolated, make_agent
from schemas.state import (
    EXECUTION_RESULTS_PATH,
    TEST_EXECUTION_AGENT_OUTPUT_SCHEMA,
    TEST_EXECUTION_OUTPUT_SCHEMA,
)

EXECUTION_RESULT_KEY = "execution_result"


def build_test_execution_node(
    client: LLMClient,
    case_item_path: str,
    name: str = "test_execution",
    round_: str = "initial",
    toolsets: Sequence[ToolSet] = (),
    max_steps: int = 24,
) -> Node:
    """构建"执行当前这一条用例"的节点(外层 ForEach 的 body)。

    Args:
        client: LLMClient。
        case_item_path: 外层 ForEach 发布"当前用例"的游标路径,由 workflow.py
            用 `foreach_item_path(<foreach 名>)` 算出后传进来。
        name: 节点名。首轮执行与回归执行是同一个节点的两次装配,名字要区分开,
            否则日志里分不清哪条是回归跑的。
        round_: "initial" 或 "regression",由代码盖章写进执行结果——报告要靠它
            分开统计首轮与回归,不能让模型自己填。
        toolsets: 执行能力。这是本节点唯一的适配点,见模块 docstring。
        max_steps: agentic loop 步数上限。执行是"试→看→再试"的过程,比纯生成
            类节点需要更多步,故默认值高于其它节点。
    """
    agent = make_agent(
        client=client,
        system_prompt=prompts.TEST_EXECUTION,
        toolsets=toolsets,
        max_steps=max_steps,
        output_schema=TEST_EXECUTION_AGENT_OUTPUT_SCHEMA,
    )

    def _executor(ctx: RunContext, inputs: dict) -> dict:
        # 先把当前用例的 case_id 从游标里取出来:它是"这一轮在跑哪条用例"的
        # 事实,不该让模型从一大段 JSON 里抄一遍——抄错了整份执行结果就挂到
        # 别的用例头上,后面的缺陷分析与回归验证会一路错下去。
        case = ctx.state.get(case_item_path, default={}) or {}
        outputs = agent.run(ctx, inputs)
        result = dict(outputs.get(EXECUTION_RESULT_KEY) or {})
        result["case_id"] = case.get("case_id", "")
        result["round"] = round_
        return {EXECUTION_RESULT_KEY: result}

    stage = Stage(
        name=name,
        executor=_executor,
        reads=[case_item_path],
        output_schema=TEST_EXECUTION_OUTPUT_SCHEMA,
    )
    # 每轮追加一条执行结果;同一条用例被首轮和回归各执行一次时,两条记录都要
    # 留着(回归报告要能对比修复前后),所以是 append 而不是覆盖。
    return AppendToState(Isolated(stage), EXECUTION_RESULT_KEY, EXECUTION_RESULTS_PATH)
