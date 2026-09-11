import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Protocol boundary: expose only a workflow's allowed tools, regardless of the host's
// permission defaults or additional tools introduced by a future upstream MCP version.
export function createToolFilter(allowedNames, sendToClient, sendToServer) {
  const allowed = new Set(allowedNames), lists = new Set();
  const methods = new Set(['initialize', 'ping', 'logging/setLevel', 'notifications/initialized', 'notifications/cancelled', 'notifications/roots/list_changed']);
  return {
    fromClient(message) {
      if (message.method === 'tools/list') lists.add(message.id);
      else if (message.method === 'tools/call' && !allowed.has(message.params?.name)) {
        return sendToClient({ jsonrpc: '2.0', id: message.id,
          error: { code: -32601, message: 'Tool is not exposed by this workflow' } });
      } else if (message.method && message.method !== 'tools/call' && !methods.has(message.method)) {
        if (message.id !== undefined) sendToClient({ jsonrpc: '2.0', id: message.id,
          error: { code: -32601, message: 'Method is not exposed by this workflow' } });
        return;
      }
      sendToServer(message);
    },
    fromServer(message) {
      if (lists.delete(message.id) && message.result?.tools) {
        message = { ...message, result: { ...message.result, tools: message.result.tools.filter(tool => allowed.has(tool.name)) } };
      }
      // The test runner's resource/prompt capabilities are not part of the workflow contract.
      if (message.result?.capabilities) {
        const { tools, logging } = message.result.capabilities;
        message = { ...message, result: { ...message.result, capabilities: { ...(tools ? { tools } : {}), ...(logging ? { logging } : {}) } } };
      }
      sendToClient(message);
    }
  };
}

function main() {
  const [allowJson, command, ...args] = process.argv.slice(2);
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  const send = stream => value => stream.write(JSON.stringify(value) + '\n');
  const filter = createToolFilter(JSON.parse(allowJson), send(process.stdout), send(child.stdin));
  const client = createInterface({ input: process.stdin });
  const server = createInterface({ input: child.stdout });
  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    client.close(); child.stdin.end(); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000); timer.unref();
  }
  const consume = handler => line => {
    try { handler(JSON.parse(line)); } catch { process.exitCode = 1; stop(); }
  };
  client.on('line', consume(filter.fromClient));
  server.on('line', consume(filter.fromServer));
  client.on('close', stop);
  child.stdin.on('error', stop);
  child.on('error', () => { process.exitCode = 1; stop(); });
  child.on('close', code => { process.exitCode = code ?? 1; client.close(); process.stdin.destroy(); });
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
