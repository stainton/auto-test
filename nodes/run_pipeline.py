"""独立运行 function -> scenario -> testcase 流程，用于验证从需求文档到测试用例
的生成效果。

依次跑 function 节点（识别功能）、scenario 节点（为每个功能划分使用场景）与
testcase 节点（在场景范围内设计测试用例）：把需求文档整篇塞进内存态的 State
Store，跑完打印三个节点各自的产出，不落盘任何状态、不依赖其它节点——用于快速
迭代 nodes/function.py、nodes/scenario.py、nodes/testcase.py 里的 system prompt。

用法:
    ANTHROPIC_API_KEY=sk-... python -m nodes.run_pipeline \\
        --requirement-doc examples/sample_requirement.md

    # 或指定模型（据模型名自动判断走哪家 Provider：claude-* / glm-* / 其余走 OpenAI 协议）
    OPENAI_API_KEY=sk-... python -m nodes.run_pipeline \\
        --requirement-doc examples/sample_requirement.md --model gpt-4o
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from bumaren_agent_workflow.engine.context import LifecycleHooks, RunContext
from bumaren_agent_workflow.engine.primitives import Sequence
from bumaren_agent_workflow.llm.client import LLMClient
from bumaren_agent_workflow.state.backends.memory import InMemoryStateStore
from bumaren_agent_workflow.state.schema import StateSchema

from nodes.function import build_function_node
from nodes.function_schemas import (
    FUNCTIONS_PATH,
    REQUIREMENT_ANALYSIS_STATE_SCHEMA,
    REQUIREMENT_DOC_PATH,
)
from nodes.scenario import build_scenario_node
from nodes.scenario_schemas import SCENARIO_STATE_SCHEMA, SCENARIOS_PATH
from nodes.testcase import build_testcase_node
from nodes.testcase_schemas import TEST_CASES_PATH, TESTCASE_STATE_SCHEMA

_PROVIDER_DEFAULT_MODEL = {"anthropic": "claude-sonnet-latest", "openai": "gpt-4o", "zhipu": "glm-5.2"}
_PROVIDER_API_KEY_ENV = {"anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY", "zhipu": "ZHIPU_API_KEY"}

# function / scenario / testcase 各自的 state schema 顶层 key 不同
# （requirement_analysis_state / scenario_state / testcase_state），互不冲突，
# 合并成一份供同一个 State Store 校验三边的写入。
PIPELINE_STATE_SCHEMA = StateSchema(
    "pipeline_state",
    {
        **REQUIREMENT_ANALYSIS_STATE_SCHEMA.definition,
        **SCENARIO_STATE_SCHEMA.definition,
        **TESTCASE_STATE_SCHEMA.definition,
    },
)


def _infer_provider(model: str) -> str:
    """按模型名判断该用哪家 SDK：claude-* 走 Anthropic，glm-* 走智谱，其余走 OpenAI 兼容协议。"""
    if model.startswith("claude"):
        return "anthropic"
    if model.startswith("glm"):
        return "zhipu"
    return "openai"


def build_llm_client(model: str | None = None) -> LLMClient:
    """按 model（若给出）或环境变量里存在哪个 API Key 选一个 Provider 并构造 client。

    function / scenario / testcase 三个节点共用同一个 client（同一模型）；若以后
    要给某个节点单独换模型，在 main() 里分别构造对应的 client 传给对应的
    build_*_node 即可。
    """
    if model is not None:
        provider = _infer_provider(model)
    elif os.environ.get("ANTHROPIC_API_KEY"):
        provider = "anthropic"
    elif os.environ.get("OPENAI_API_KEY"):
        provider = "openai"
    elif os.environ.get("ZHIPU_API_KEY"):
        provider = "zhipu"
    else:
        raise RuntimeError(
            "需要设置 ANTHROPIC_API_KEY / OPENAI_API_KEY / ZHIPU_API_KEY 之一才能运行本脚本。"
        )

    api_key_env = _PROVIDER_API_KEY_ENV[provider]
    api_key = os.environ.get(api_key_env)
    if not api_key:
        raise RuntimeError(f"使用模型 {model!r} 需要 {provider} 的 SDK，但当前环境未设置 {api_key_env}。")
    resolved_model = model or _PROVIDER_DEFAULT_MODEL[provider]

    if provider == "anthropic":
        from bumaren_agent_workflow.llm.providers.anthropic import AnthropicClient

        return AnthropicClient(
            api_key=api_key,
            model=resolved_model,
            base_url=os.environ.get("ANTHROPIC_API_BASE_URL"),
            max_tokens=4096,
        )
    if provider == "zhipu":
        from bumaren_agent_workflow.llm.providers.zhipu import ZhipuClient

        return ZhipuClient(
            api_key=api_key,
            model=resolved_model,
            base_url=os.environ.get("ZHIPU_API_BASE_URL"),
            max_tokens=4096,
        )
    from bumaren_agent_workflow.llm.providers.openai import OpenAIClient

    return OpenAIClient(
        api_key=api_key,
        model=resolved_model,
        base_url=os.environ.get("OPENAI_API_BASE_URL"),
        max_tokens=4096,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="依次运行 function -> scenario -> testcase 节点，验证生成效果")
    parser.add_argument("--requirement-doc", type=Path, required=True, help="需求文档 Markdown 路径")
    parser.add_argument("--model", default=None, help="本次使用的模型名（默认按已设置的 API Key 自动选择 Provider）")
    args = parser.parse_args()

    if not args.requirement_doc.is_file():
        raise SystemExit(f"需求文档不存在: {args.requirement_doc}")

    client = build_llm_client(args.model)
    pipeline = Sequence(
        name="requirement_analysis_pipeline",
        nodes=[
            build_function_node(client),
            build_scenario_node(client),
            build_testcase_node(client),
        ],
    )

    state_store = InMemoryStateStore(schema=PIPELINE_STATE_SCHEMA, initial=PIPELINE_STATE_SCHEMA.empty())
    state_store.patch(REQUIREMENT_DOC_PATH, args.requirement_doc.read_text(encoding="utf-8"))

    ctx = RunContext(
        state=state_store,
        hooks=LifecycleHooks(
            before_stage=lambda name, _inputs: print(f"[stage:start] {name}"),
            after_stage=lambda name, _outputs: print(f"[stage:done]  {name}"),
        ),
    )

    pipeline.run(ctx, {})

    # 三个节点各自的产出都已经通过 Stage.writes 落进 state_store，直接从状态里
    # 读，而不是依赖 Sequence.run 的返回值（那只是最后一个节点——testcase——的
    # outputs，读不到 function/scenario 的产出）。
    functions = state_store.get(FUNCTIONS_PATH, [])
    scenarios = state_store.get(SCENARIOS_PATH, [])
    test_cases = state_store.get(TEST_CASES_PATH, [])

    print(f"\n识别到 {len(functions)} 个功能:\n")
    print(json.dumps(functions, ensure_ascii=False, indent=2))
    print(f"\n划分出 {len(scenarios)} 个场景:\n")
    print(json.dumps(scenarios, ensure_ascii=False, indent=2))
    print(f"\n设计出 {len(test_cases)} 条用例:\n")
    print(json.dumps(test_cases, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
