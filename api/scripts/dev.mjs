import net from 'node:net';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const host = '127.0.0.1';
const port = Number(process.env.PORT ?? 4000);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error('[api:dev] PORT must be an integer between 1 and 65535.');
  process.exit(1);
}

function portIsOpen() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (open) => { socket.destroy(); resolve(open); };
    socket.setTimeout(750);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function apiIsHealthy() {
  try {
    const response = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.status === 'ok';
  } catch {
    return false;
  }
}

if (await portIsOpen()) {
  if (await apiIsHealthy()) {
    console.log(`[api:dev] API already running at http://localhost:${port}`);
    console.log('[api:dev] Reusing the healthy backend. No duplicate process started.');
    process.exit(0);
  }
  console.error(`[api:dev] Port ${port} is occupied, but the API health check failed.`);
  console.error('[api:dev] An existing API may be unresponsive, or another service may be using the port. Stop or restart it, or set PORT to another available port.');
  process.exit(1);
}

const generate = spawn('npm', ['run', 'prisma:generate'], { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
const generateResult = await new Promise((resolve) => generate.once('exit', (code, signal) => resolve({ code, signal })));
if (generateResult.code !== 0) {
  console.error(`[api:dev] Prisma generation failed${generateResult.signal ? ` (${generateResult.signal})` : ''}.`);
  process.exit(generateResult.code ?? 1);
}

const nestBinary = join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'nest.cmd' : 'nest');
// Development must reload backend changes. Without --watch, the root launcher
// keeps reusing a healthy but stale API process and live-feed fixes never load.
const nest = spawn(nestBinary, ['start', '--watch'], { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => nest.kill(signal));
nest.once('exit', (code, signal) => {
  if (signal) console.error(`[api:dev] Backend stopped by ${signal}.`);
  process.exitCode = code ?? (signal ? 1 : 0);
});
