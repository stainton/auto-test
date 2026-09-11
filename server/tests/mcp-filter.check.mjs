import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolFilter } from '../runtime/mcp-filter.mjs';

test('filters tool discovery and refuses disallowed tools before execution', () => {
  const client = [], server = [];
  const filter = createToolFilter(['planner_setup_page', 'browser_snapshot'], m => client.push(m), m => server.push(m));
  filter.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  filter.fromServer({ jsonrpc: '2.0', id: 1, result: { tools: [
    { name: 'planner_setup_page' }, { name: 'generator_write_test' }, { name: 'test_run' },
    { name: 'browser_snapshot' }, { name: 'browser_run_code_unsafe' }, { name: 'future_tool' }
  ] } });
  assert.deepEqual(client[0].result.tools.map(t => t.name), ['planner_setup_page', 'browser_snapshot']);
  filter.fromClient({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'generator_write_test' } });
  assert.equal(client[1].error.code, -32601);
  assert.equal(server.length, 1);
  filter.fromClient({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_snapshot' } });
  assert.equal(server.length, 2);
  filter.fromClient({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'file:///docs/private' } });
  assert.equal(client[2].error.code, -32601);
  assert.equal(server.length, 2);
});

test('preserves initialization and server/client replies while hiding non-tool capabilities', () => {
  const client = [], server = [];
  const filter = createToolFilter([], m => client.push(m), m => server.push(m));
  filter.fromClient({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  filter.fromServer({ jsonrpc: '2.0', id: 1, result: { capabilities: { tools: {}, resources: {}, prompts: {} }, protocolVersion: '2025-11-25' } });
  assert.deepEqual(client[0].result.capabilities, { tools: {} });
  filter.fromServer({ jsonrpc: '2.0', id: 'root', method: 'roots/list' });
  filter.fromClient({ jsonrpc: '2.0', id: 'root', result: { roots: [] } });
  assert.deepEqual(server[1].result, { roots: [] });
});
