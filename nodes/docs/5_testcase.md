## 测试用例

根据分析得出的场景和行为模型，设计出可执行的测试用例

输入：行为模型、测试场景
输出：可执行的测试用例

一条用例必须回答三个问题：
1. 做什么（steps）
2. 看哪里（observations，观测点）
3. 凭什么判定（oracle，判定准则 → PASS / FAIL / BLOCKED / INCONCLUSIVE）

只有 `expected_result` 而没有 `observation` 的用例是不可执行的：执行者不知道从哪个通道取值。
只有 `observation` 而没有 `oracle` 的用例是不可判定的：拿到值也不知道算通过还是失败。

### 测试用例的模型

基础模型：
```json
{
    "case_id": "case id",
    "case_name": "case name",
    "scenario_id": "scenario id",
    "model_id": "对应的行为模型 id",
    "priority": "critical/high/medium/low",
    "test_dimension": ["输入-超范围", "并发-重复提交"],
    "precondition": "precondition",
    "steps": [
        {
            "step_id": "S1",
            "action": "调用 POST /order/pay，body={...}",
            "observations": ["OBS-1", "OBS-2"]
        }
    ],
    "observations": [
        {
            "observation_id": "OBS-1",
            "channel": "api_response/database/cache/mq/log/third_party/ui/metrics/file",
            "target": "具体观测对象，如 response.body.code / t_order.status / topic:order_paid",
            "method": "如何取得该观测值，如 HTTP 响应体、SQL 查询、消费指定 topic、查询日志关键字",
            "timing": "immediate/after_step_S1/eventually_within_5s",
            "required": true
        }
    ],
    "expected_result": ["result1", "result2"],
    "oracle": {
        "assertions": [
            {
                "assertion_id": "A1",
                "observation_id": "OBS-1",
                "rule": "equals/not_equals/contains/matches/in_range/absent/exists/changed_from_to/count_eq",
                "expected": "期望值",
                "severity": "blocker/critical/major/minor",
                "rationale": "该断言对应的业务规则或风险点"
            }
        ],
        "verdict_rules": {
            "BLOCKED": "前置条件未满足、环境/依赖不可用、上游用例失败导致本用例无法执行",
            "INCONCLUSIVE": "用例已执行，但 required=true 的观测点缺失或不可信，无法判定",
            "FAIL": "任一断言被明确违反",
            "PASS": "全部断言满足，且所有 required 观测点均已取得"
        }
    },
    "cleanup": ["恢复数据/释放资源的动作"],
    "verdict": "PASS/FAIL/BLOCKED/INCONCLUSIVE",
    "evidence": ["实际观测值、日志、截图、trace_id 等留痕"]
}
```

### Observation（观测点）

观测点描述**在哪个通道、对哪个对象、用什么方式、在什么时刻**取值。
设计观测点时，除接口返回值外，必须覆盖行为模型中的 `状态变化`、`数据变化`、`副作用`：

- api_response：状态码、业务码、响应体字段、响应头、耗时
- database：记录是否存在、字段值、状态字段的前后变化、行数
- cache：key 是否写入/失效、值是否与 DB 一致
- mq：是否投递、消息体、投递次数（重复消费）
- log：关键日志、错误堆栈、幂等拦截日志
- third_party：是否调用下游、调用参数、调用次数（重试/重复扣款）
- ui：页面展示、按钮状态、跳转
- metrics：计数、耗时、错误率
- file：导出文件、对账文件内容

约定：
- 一个观测点只观测一件事，便于断言定位。
- `required=true` 表示缺失该观测值就无法判定用例（影响 INCONCLUSIVE）。
- 异步副作用必须写明 `timing`（如 `eventually_within_5s`），否则无法区分"没发生"和"还没发生"。
- **负向观测**同样要写：期望"不发生"的事（不发消息、不扣款、不落库）必须有对应观测点，用 `absent` 断言。

### Oracle（判定准则）

Oracle = 断言集合 + 判定规则，输出四种结论之一：

| 结论 | 含义 | 典型原因 |
|------|------|----------|
| PASS | 系统行为符合预期 | 全部断言满足 |
| FAIL | 系统行为与预期不符，疑似缺陷 | 断言被违反 |
| BLOCKED | 用例未能执行 | 前置条件不满足、环境不可用、依赖服务宕机、账号权限缺失、前序用例失败 |
| INCONCLUSIVE | 已执行但无法判定 | 观测点取不到值、数据被其他用例污染、异步超时无法区分、日志缺失、结果不稳定（flaky） |

判定顺序（先命中先返回）：

```
1. 前置条件/环境/依赖不可用            -> BLOCKED
2. 存在被明确违反的断言                -> FAIL
3. 存在 required 观测点缺失或不可信    -> INCONCLUSIVE
4. 其余                               -> PASS
```

> FAIL 优先于 INCONCLUSIVE：只要已经抓到确凿的错误行为，就应判为 FAIL，不因其他观测点缺失而降级。

BLOCKED 与 INCONCLUSIVE 不是缺陷，但**必须进入缺陷分析节点**：它们代表测试能力的缺口（环境、数据、可观测性），由缺陷分析节点产出改进项，见 `6_defect_analysis.md`。
