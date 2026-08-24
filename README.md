# auto-test

输入需求文档,产出行为模型、风险评估、测试策略、测试场景、可执行测试用例,
执行用例并输出测试报告。

流程用 [MiniAgent](https://pypi.org/project/bumaren-agent-workflow/) 框架拼装,
每个节点对应 [nodes/docs/](nodes/docs/) 下的一份设计文档。

## 流程

```
需求输入 ─ 需求建模 ─ 风险分析 ─ 测试策略            docs 1 / 2 / 3
    │
    └─ 场景设计 ─ ForEach(每个场景)用例设计          docs 4 / 5
        │
        └─ ForEach(每条用例)用例执行                 抽象节点,能力靠 ToolSet 挂载
            │
            ├─→ 测试报告 L1   ← 执行一结束就能出报告
            │
            ├─ 缺陷分析                                docs 6
            │   └─→ 测试报告 L2
            │
            └─ 回归(没有缺陷则整段跳过)               docs 7
                ├─ 回归范围 ─ 解析回归用例 ─ ForEach 回归执行 ─ 回归判定
                └─→ 测试报告 L3                        docs 8
```

三个贯穿全流程的设计点:

1. **用例带 Observation 与 Oracle。** 一条用例必须回答三件事:做什么(steps)、
   看哪里(observations)、凭什么判定(oracle)。判定结果只有四种,按
   `BLOCKED → FAIL → INCONCLUSIVE → PASS` 的顺序取,先命中先返回。
   BLOCKED 与 INCONCLUSIVE 不是缺陷,而是测试能力的缺口,由缺陷分析节点
   单独归档成 `test_gaps`——它们遮蔽的风险是"不知道有没有问题",不是"没问题"。

2. **报告出现三次,但只有一份。** 报告节点只强依赖执行结果,缺陷分析与回归是
   可选的增量输入,所以执行一结束就能出 L1;缺陷分析完刷成 L2,回归完刷成 L3,
   三次写的是同一份 `report`(report_id 绑定 run_id)。缺席的环节标记为
   "未执行"而不是省略,避免读者把"还没分析"当成"没有缺陷"。

3. **能算的不交给模型。** 统计口径(`pass_rate` 分母不含 BLOCKED/INCONCLUSIVE、
   `valid_rate` 衡量本次执行的有效性)、覆盖率分组、以及"高风险功能没全绿就
   不许说可发布"的发布闸门,全部在 [metrics.py](metrics.py) 里算好;模型只负责
   写结论文字,而且给出的"可发布"会被闸门自动压回去。

## 目录

```
nodes/                节点实现,一个模块一个(组)节点
  docs/               设计文档(流程的规格来源)
  common.py           make_agent + 三个 Node 包装类(Isolated/AppendToState/SkipIf)
schemas/state.py      跨节点共享状态与各节点的输出契约
prompts.py            流程提示词(不含任何具体业务内容)
metrics.py            报告里可计算的部分:统计、覆盖率、发布闸门
landing.py            把最终状态渲染成 Markdown / JSON 报告
workflow.py           把节点拼成 Workflow
run.py                运行入口
tests/                单测(不需要 API Key)
```

## 运行

```bash
pip install -r requirements.txt
ANTHROPIC_API_KEY=sk-... python run.py \
    --requirement-doc path/to/需求文档.md \
    --output-dir output
```

也支持 `OPENAI_API_KEY` / `ZHIPU_API_KEY`;`--model` 或 `AUTOTEST_MODEL` 指定模型,
Provider 按模型名推断(`claude-*` → Anthropic,`glm-*` → 智谱,其余走 OpenAI 兼容协议)。

产物落在 `--output-dir` 下:`test_report.md`、`test_report.json`,
以及可断点续跑的 `auto_test_state.json`。中途失败后重跑同一条命令即可从失败的
顶层节点接着走,不必从头重来。

## 接入真实被测系统

[nodes/test_execution.py](nodes/test_execution.py) 是一个**刻意保持抽象**的节点:
它只规定"拿一条用例、想办法执行掉、按 Oracle 给出四种结论之一",不规定用什么手段
执行。要接到真实系统上,只需给它挂 ToolSet,工作流结构与其余节点一个字都不用改:

```python
from bumaren_agent_workflow.agent.toolset import ToolSet
from bumaren_agent_workflow.tools.mcp import MCPServer

http_tools = ToolSet.from_funcs("http", [http_get, http_post])
db_tools = ToolSet.from_funcs("db", [sql_query])

with MCPServer.stdio("playwright", command="npx", args=["@playwright/mcp@latest"]) as srv:
    workflow = build_workflow(
        ...,
        execution_toolsets=(http_tools, db_tools, srv.toolset()),
    )
```

在 [run.py](run.py) 的 `build_workflow(..., execution_toolsets=())` 处传入即可。

**不挂任何 ToolSet 时流程仍然跑得通**,但执行节点够不到任何观测通道,按提示词里的
纪律只会产出 BLOCKED / INCONCLUSIVE。这不是退化而是正确行为:执行结论必须来自真的
观测到的现象,一个推理出来的 PASS 会让从未被验证过的功能带着"已通过"进入发布决策。

## 测试

```bash
python -m unittest discover -s tests -t .
```

不需要 API Key:端到端测试用一个按 `output_schema` 返回预排产出的假 LLMClient
把整条流程跑一遍,验的是接线(reads/writes、ForEach 游标、累积写入、报告三级刷新、
发布闸门)而不是模型质量。
