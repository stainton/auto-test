// Turn low-level Playwright MCP calls into progress a test engineer can follow.
// Never expose values typed into forms: prompts/logs may contain credentials or tokens.
const clean=value=>typeof value==='string'?value.replace(/\s+/g,' ').trim().slice(0,160):'';
const target=input=>clean(input?.element)||clean(input?.selector)||clean(input?.ref)||clean(input?.target)||clean(input?.locator)||clean(input?.url)||'';
export function describePlaywrightAction(tool,input={}){
  const name=String(tool||'').toLowerCase(),item=target(input),withTarget=(verb,fallback)=>`${verb}${item?`：${item}`:fallback||''}`;
  if(/setup.*page/.test(name))return '准备隔离浏览器会话并打开被测系统';
  if(/navigate|goto|open.*page/.test(name))return withTarget('打开页面','');
  if(/snapshot|accessibility/.test(name))return '读取当前页面的控件与状态';
  if(/click|tap|press/.test(name))return withTarget('定位并点击控件','');
  if(/fill|type|input/.test(name))return withTarget('定位并填写控件','');
  if(/select|option/.test(name))return withTarget('定位并选择控件','');
  if(/check|uncheck/.test(name))return withTarget('定位并切换控件','');
  if(/upload|file/.test(name))return withTarget('定位并上传文件到控件','');
  if(/screenshot/.test(name))return '截取当前页面状态';
  if(/wait/.test(name))return withTarget('等待页面状态','');
  if(/evaluate|script/.test(name))return withTarget('检查页面状态','');
  if(/write.*test/.test(name))return '写入并验证测试脚本';
  return item?`检查控件或页面状态：${item}`:'检查当前页面状态';
}
