// Starts `synalla-memory serve`, sends initialize, tools/list, tools/call recall; prints the replies; exits 0 if all three answered.
import { spawn } from 'node:child_process';
const child = spawn(process.argv[2], ['serve'], { shell: true, stdio: ['pipe', 'pipe', 'inherit'] });
const want = new Set([1, 2, 3]); let buf = '';
child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1);
  if (!line.trim()) continue; console.log('<<', line.slice(0, 600)); try { const m = JSON.parse(line); if (m.result) want.delete(m.id); } catch {} }
  if (!want.size) { child.kill(); process.exit(0); } });
const send = m => child.stdin.write(JSON.stringify(m) + '\n');
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'recall', arguments: { question: 'when is the dentist appointment' } } });
setTimeout(() => { console.log('TIMEOUT, missing', [...want]); process.exit(1); }, 60000);
