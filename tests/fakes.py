"""测试用的假 LLMClient:按节点的 output_schema 返回预先排好的 JSON。

不调真模型也能把整条流程跑一遍,验证 reads/writes、ForEach 游标、累积写入、
报告三级刷新这些接线对不对——这类装配错误是这个场景最容易出、也最难在真实
运行里定位的问题(真跑一次要花不少 API 费用)。

路由方式:用 response_schema 顶层字段名的集合当 key。同一个 key 排多份产出时
按顺序返回(ForEach 每一项一份),用完之后一直返回最后一份。
"""

from __future__ import annotations

import json
from typing import Any

from bumaren_agent_workflow.llm.client import ChatResponse, LLMClient
from bumaren_agent_workflow.llm.message import Message


class ScriptedLLMClient(LLMClient):
    def __init__(self, script: dict[tuple[str, ...], list[dict[str, Any]]]) -> None:
        self._script = {k: list(v) for k, v in script.items()}
        self.calls: list[tuple[str, ...]] = []

    def chat(self, messages, tools=None, response_schema=None, **params) -> ChatResponse:
        if not response_schema:
            raise AssertionError("本场景的每个 Agent 都应带 output_schema")
        key = tuple(sorted(response_schema.get("properties", {})))
        self.calls.append(key)
        queue = self._script.get(key)
        if not queue:
            raise AssertionError(f"假 client 没有为 {key} 准备产出")
        payload = queue.pop(0) if len(queue) > 1 else queue[0]
        return ChatResponse(message=Message(role="assistant", content=json.dumps(payload, ensure_ascii=False)))
