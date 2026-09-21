import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
// Incremental Nest builds may leave deleted tests in dist. Run current source tests only.
const tests = readdirSync(new URL('../src/stocks/', import.meta.url)).filter(name => name.endsWith('.spec.ts')).map(name => `dist/stocks/${name.replace(/\.ts$/, '.js')}`);
const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
process.exit(result.status ?? 1);
