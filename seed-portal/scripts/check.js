import { readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const excluded = new Set(['node_modules', 'data', '.git', 'coverage']);

async function collect(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name) || entry.isSymbolicLink()) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(path));
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) files.push(path);
  }
  return files;
}

let failures = 0;
const files = (await collect(root)).sort();
for (const path of files) {
  const result = spawnSync(process.execPath, ['--check', path], {
    encoding: 'utf8', windowsHide: true,
  });
  if (result.status !== 0) {
    failures += 1;
    console.error(`Syntax check failed: ${relative(root, path)}`);
    console.error(result.stderr || result.error?.message || 'Unknown error');
  }
}
if (failures) process.exitCode = 1;
else console.log(`Syntax checked ${files.length} JavaScript files.`);
