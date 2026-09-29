import { createRequire } from 'node:module';
import path from 'node:path';

// Use the TypeScript parser already shipped with the pinned Playwright runtime.
const require = createRequire(import.meta.url);
const { babelParse, traverse } = require(path.join(path.dirname(require.resolve('playwright/package.json')), 'lib/transform/babelBundle.js'));
const member = (node, name) => node?.type === 'MemberExpression' &&
  (node.computed ? node.property.value === name : node.property.name === name);
const isStep = node => member(node?.callee, 'step') && node.callee.object?.name === 'test';

// Resolve calls through lexical bindings, rather than requiring literal page/testInfo variable names.
// Ignore comments, strings and uncalled functions; visit nested test steps independently.
function evidenceIn(root, seen = new Set()) {
  if (!root?.node || seen.has(root.node)) return { screenshot: false, attach: false };
  seen.add(root.node);
  const found = { screenshot: false, attach: false };
  const merge = child => { const next = evidenceIn(child, seen); found.screenshot ||= next.screenshot; found.attach ||= next.attach; };
  const inspect = call => {
    if (isStep(call.node)) return;
    found.screenshot ||= member(call.node.callee, 'screenshot');
    found.attach ||= member(call.node.callee, 'attach');
    if (call.node.callee.type === 'Identifier') {
      const binding = call.scope.getBinding(call.node.callee.name)?.path;
      if (binding?.isFunctionDeclaration()) merge(binding.get('body'));
      else if (binding?.isVariableDeclarator()) {
        const init = binding.get('init');
        if (init.isArrowFunctionExpression() || init.isFunctionExpression()) merge(init.get('body'));
      }
    }
  };
  if (root.isCallExpression()) inspect(root);
  root.traverse({
    Function(p) { p.skip(); },
    CallExpression(p) { if (isStep(p.node)) p.skip(); else inspect(p); }
  });
  return found;
}

export function validateStepEvidence(code) {
  const ast = babelParse(code, 'generated.spec.ts');
  const missing = [];
  let count = 0;
  traverse(ast, { CallExpression(p) {
    if (!isStep(p.node)) return;
    const [title, callback] = p.get('arguments');
    const name = title?.node?.value ?? (title?.isTemplateLiteral() && title.node.expressions.length === 0
      ? title.node.quasis[0].value.cooked : `line ${p.node.loc.start.line}`);
    if (/^\[(setup|cleanup)\]/i.test(String(name))) return;
    count++;
    const body = callback?.isFunction() ? callback.get('body') : null;
    const evidence = evidenceIn(body);
    if (!evidence.screenshot || !evidence.attach) missing.push(String(name));
  } });
  if (!count) throw new Error('a generated script must contain business test steps');
  if (missing.length) throw new Error(`测试步骤缺少截图附件：${missing.join('；')}。请在对应步骤内截图并 attach，或调用本脚本的截图辅助函数；前置/清理步骤标记 [setup]/[cleanup]。`);
}
