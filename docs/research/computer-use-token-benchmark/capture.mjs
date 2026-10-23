import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const [arm, command, ...args] = process.argv.slice(2);
if (!['own', 'upstream'].includes(arm) || !command) throw new Error('Usage: node capture.mjs own|upstream COMMAND [ARGS...]');
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let id = 0;
let stderr = '';
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
const fail = error => { for (const item of pending.values()) item.reject(error); pending.clear(); };
child.on('error', fail);
child.on('exit', code => fail(new Error(`MCP exited ${code}: ${stderr}`)));
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { fail(new Error(`Non-JSON stdout: ${line.slice(0, 300)}`)); return; }
  const item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id);
  if (message.error) item.reject(new Error(JSON.stringify(message.error)));
  else item.resolve(message.result);
});
const request = (method, params) => new Promise((resolve, reject) => {
  const requestId = ++id;
  pending.set(requestId, { resolve, reject });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
});
const timeout = setTimeout(() => { fail(new Error(`MCP timed out: ${stderr}`)); child.kill('SIGTERM'); }, 60000);
try {
  const initialized = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'schema-benchmark', version: '1.0.0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const result = await request('tools/list', {});
  if (!Array.isArray(result.tools) || result.nextCursor) throw new Error('Expected one complete tools/list page');
  await writeFile(new URL(`./${arm}.tools.json`, import.meta.url), JSON.stringify(result.tools, null, 2) + '\n');
  console.log(JSON.stringify({ arm, server: initialized.serverInfo, tools: result.tools.map(tool => tool.name) }));
} finally {
  clearTimeout(timeout);
  child.stdin.end();
  child.kill('SIGTERM');
  lines.close();
}
