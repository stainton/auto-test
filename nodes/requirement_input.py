"""需求输入 —— 流程的起点,纯函数节点,不需要 LLM。

把需求文档原文读进状态,同时盖一份本次运行的元信息(run_id / env / build),
供后面的测试报告标注"这份报告是哪个环境、哪个版本、哪一次运行的产物"。
"""

from __future__ import annotations

from bumaren_agent_workflow.engine import Node, RunContext, Stage

from schemas.state import (
    REQUIREMENT_DOC_PATH,
    REQUIREMENT_INPUT_OUTPUT_SCHEMA,
    RUN_META_PATH,
)


def build_requirement_input_node(
    requirement_doc_path: str,
    run_id: str,
    started_at: str,
    env: str = "",
    build: str = "",
) -> Node:
    def _read(ctx: RunContext, inputs: dict) -> dict:
        with open(requirement_doc_path, "r", encoding="utf-8") as f:
            doc = f.read()
        return {
            REQUIREMENT_DOC_PATH: doc,
            RUN_META_PATH: {
                "run_id": run_id,
                "env": env,
                "build": build,
                "requirement_ref": requirement_doc_path,
                "started_at": started_at,
            },
        }

    return Stage(
        name="requirement_input",
        executor=_read,
        writes=[REQUIREMENT_DOC_PATH, RUN_META_PATH],
        output_schema=REQUIREMENT_INPUT_OUTPUT_SCHEMA,
    )
