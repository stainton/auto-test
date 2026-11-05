export const FIXED_VIEWPORT = Object.freeze({ width: 2560, height: 1440 });

export function assertFixedViewportTool(tool, input = {}) {
  const code = [input.code, input.function, input.expression].filter(value => typeof value === 'string').join('\n');
  if (tool === 'browser_resize' || /\b(?:setViewportSize|resizeTo)\s*\(/.test(code))
    throw new Error('viewport resize 禁止：固定 2560x1440 视口；请滚动页面或容器寻找控件');
}
