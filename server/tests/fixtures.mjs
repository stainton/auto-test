export const input = {
  requirements: [{ id: 'REQ-001', title: '登录', content: '错误密码应被拒绝。' }],
  target: { baseUrl: 'https://example.test/login' },
  context: { explorationNotes: 'Existing login form', testData: { password: 'super-secret-password' } }
};
export const output = {
  cases: [{ request: 'REQ-001', name: '拒绝错误密码', case_id: 'TC-LOGIN-001', priority: 'P1',
    precondition: '存在测试账号', description: '验证错误密码被拒绝', steps: ['打开登录页', '输入错误密码并提交'], expects: ['显示表单', '显示错误提示'] }],
  explorationNotes: 'Existing login form\nObserved error message', limitations: []
};
export async function eventually(check, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Condition did not become true');
}
