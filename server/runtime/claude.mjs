import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

// Shared runtime boundary: a workflow supplies prompt, schema, MCP configuration and a tool allowlist.
// No repository settings, built-in filesystem tools or arbitrary shell commands are inherited.
// sessionId/resume let a workflow continue an interrupted run instead of starting over (the planner
// offers it after a timeout). Without a sessionId nothing is written to disk, as before; with one the
// conversation is persisted so `--resume` can pick it up, so the caller must also point env
// CLAUDE_CONFIG_DIR at a directory it owns and deletes.
export function runClaude({ cwd, prompt, systemPrompt, schema, mcpConfig, allowedTools, disallowedTools = [], signal, onMessage = () => {},
  command = 'claude', model, settingsPath, sessionId, resume = false, env = {}, maxOutputBytes = 16 * 1024 * 1024 }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const args = ['--bare', '--print', '--verbose', '--output-format', 'stream-json',
      ...(sessionId ? (resume ? ['--resume', sessionId] : ['--session-id', sessionId]) : ['--no-session-persistence']),
      '--disable-slash-commands', '--setting-sources', '',
      '--permission-mode', 'dontAsk', '--tools', '', '--allowedTools', allowedTools.join(','),
      '--strict-mcp-config', '--mcp-config', JSON.stringify(mcpConfig),
      '--system-prompt', systemPrompt, '--json-schema', JSON.stringify(schema)];
    if (disallowedTools.length) args.push('--disallowedTools', disallowedTools.join(','));
    if (model) args.push('--model', model);
    if (settingsPath) args.push('--settings', settingsPath);
    const child = spawn(command, args, { cwd, env: { ...process.env, ENABLE_TOOL_SEARCH: 'false', ...env }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let buffer = '', diagnostics = '', bytes = 0, result, failure, killTimer;
    const decoder = new StringDecoder('utf8');
    function kill(sig) {
      if (!child.pid) return;
      try { process.platform === 'win32' ? child.kill(sig) : process.kill(-child.pid, sig); }
      catch (error) { if (error.code !== 'ESRCH') failure ??= new Error('Failed to terminate planner runtime'); }
    }
    function stop(error) {
      failure ??= error;
      kill('SIGTERM');
      killTimer ??= setTimeout(() => kill('SIGKILL'), 3000);
      killTimer.unref();
    }
    const abort = () => stop(signal.reason ?? new Error('Planner cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    function consume(line) {
      if (!line.trim() || failure) return;
      try {
        const message = JSON.parse(line);
        if (message.type === 'result') result = message;
        onMessage(message);
      } catch (error) { stop(error instanceof SyntaxError ? new Error('Invalid planner runtime event stream') : error); }
    }
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) return stop(new Error('Planner output exceeded the configured limit'));
      buffer += decoder.write(chunk);
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        consume(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
      }
    });
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-8000); });
    child.stdin.on('error', () => stop(new Error('Planner input pipe failed')));
    child.on('error', () => { failure ??= new Error('Cannot start Claude runtime; verify PLANNER_CLAUDE_COMMAND'); });
    child.on('close', code => {
      clearTimeout(killTimer);
      signal.removeEventListener('abort', abort);
      consume(buffer + decoder.end());
      // Dispose any remaining MCP/browser descendants before removing the task workspace.
      kill('SIGKILL');
      if (failure) return reject(failure);
      if (code !== 0 || !result || result.is_error || result.subtype !== 'success')
        return reject(new Error(result?.errors?.join('\n') || result?.result || diagnostics.trim() || 'Planner runtime failed; verify model and browser configuration'));
      if (!result.structured_output) return reject(new Error('Planner runtime returned no structured result'));
      resolve(result.structured_output);
    });
    child.stdin.end(prompt);
  });
}
