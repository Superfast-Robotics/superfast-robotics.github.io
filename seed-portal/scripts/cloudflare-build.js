import { cp, mkdir, copyFile, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const assets = path.join(root, '.cloudflare-assets');
await mkdir(assets, { recursive: true });
await cp(path.join(root, 'public'), assets, { recursive: true });
const vendor = path.join(assets, 'vendor');
await mkdir(vendor, { recursive: true });
for (const name of ['pdf.mjs', 'pdf.worker.mjs']) {
  await copyFile(path.join(root, 'node_modules/pdfjs-dist/build', name), path.join(vendor, name));
  await unlink(path.join(vendor, 'pdfjs', name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
for (const directory of ['cmaps', 'standard_fonts']) {
  await cp(path.join(root, 'node_modules/pdfjs-dist', directory), path.join(vendor, directory), { recursive: true });
}
await rmdir(path.join(vendor, 'pdfjs')).catch(error => { if (error.code !== 'ENOENT') throw error; });
console.log('Prepared portal UI and PDF viewer assets for Cloudflare.');
