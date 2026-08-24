"""运行入口。

组装 LLMClient / StateStore / RunContext,跑通 workflow.py 拼出的自动化测试
流程:读需求文档 → 需求建模 → 风险分析 → 测试策略 → 场景设计 → 用例设计 →
用例执行 → (L1 报告) → 缺陷分析 → (L2 报告) → 回归 → (L3 报告)。

用法:

    pip install bumaren-agent-workflow
    ANTHROPIC_API_KEY=sk-... python run.py \\
        --requirement-doc path/to/需求文档.md \\
        --output-dir output

中途失败时,状态与"从哪个顶层节点续跑"会被保存下来,修好问题后重跑同一条
命令即可接着走,不必从头重新生成一遍(设计与执行都是花钱的步骤,别白跑)。

**接入真实被测系统**:给 build_workflow 传 execution_toolsets 即可,见
nodes/test_execution.py 的模块 docstring。不传时执行节点够不到任何观测通道,
只会产出 BLOCKED / INCONCLUSIVE——这时跑通的是流程本身,不是被测系统。
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from bumaren_agent_workflow.engine.context import LifecycleHooks, ResumePoint, RunContext
from bumaren_agent_workflow.engine.workflow import WorkflowFailure
from bumaren_agent_workflow.llm.client import LLMClient
from bumaren_agent_workflow.llm.logging_client import LoggingLLMClient
from bumaren_agent_workflow.state.backends.json_file import JsonFileStateStore

from schemas.state import empty_state
from workflow import build_workflow

DEFAULT_OUTPUT_DIR = Path(__file__).with_name("output")
STATE_FILE_NAME = "auto_test_state.json"
RESUME_SUFFIX = ".resume.json"

_PROVIDER_DEFAULT_MODEL = {
    "anthropic": "claude-sonnet-latest",
    "openai": "gpt-4o",
    "zhipu": "glm-5.2",
}
_PROVIDER_API_KEY_ENV = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "zhipu": "ZHIPU_API_KEY",
}


# ---------------------------------------------------------------------------
# 续跑点:顶层节点游标 + 流入的 inputs
# (状态本身由 JsonFileStateStore 每次写入时就已落盘,这里只补它盖不住的部分)
# ---------------------------------------------------------------------------


def _resume_path(state_path: Path) -> Path:
    return state_path.with_name(state_path.name + RESUME_SUFFIX)


def _save_resume_point(
    state_path: Path, node_index: int, inputs: dict[str, Any], node_name: str
) -> None:
    resume_path = _resume_path(state_path)
    resume_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = resume_path.with_name(resume_path.name + ".tmp")
    payload = {"node_index": node_index, "node_name": node_name, "inputs": inputs}
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    tmp_path.replace(resume_path)


def _load_resume_point(state_path: Path) -> ResumePoint | None:
    resume_path = _resume_path(state_path)
    if not resume_path.exists():
        return None
    with resume_path.open("r", encoding="utf-8") as f:
        payload = json.load(f)
    return ResumePoint(node_index=payload["node_index"], inputs=payload["inputs"])


def _clear_resume_point(state_path: Path) -> None:
    _resume_path(state_path).unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# LLMClient
# ---------------------------------------------------------------------------


def _infer_provider(model: str) -> str:
    """按模型名判断该用哪家 SDK:claude-* 走 Anthropic,glm-* 走智谱,其余走 OpenAI 兼容协议。"""
    if model.startswith("claude"):
        return "anthropic"
    if model.startswith("glm"):
        return "zhipu"
    return "openai"


def build_llm_client(model: str | None = None, log_dir: Path | None = None) -> LLMClient:
    """按 model(若给出)或环境变量选一个 Provider 并构造 client。"""
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
            "需要设置 ANTHROPIC_API_KEY / OPENAI_API_KEY / ZHIPU_API_KEY 之一才能运行。"
        )

    api_key_env = _PROVIDER_API_KEY_ENV[provider]
    api_key = os.environ.get(api_key_env)
    if not api_key:
        raise RuntimeError(f"使用模型 {model!r} 需要 {provider} 的 SDK,但当前环境未设置 {api_key_env}。")
    resolved_model = model or os.environ.get(
        "AUTOTEST_MODEL", _PROVIDER_DEFAULT_MODEL[provider]
    )

    if provider == "anthropic":
        from bumaren_agent_workflow.llm.providers.anthropic import AnthropicClient

        client: LLMClient = AnthropicClient(
            api_key=api_key,
            model=resolved_model,
            base_url=os.environ.get("ANTHROPIC_API_BASE_URL"),
            max_tokens=16384,
        )
    elif provider == "zhipu":
        from bumaren_agent_workflow.llm.providers.zhipu import ZhipuClient

        client = ZhipuClient(
            api_key=api_key,
            model=resolved_model,
            base_url=os.environ.get("ZHIPU_API_BASE_URL"),
            max_tokens=16384,
        )
    else:
        from bumaren_agent_workflow.llm.providers.openai import OpenAIClient

        client = OpenAIClient(
            api_key=api_key,
            model=resolved_model,
            base_url=os.environ.get("OPENAI_API_BASE_URL"),
            max_tokens=16384,
        )

    if log_dir is not None:
        client = LoggingLLMClient(client, log_dir)
    return client


def make_client_factory(model: str | None = None, log_dir: Path | None = None):
    """按 model 分组、按需惰性构造并复用 LLMClient。

    workflow.py 里没有任何节点显式指定 model,所以默认全流程共用一个 client;
    要给某个节点单独换模型(例如让用例执行走更强的模型),在 workflow.py 对应
    的 client_for(...) 调用里传 model 即可,这里不用动。
    """
    clients: dict[str | None, LLMClient] = {}

    def factory(_stage_name: str, stage_model: str | None) -> LLMClient:
        key = stage_model or model
        if key not in clients:
            clients[key] = build_llm_client(key, log_dir)
        return clients[key]

    return factory


def main() -> None:
    parser = argparse.ArgumentParser(
        description="输入需求文档,产出行为模型/风险/策略/场景/用例,执行并输出测试报告"
    )
    parser.add_argument("--requirement-doc", type=Path, required=True, help="需求文档 Markdown 路径")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR, help="产物落地目录")
    parser.add_argument("--env", default="", help="被测环境标识,写进报告抬头")
    parser.add_argument("--build", default="", help="被测版本/commit,写进报告抬头")
    parser.add_argument("--model", default=None, help="本次使用的模型名(默认取 AUTOTEST_MODEL 环境变量)")
    parser.add_argument(
        "--log-chats", action="store_true", help="把每次 chat() 的请求/响应落盘到 output-dir/log"
    )
    parser.add_argument(
        "--fresh",
        action="store_true",
        help="丢弃已有状态,从零重新跑一遍(不加这个参数时会尝试接着上次的进度跑)",
    )
    args = parser.parse_args()

    # 路径写错时立刻报错,而不是跑到第一个节点才失败(那时可能已经产生 API 费用)。
    if not args.requirement_doc.is_file():
        raise SystemExit(f"需求文档不存在: {args.requirement_doc}")

    output_dir: Path = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    log_dir = (output_dir / "log") if args.log_chats else None
    state_path = output_dir / STATE_FILE_NAME

    state_store = JsonFileStateStore(state_path)
    if args.fresh:
        state_store.load(empty_state())
        _clear_resume_point(state_path)
    elif not state_store.snapshot():
        state_store.load(empty_state())

    # run_id / started_at 只在新一次运行时生成;续跑时沿用状态里已有的那份,
    # 否则同一次测试会在报告里换个身份,追溯不上前面已经落盘的产物。
    existing_meta = state_store.get("auto_test_state.run_meta") or {}
    run_id = existing_meta.get("run_id") or datetime.now().strftime("run-%Y%m%d-%H%M%S")
    started_at = existing_meta.get("started_at") or datetime.now().isoformat(timespec="seconds")

    workflow = build_workflow(
        client_factory=make_client_factory(args.model, log_dir),
        requirement_doc=str(args.requirement_doc),
        output_dir=output_dir,
        run_id=run_id,
        started_at=started_at,
        env=args.env,
        build=args.build,
        # 接入真实被测系统时在这里传 ToolSet,见 nodes/test_execution.py。
        execution_toolsets=(),
    )

    resume = _load_resume_point(state_path)
    if resume is not None:
        print(f"检测到上次未完成的运行,从顶层节点游标 {resume.node_index} 续跑,跳过已成功的前序节点。")

    ctx = RunContext(
        state=state_store,
        hooks=LifecycleHooks(
            before_stage=lambda name, _inputs: print(f"[stage:start] {name}"),
            after_stage=lambda name, _outputs: print(f"[stage:done]  {name}"),
            before_loop_iteration=lambda name, i: print(f"[loop] {name} 第 {i + 1} 项/轮"),
        ),
        resume=resume,
    )

    try:
        workflow.run(ctx, {})
    except WorkflowFailure as failure:
        _save_resume_point(state_path, failure.node_index, failure.inputs, failure.node_name)
        print(
            f"流程在节点 {failure.node_name!r}(顶层游标 {failure.node_index})执行失败:"
            f"{failure.__cause__!r}\n状态已保存到 {state_path},修复后重跑本命令即可从该节点续跑。"
        )
        raise

    _clear_resume_point(state_path)
    _print_summary(state_store.snapshot(), output_dir)


def _print_summary(snapshot: dict[str, Any], output_dir: Path) -> None:
    state = snapshot.get("auto_test_state", {}) or {}
    report = state.get("report") or {}
    summary = report.get("summary") or {}
    conclusion = report.get("conclusion") or {}

    print(f"\n已落地产物:{output_dir / 'test_report.md'} / {output_dir / 'test_report.json'}")
    print(
        f"报告级别 {report.get('level')} | 用例 {summary.get('total', 0)} 条:"
        f"PASS {summary.get('passed', 0)} / FAIL {summary.get('failed', 0)} / "
        f"BLOCKED {summary.get('blocked', 0)} / INCONCLUSIVE {summary.get('inconclusive', 0)}"
    )
    print(
        f"pass_rate {summary.get('pass_rate', 0.0):.1%} | "
        f"valid_rate {summary.get('valid_rate', 0.0):.1%} | "
        f"发布闸门 {'通过' if report.get('release_gate_passed') else '未通过'}"
    )
    print(f"发布建议:{conclusion.get('release_suggestion') or '(未给出)'}")

    gaps = state.get("test_gaps") or []
    if gaps:
        print(f"\n注意:有 {len(gaps)} 项测试能力缺口(环境/数据/可观测性),它们遮蔽的风险这次并没有被验证:")
        for gap in gaps:
            print(f"  - [{gap.get('source_verdict')}] {gap.get('description')} → {gap.get('masked_risk')}")


if __name__ == "__main__":
    main()
