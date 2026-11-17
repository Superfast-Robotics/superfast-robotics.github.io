import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const allowed = new Set(['.html','.css','.js','.mjs','.png','.jpg','.jpeg','.webp','.gif','.svg','.mp4','.webm','.woff','.woff2','.ttf','.otf','.txt']);

export function publicDeck(row, downloadAllowed = false) {
  return {
    id: row.id, title: row.title, version: row.version, kind: row.kind,
    pageCount: row.page_count, status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
    downloadAllowed: Boolean(downloadAllowed && row.download_allowed && row.pdf_file),
    contentUrl: `/content/${row.id}/${row.kind === 'html' ? 'index.html' : 'document.pdf'}`,
    downloadUrl: `/api/deck/${row.id}/download`,
  };
}

export function importHtmlDeck(db, config, { source, title, version, pdfPath }) {
  const root = fs.realpathSync(source);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  if (/class=["'][^"']*(?:presenter-notes|speaker-notes)|<template[^>]*notes/i.test(html)) throw new Error('Presenter notes must be removed before import');
  // Match actual .slide elements, excluding slide-* utility classes.
  const actualCount = [...html.matchAll(/class=["']([^"']+)["']/g)].filter(x => x[1].split(/\s+/).includes('slide')).length;
  if (!actualCount) throw new Error('HTML deck must contain .slide elements');
  if (!title?.trim() || !version?.trim()) throw new Error('Title and version are required');
  if (db.prepare('SELECT id FROM decks WHERE version = ?').get(version)) throw new Error('This version already exists');
  const id = randomUUID();
  const target = path.join(config.dataDir, 'decks', id);
  const files = [];
  function copy(directory, relative = '') {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (item.isSymbolicLink() || item.name.startsWith('.') || ['drafts','planning','node_modules'].includes(item.name)) continue;
      const rel = path.posix.join(relative, item.name);
      if (item.isDirectory()) { copy(path.join(directory, item.name), rel); continue; }
      if (!allowed.has(path.extname(item.name).toLowerCase()) || /(?:notes|secret|private)/i.test(item.name)) continue;
      const dest = path.join(target, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(directory, item.name), dest);
      files.push(rel);
    }
  }
  try {
    copy(root);
    if (pdfPath) { fs.copyFileSync(pdfPath, path.join(target, 'download.pdf')); files.push('download.pdf'); }
    db.prepare(`INSERT INTO decks(id,title,version,kind,page_count,created_at,files_json,pdf_file) VALUES (?,?,?,'html',?,?,?,?)`)
      .run(id, title.trim(), version.trim(), actualCount, Date.now(), JSON.stringify(files), pdfPath ? 'download.pdf' : null);
    return publicDeck(db.prepare('SELECT * FROM decks WHERE id = ?').get(id));
  } catch (error) {
    // This UUID directory is created and owned by this import only.
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

export async function inspectPdf(file) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({ data: new Uint8Array(fs.readFileSync(file)), isEvalSupported: false, useSystemFonts: false, stopAtErrors: true });
  try {
    const document = await loading.promise;
    if (document.numPages > 500 || document.numPages < 1) throw new Error('PDF must contain 1–500 pages');
    return document.numPages;
  } finally { await loading.destroy(); }
}
