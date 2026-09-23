// Executor is intentionally a separate HTTP service from design/generation. It
// runs an already-reviewed spec, collects its Playwright attachments, then asks
// the general Claude runtime to turn the evidence into a portable Markdown record.
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile, access, mkdir, symlink } from 'node:fs/promises';
import { Jobs } from '../shared/jobs.mjs';
import { createHttpServer } from '../shared/http.mjs';
import { runClaude } from '../runtime/claude.mjs';
import { resolveClaudeOptions, createReloadingRuntime, createSettingsApplier, settingsPathFor } from '../runtime/settings.mjs';

const maxCode=120000, maxArtifactBytes=8*1024*1024;
const positive=(name,fallback)=>{const n=Number(process.env[name]??fallback);if(!Number.isSafeInteger(n)||n<1)throw new Error(`${name} must be a positive integer`);return n};
const schema={type:'object',additionalProperties:false,required:['markdown'],properties:{markdown:{type:'string',minLength:1,maxLength:200000}}};
const systemPrompt=`你是测试记录整理助手。根据提供的 Playwright 脚本执行状态、控制台输出和截图清单，写一份简体中文 Markdown 测试记录。包含结论、执行信息、关键步骤/现象和失败摘要。截图只能使用给定的 {{image:文件名}} 占位符；不要写外部 URL、相对路径或引用链接。没有证据时明确说明。只返回符合 Schema 的结果。`;
function validate(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('request must be an object');
  for(const key of Object.keys(input))if(!['code','fileName','target','title'].includes(key))throw Error('request contains unsupported fields');
  if(typeof input.code!=='string'||!input.code.trim()||input.code.length>maxCode)throw Error('code must be a nonempty string');
  if(typeof input.fileName!=='string'||!input.fileName.endsWith('.spec.ts'))throw Error('fileName must end with .spec.ts');
  if(!input.target||typeof input.target!=='object'||typeof input.target.baseUrl!=='string'||!/^https?:\/\//.test(input.target.baseUrl))throw Error('target.baseUrl must be an HTTP(S) URL');
  return structuredClone(input);
}
const exec=(command,args,cwd,signal)=>new Promise(resolve=>{const child=spawn(command,args,{cwd,stdio:['ignore','pipe','pipe']});let output='';const add=x=>output=(output+x).slice(-30000);child.stdout.on('data',x=>add(x));child.stderr.on('data',x=>add(x));const abort=()=>child.kill('SIGTERM');signal.addEventListener('abort',abort,{once:true});child.on('close',code=>{signal.removeEventListener('abort',abort);resolve({code:code??1,output})});});
async function images(dir){
  const found=[];async function walk(current){for(const entry of await readdir(current,{withFileTypes:true}).catch(()=>[])){const file=path.join(current,entry.name);if(entry.isDirectory())await walk(file);else if(/\.(png|jpe?g)$/i.test(entry.name)){const data=await readFile(file);if(data.length<=maxArtifactBytes)found.push({name:entry.name,data:`data:image/${entry.name.endsWith('.png')?'png':'jpeg'};base64,${data.toString('base64')}`});}}}await walk(dir);return found;
}
export function embedArtifacts(markdown,artifacts){
  for(const image of artifacts){const token=`{{image:${image.name}}}`,embedded=`![${image.name}](${image.data})`;markdown=markdown.includes(token)?markdown.replaceAll(token,embedded):`${markdown}\n\n## 附件：${image.name}\n\n${embedded}`;}
  return markdown;
}
export async function startExecutor({host=process.env.EXECUTOR_HOST??'0.0.0.0',port=positive('EXECUTOR_PORT',4504),dataDir=process.env.EXECUTOR_DATA_DIR??path.join(tmpdir(),'auto-test-executor')}={}){
  const settings={prefix:'EXECUTOR',defaultSettingsPath:fileURLToPath(new URL('../../build/automation/setting.json',import.meta.url))};
  await resolveClaudeOptions(settings);const runtime=createReloadingRuntime(runClaude,settings),applySettings=createSettingsApplier(settingsPathFor(settings));
  const command=process.env.EXECUTOR_CLAUDE_COMMAND??process.env.AUTOMATION_CLAUDE_COMMAND??'claude';execFileSync(command,['--version'],{timeout:10000,stdio:'ignore'});
  const require=createRequire(import.meta.url),pkg=require.resolve('@playwright/test/package.json'),cli=path.join(path.dirname(pkg),'cli.js'),nodeModules=path.dirname(path.dirname(path.dirname(pkg)));await access(cli);
  const worker=async(input,{signal,emit})=>{const workspace=await mkdtemp(path.join(tmpdir(),'executor-'));try{
    // Keep the spec in an isolated project. The temporary node_modules link makes
    // @playwright/test resolve from the spec's own directory without writing into /app.
    emit({stage:'running',message:'Running Playwright script'});const project=path.join(workspace,'project');await mkdir(project,{mode:0o700});await symlink(nodeModules,path.join(project,'node_modules'),'dir');const spec=path.join(project,path.basename(input.fileName));
    await writeFile(spec,input.code,{mode:0o600});const config={testDir:project,testMatch:path.basename(spec),workers:1,retries:0,timeout:60000,outputDir:path.join(workspace,'test-results'),reporter:[['json',{outputFile:path.join(workspace,'report.json')}]],use:{headless:true,browserName:'chromium',baseURL:input.target.baseUrl,screenshot:'off',trace:'off',video:'off'}};
    const configPath=path.join(project,'playwright.config.cjs');await writeFile(configPath,`module.exports=${JSON.stringify(config)};\n`,{mode:0o600});const run=await exec(process.execPath,[cli,'test','--config',configPath],project,signal);const artifacts=await images(path.join(workspace,'test-results'));
    emit({stage:'summarizing',message:'Organizing execution evidence into Markdown'});const controller=new AbortController(),timer=setTimeout(()=>controller.abort(Error('Record summarization timed out')),positive('EXECUTOR_SUMMARY_TIMEOUT_MS',120000));let markdown;
    try{const output=await runtime({cwd:workspace,prompt:JSON.stringify({title:input.title||input.fileName,passed:run.code===0,output:run.output,images:artifacts.map(a=>a.name)}),systemPrompt,schema,mcpConfig:{mcpServers:{}},allowedTools:[],command,signal:controller.signal,env:{CLAUDE_CONFIG_DIR:path.join(workspace,'claude-config')}});markdown=output.markdown;}finally{clearTimeout(timer)}
    // A report must still work after it is downloaded. Keep every collected image
    // embedded even when the summarizer did not mention its placeholder.
    markdown=embedArtifacts(markdown,artifacts);
    return {passed:run.code===0,markdown,artifactCount:artifacts.length,output:run.output};
  }finally{await rm(workspace,{recursive:true,force:true});}};
  const jobs=new Jobs({kind:'executor',label:'Executor',started:{stage:'queued',message:'Waiting to run script'},completion:r=>({message:r.passed?'Script passed':'Script failed',passed:r.passed}),worker,dataDir:path.join(dataDir,'jobs'),concurrency:positive('EXECUTOR_CONCURRENCY',1),timeoutMs:positive('EXECUTOR_TIMEOUT_MS',900000),maxJobs:positive('EXECUTOR_MAX_JOBS',100),retentionMs:positive('EXECUTOR_RETENTION_MS',86400000)});
  const server=createHttpServer({jobs,validateInput:validate,applySettings,basePath:'/v1/executor',openapiPath:fileURLToPath(new URL('./openapi.json',import.meta.url))});
  await new Promise(resolve=>server.listen(port,host,resolve));return {server,jobs};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))startExecutor().catch(error=>{console.error(`Executor startup failed: ${error.message}`);process.exitCode=1});
