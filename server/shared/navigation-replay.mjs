const roles=new Set(['button','link','tab','menuitem','option']);
const destructive=/删除|移除|清空|退出|注销|取消订单|提交|保存/;
export function replayFromNotes(notes=''){
  const out=[];for(const raw of String(notes).split('\n')){const line=raw.trim();let m=/^REPLAY:\s*goto\s+([^\s]+)$/i.exec(line);if(m&&/^\//.test(m[1]))out.push({action:'goto',url:m[1]});m=/^REPLAY:\s*click\s+(button|link|tab|menuitem|option)\s*\|\s*(.+)$/i.exec(line);if(m&&roles.has(m[1])&&m[2].trim()&&!destructive.test(m[2]))out.push({action:'click',role:m[1],name:m[2].trim().slice(0,160)});}return out.slice(-30);
}
export function replaySeed(steps=[]){
 const safe=steps.filter(s=>(s.action==='goto'&&typeof s.url==='string'&&/^\//.test(s.url))||(s.action==='click'&&roles.has(s.role)&&typeof s.name==='string'&&!destructive.test(s.name))).slice(0,30);
 const code=safe.map(s=>s.action==='goto'?`await page.goto(${JSON.stringify(s.url)},{waitUntil:'domcontentloaded',timeout:30000});await page.waitForLoadState('domcontentloaded',{timeout:10000}).catch(()=>{});`:`await page.getByRole(${JSON.stringify(s.role)},{name:${JSON.stringify(s.name)}}).click({timeout:10000});await page.waitForLoadState('domcontentloaded',{timeout:10000}).catch(()=>{});`).join('');
 return code;
}
