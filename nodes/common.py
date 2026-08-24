"""autotest 场景各节点复用的小工具。

除了惯例的 `make_agent`,这里还有三个 Node 包装类。它们都是场景侧的业务
策略,不是控制流形状,所以按开发指南 §3.1 的做法写成"满足 Node 协议的包装
类"放在场景包里,而不是去改引擎。
"""

from __future__ import annotations

from typing import Any, Callable, Sequence

from bumaren_agent_workflow.agent import Agent, ConversationMemory, ToolSet
from bumaren_agent_workflow.engine.context import RunContext
from bumaren_agent_workflow.engine.stage import Node, StatePath
from bumaren_agent_workflow.llm.client import LLMClient
from bumaren_agent_workflow.tools.registry import ToolRegistry


def make_agent(
    client: LLMClient,
    system_prompt: str,
    toolsets: Sequence[ToolSet] = (),
    max_steps: int = 12,
    output_schema: Any | None = None,
) -> Agent:
    agent = Agent(
        client=client,
        memory=ConversationMemory(system_prompt=system_prompt),
        registry=ToolRegistry(),   # 每个 Agent 独占一张表,不共用全局注册表
        max_steps=max_steps,
        output_schema=output_schema,
    )
    for toolset in toolsets:
        agent.load_toolset(toolset)
    return agent


class Isolated:
    """丢掉上游 outputs,只让被包装节点看到自己 `reads` 声明的状态切片。

    Sequence/Workflow 会把上一个节点的 outputs 原样当作下一个节点的 inputs
    (框架的通道①)。本场景里相邻节点操作的常常是**同一份数据**——
    behavior_models 被需求建模 → 风险分析 → 测试策略 逐步补齐,上游 outputs
    和本节点 reads 读到的是同一棵树。不隔离就等于把同一份 JSON 塞进 prompt
    两遍:既烧钱,又给模型制造"哪份才是最新的"这种无谓的歧义。

    需要跨节点传递的事实一律走 State(reads/writes),不靠 inputs 顺流。
    """

    def __init__(self, node: Node) -> None:
        self._node = node
        self.name = node.name

    def run(self, ctx: RunContext, inputs: dict[str, Any]) -> dict[str, Any]:
        return self._node.run(ctx, {})


class AppendToState:
    """把被包装节点 outputs 里的某个字段追加到状态的列表路径上。

    ForEach 每轮产出的是"本轮这一项"的结果,而 `Stage.writes` 走的是
    `StateStore.patch`——对列表是整表覆盖,后一轮会把前几轮的产出冲掉。
    累积必须用 `StateStore.append`,而"追加"这个副作用表达不进 Stage 自己的
    输出契约,故包一层。

    `outputs_key` 对应的值是列表时逐个 append,否则整体作为一个元素 append。
    """

    def __init__(self, node: Node, outputs_key: str, target_path: StatePath) -> None:
        self._node = node
        self._outputs_key = outputs_key
        self._target_path = target_path
        self.name = node.name

    def run(self, ctx: RunContext, inputs: dict[str, Any]) -> dict[str, Any]:
        outputs = self._node.run(ctx, inputs)
        value = outputs.get(self._outputs_key)
        if value is None:
            return outputs
        for item in (value if isinstance(value, list) else [value]):
            ctx.state.append(self._target_path, item)
        return outputs


class SkipIf:
    """predicate 为真时整段跳过被包装节点,inputs 原样透传。

    为什么不用 Breaker:Breaker 靠抛 LoopBreak 通知**最近的外层 Loop/ForEach**,
    顶层没有循环接住它,异常会一路冒泡成 WorkflowFailure。而本场景确实需要在
    顶层表达"没有缺陷就不必跑回归这一整段"——那是好几次 LLM 调用,白跑要真
    花钱。
    """

    def __init__(
        self,
        node: Node,
        predicate: Callable[[RunContext, dict[str, Any]], bool],
        reason: str = "",
    ) -> None:
        self._node = node
        self._predicate = predicate
        self._reason = reason
        self.name = node.name

    def run(self, ctx: RunContext, inputs: dict[str, Any]) -> dict[str, Any]:
        if self._predicate(ctx, inputs):
            ctx.emit("node.skipped", {"node": self.name, "reason": self._reason})
            return inputs
        return self._node.run(ctx, inputs)
