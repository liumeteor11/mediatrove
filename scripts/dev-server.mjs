// Spawns vite with stdin ignored (so a dropped parent pipe can't crash it
// with an unhandled ECONNRESET) and stdout/stderr redirected to a log file
// (so a full, unread pipe can't EPIPE the HTTP server away mid-session —
// the tauri CLI stops draining vite's output once it moves on to gradle).
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const viteBin = resolve(here, '../node_modules/vite/bin/vite.js');
const args = process.argv.slice(2);
const out = openSync(resolve(here, '../vite-dev.log'), 'a');

const child = spawn(process.execPath, [viteBin, ...args], {
  stdio: ['ignore', out, out],
});

child.on('exit', (code) => process.exit(code ?? 0));
