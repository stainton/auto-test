# testcase

每个测试用例需要包含的字段
```
request: 需求id
name: 测试用例名称
case_id: 测试用例id，格式 TC-<需求缩写>-<功能模块缩写>-<测试类别>-001（缩写为大写英文/数字、不含 -；测试类别 FUNC 功能 / REL 可靠性 / PERF 性能 / SEC 安全 / COMPAT 兼容性 / UX 易用性；同一前缀下从 001 依次递增）
priority: 优先级(P0/P1/P2/P3)
precondition: 预置条件
description: 用例描述/总结——保留字段，AI 不填写（留空），由评审发起人阅读用例后在评审阶段人工填写
steps: 测试步骤(1. ... \n 2. ... 就像这样一行一步)
expects: 预期结果(1. 步骤x... 像这样提及的时候关联结果)
```

