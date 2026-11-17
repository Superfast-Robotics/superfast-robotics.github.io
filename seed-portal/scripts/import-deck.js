import { resolve } from 'node:path';
import { access } from 'node:fs/promises';

const usage = `Import a trusted HTML presentation into private portal storage.

Usage:
  npm run import:deck -- --source <clean-bundle-directory> --title <title> --version <version> [--pdf <matching-pdf>]

Use only a reviewed, self-contained deck bundle. Do not import the authoring
workspace, private presenter notes, drafts, or planning folders. The import
copies files into DATA_DIR; it does not modify the source presentation.
`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(usage);
} else {
  let db;
  try {
    const options = {};
    const allowed = new Set(['source', 'title', 'version', 'pdf']);
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index]?.replace(/^--/, '');
      if (!args[index]?.startsWith('--') || !allowed.has(key) || !args[index + 1] || args[index + 1].startsWith('--')) {
        throw new Error(`Invalid option: ${args[index] || '(missing)'}\n${usage}`);
      }
      if (options[key] !== undefined) throw new Error(`Duplicate option: --${key}`);
      options[key] = args[index + 1];
    }
    for (const key of ['source', 'title', 'version']) {
      if (!options[key]?.trim()) throw new Error(`Missing --${key}\n${usage}`);
    }
    const source = resolve(options.source);
    await access(resolve(source, 'index.html'));
    const [{ loadConfig }, { openDatabase }, { importHtmlDeck }] = await Promise.all([
      import('../src/config.js'), import('../src/db.js'), import('../src/decks.js'),
    ]);
    const config = loadConfig(process.env);
    db = openDatabase(config.dataDir);
    const deck = await importHtmlDeck(db, config, {
      source, title: options.title.trim(), version: options.version.trim(),
      ...(options.pdf ? { pdfPath: resolve(options.pdf) } : {}),
    });
    console.log(JSON.stringify({ imported: true, deck }, null, 2));
    console.log('Review the imported version in the admin dashboard before sharing.');
  } catch (error) {
    console.error(`Deck import failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}
