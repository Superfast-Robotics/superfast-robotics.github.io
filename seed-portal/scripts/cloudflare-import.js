import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
if (!args.includes('--package') || !args.some(x => ['--local', '--remote'].includes(x))) {
  throw new Error('Usage: node scripts/cloudflare-import.js --package <reviewed directory> --local|--remote');
}
const mode = args.includes('--remote') ? '--remote' : '--local';
const source = await fs.realpath(option('--package'));
const manifest = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'));
if (manifest.format !== 1 || manifest.kind !== 'html' || !manifest.files.length || !manifest.version || !manifest.title || !Number.isInteger(manifest.pageCount)) throw new Error('Invalid reviewed package');
const staging = path.join(root, '.cloudflare-import');
await fs.mkdir(staging, { recursive: true });
const checkpoint = path.join(staging, `${manifest.version.replace(/[^\w.-]/g, '_')}-${mode.slice(2)}.json`);
let progress;
try { progress = JSON.parse(await fs.readFile(checkpoint, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; progress = { id: randomUUID(), uploaded: {}, createdAt: Date.now() }; }
const wrangler = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
function command(parts) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrangler, ...parts], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(output)));
  });
}
const entries=[];
for (const file of manifest.files) {
  if (!file.path.startsWith('seeddeck/') || file.path.includes('..') || file.path.includes('\\') || !/^[a-f0-9]{64}$/i.test(file.sha256)) throw new Error('Unsafe package path');
  const filename = file.path.slice('seeddeck/'.length);
  const absolute = await fs.realpath(path.join(source, file.path));
  if (!absolute.startsWith(source + path.sep)) throw new Error('Package file escapes source');
  const bytes = await fs.readFile(absolute);
  if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256.toLowerCase()) throw new Error(`Package checksum mismatch: ${filename}`);
  entries.push({ ...file, filename, absolute });
}
if (!entries.some(x => x.filename === 'index.html')) throw new Error('Missing deck entry');
const save = () => fs.writeFile(checkpoint, JSON.stringify(progress, null, 2));
await save();
// One upload at a time keeps checkpoints durable and avoids CLI process spikes.
for (let index=0; index<entries.length; index++) {
  const file=entries[index];
  if (progress.uploaded[file.filename] !== file.sha256) {
    await command(['r2','object','put',`superfast-seed-decks/decks/${progress.id}/${file.filename}`,mode,'--file',file.absolute,'--cache-control','private, no-store']);
    progress.uploaded[file.filename]=file.sha256;
    await save();
  }
  if ((index+1)%10===0 || index===entries.length-1) console.log(`Stored ${index+1}/${entries.length} reviewed deck files.`);
}
const quote = value => value == null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
const sql=`INSERT INTO decks(id,title,version,kind,page_count,created_at,files_json,pdf_file)
VALUES (${quote(progress.id)},${quote(manifest.title)},${quote(manifest.version)},'html',${manifest.pageCount},${progress.createdAt},${quote(JSON.stringify(entries.map(x=>x.filename)))},${quote(entries.some(x=>x.filename==='download.pdf')?'download.pdf':null)})
ON CONFLICT(id) DO NOTHING;\n`;
const sqlFile=path.join(staging, `${progress.id}.sql`);
await fs.writeFile(sqlFile,sql);
await command(['d1','execute','DB',mode,'--file',sqlFile]);
console.log(JSON.stringify({ id:progress.id, version:manifest.version, status:'draft', files:entries.length }));
