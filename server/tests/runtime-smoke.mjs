import http from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPlannerWorker } from '../planner/worker.mjs';
import { resolveClaudeOptions } from '../runtime/settings.mjs';
import { installSettings } from '../../build/planner/install-settings.mjs';
import { output } from './fixtures.mjs';
import { fileURLToPath } from 'node:url';
const runtimeRequire = createRequire(path.join(process.env.PLANNER_SMOKE_RUNTIME_DIR ?? fileURLToPath(new URL('../../', import.meta.url)), 'package.json'));

// A local deterministic Anthropic-compatible endpoint exercises the real Claude CLI,
// MCP handshake, seed/browser startup and structured-output tool without a paid model call.
let messageCount = 0;
const provider = http.createServer(async(req,res)=>{
 try {
 let body='';for await(const chunk of req)body+=chunk;
 if(req.url.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({input_tokens:100}));}
 if(!req.url.includes('/messages')){res.writeHead(200,{'content-type':'application/json'});return res.end('{}');}
 const request=JSON.parse(body); messageCount++;
 if(!(request.tools??[]).length){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({id:'msg_meta',type:'message',role:'assistant',model:request.model,content:[{type:'text',text:'Local test'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:1,output_tokens:1}}));}
 if (request.model !== 'planner-settings-smoke-model' || req.headers['x-api-key'] !== 'local-smoke-test-key') throw new Error('Claude did not load model and authentication from packaged settings');
 const toolNames=(request.tools??[]).map(t=>t.name);
 const setup=toolNames.find(n=>n.endsWith('planner_setup_page'));
 const structured=toolNames.find(n=> /structured/i.test(n));
 const toolResults=request.messages.flatMap(m=>Array.isArray(m.content)?m.content.filter(c=>c.type==='tool_result'):[]);
 console.log('Provider request',messageCount,'tools',toolNames.length,'setup',Boolean(setup),'structured',structured??'-','results',toolResults.length);
 if (toolNames.some(name => /generator_|test_run|test_debug|run_code_unsafe/.test(name))) throw new Error('Non-planner tool exposed');
 let tool;
 if(!toolResults.length && setup) tool={type:'tool_use',id:'toolu_setup',name:setup,input:{seedFile:'seed.spec.ts'}};
 else if(structured) tool={type:'tool_use',id:'toolu_output',name:structured,input:output};
 else throw new Error('Required tool missing from real CLI model request');
 const message={id:'msg_local_'+messageCount,type:'message',role:'assistant',model:request.model,content:[tool],stop_reason:'tool_use',stop_sequence:null,usage:{input_tokens:10,output_tokens:10}};
 if(!request.stream){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify(message));}
 res.writeHead(200,{'content-type':'text/event-stream'});
 const event=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
 event('message_start',{message:{...message,content:[],stop_reason:null}});
 event('content_block_start',{index:0,content_block:{...tool,input:{}}});
 event('content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(tool.input)}});
 event('content_block_stop',{index:0});
 event('message_delta',{delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:10}});
 event('message_stop',{});res.end();
 } catch(error) { console.error('Local model stub:', error.message); res.writeHead(500, {'content-type':'application/json'}); res.end(JSON.stringify({error:{type:'api_error',message:'Local smoke stub failed'}})); }
});
const target=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Planner Smoke</title><h1>Login</h1><label>Account<input name="account"></label><button>Sign in</button>');});
await new Promise(r=>provider.listen(0,'127.0.0.1',r));
await new Promise(r=>target.listen(0,'127.0.0.1',r));
const temporaryRoot=await mkdtemp(path.join(tmpdir(),'planner-real-smoke-'));
const settingsPath=path.join(temporaryRoot,'image/config/claude/settings.json');
await writeFile(path.join(temporaryRoot,'setting.json'), JSON.stringify({model:'planner-settings-smoke-model',env:{ANTHROPIC_API_KEY:'local-smoke-test-key',ANTHROPIC_BASE_URL:`http://127.0.0.1:${provider.address().port}`}}));
await installSettings(temporaryRoot,settingsPath);
for (const key of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','ANTHROPIC_MODEL']) delete process.env[key];
// PLAYWRIGHT_BROWSERS_PATH can point to a preinstalled test browser cache.
process.env.CLAUDE_CONFIG_DIR=path.join(temporaryRoot,'claude-config');
const controller=new AbortController();const timer=setTimeout(()=>controller.abort(new Error('Smoke timeout')),90000);
try{
 const worker=createPlannerWorker({command:process.env.PLANNER_CLAUDE_COMMAND ?? 'claude',
  ...await resolveClaudeOptions({env:{PLANNER_CLAUDE_SETTINGS:settingsPath}}),
  playwrightPackage:runtimeRequire.resolve('@playwright/test/package.json'),temporaryRoot});
 const result=await worker({requirements:[{id:'REQ-001',title:'Login',content:'Design a login test'}],target:{baseUrl:`http://127.0.0.1:${target.address().port}`}},
  {signal:controller.signal,emit:e=>console.log('Progress',JSON.stringify(e))});
 console.log('Real runtime smoke succeeded:',result.cases.length,'case(s)',messageCount,'provider requests');
}catch(error){console.error(error);process.exitCode=1;}
finally{clearTimeout(timer);provider.closeAllConnections();target.closeAllConnections();provider.close();target.close();await rm(temporaryRoot,{recursive:true,force:true});}
