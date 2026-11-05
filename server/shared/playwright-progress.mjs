// Turn low-level Playwright MCP calls into progress a test engineer can follow.
// Never expose values typed into forms: prompts/logs may contain credentials or tokens.
const clean=value=>typeof value==='string'?value.replace(/\s+/g,' ').trim().slice(0,120):'';
const sensitive=value=>/[?&]|\b(?:value|token|secret|password|cookie|authorization)\s*[=:]|@|\b[A-Za-z0-9_-]{32,}\b/i.test(value);
const safeName=value=>{const name=clean(value);return name&&!sensitive(name)?name:''};
const safeURL=value=>{
  try { const url=new URL(value); return `${url.origin}${url.pathname}`; }
  catch { return /^\/(?!\/)[^?&#\s]*$/.test(value)?value:''; }
};
const target=input=>{
  for(const key of ['element','selector','target','locator','ref']){
    const name=safeName(input?.[key]);if(name)return name;
  }
  return typeof input?.url==='string'?safeURL(input.url):'';
};
// Read only static locator names, never fill values or arbitrary Playwright code.
const codeTargets=input=>{
  const code=typeof input?.code==='string'?input.code:typeof input?.function==='string'?input.function:typeof input?.expression==='string'?input.expression:'';
  const names=[];
  for(const pattern of [/getByRole\(\s*['"`](?:button|link|textbox|checkbox|radio|switch|tab|menuitem|option)['"`]\s*,\s*\{[^}]{0,120}\bname\s*:\s*['"`]([^'"`]+)['"`]/g,
    /getBy(?:Label|Placeholder)\(\s*['"`]([^'"`]+)['"`]/g,
    /\.locator\(\s*['"`]([^'"`]+)['"`]/g, /\bname\s*:\s*['"`]([^'"`]+)['"`]\s*,\s*selector\s*:/g]){
    for(const match of code.matchAll(pattern)){
      const name=safeName(match[1]);if(name&&!names.includes(name))names.push(name);
      if(names.length>=5)break;
    }
  }
  return names;
};
const describedTargets=names=>names.length?`：${names.slice(0,3).join('、')}${names.length>3?` 等 ${names.length} 个控件`:''}`:'';
// The model's browser code is useful for diagnosis, but may inline test credentials.
// Keep executable structure and locators while masking values passed to input APIs.
export function describePlaywrightCode(input={}){
  const source=['code','function','expression'].map(key=>input?.[key]).find(value=>typeof value==='string');
  if(!source)return '';
  return source
    .replace(/(\.(?:fill|type|pressSequentially|setInputFiles)\s*\(\s*)(['"`])(?:\\.|(?!\2)[\s\S])*?\2/gi,'$1"[REDACTED]"')
    .replace(/((?:password|passwd|secret|token|authorization|cookie|api[_-]?key)\s*[:=]\s*)(['"`])(?:\\.|(?!\2)[\s\S])*?\2/gi,'$1"[REDACTED]"')
    .replace(/(https?:\/\/[^\s'"`?#]+)\?[^\s'"`#]*/gi,'$1?[REDACTED]')
    .slice(0,12000);
}
export function describePlaywrightIntent(input, fallback){
  return safeName(input?.intent)||fallback;
}
export function describePlaywrightResult(tool,content){
  const text=(Array.isArray(content)?content:[]).filter(item=>item?.type==='text'&&typeof item.text==='string').map(item=>item.text).join('\n');
  if(tool==='browser_snapshot'){
    const url=/\bPage URL:\s*(\S+)/i.exec(text)?.[1];
    const page=url&&safeURL(url);
    return page?`读取页面控件与状态：${page}`:'';
  }
  if(tool!=='browser_evaluate'&&tool!=='browser_run_code_unsafe')return '';
  const result=text.includes('### Result')?text.split('### Result')[1].split(/\n###\s/)[0]:text;
  if(!/\bclippedByAncestor\b/.test(result)||!/\bselector\b/.test(result))return '';
  const names=[...result.replace(/\\"/g,'"').matchAll(/\bname\s*["']?\s*:\s*["']([^"']+)["']/g)]
    .map(match=>safeName(match[1])).filter((name,index,all)=>name&&all.indexOf(name)===index);
  return names.length?`批量检查控件布局${describedTargets(names)}`:'';
}
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
  if(name==='browser_run_code_unsafe')return `操作并读取控件${describedTargets(codeTargets(input))}`;
  if(name==='browser_evaluate')return `检查控件状态${describedTargets(codeTargets(input))}`;
  if(/evaluate|script/.test(name))return withTarget('检查页面状态','');
  if(/write.*test/.test(name))return '写入并验证测试脚本';
  return item?`检查控件或页面状态：${item}`:'检查当前页面状态';
}
