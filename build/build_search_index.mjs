#!/usr/bin/env node
/**
 * Build a MiniSearch index from public/session-tabs/search-docs.json.
 *
 * Output: public/session-tabs/search-index.json (serialized MiniSearch).
 * The intermediate search-docs.json is removed after a successful build.
 *
 *   cd build && npm install
 *   node build/build_search_index.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import MiniSearch from 'minisearch';

const root = process.cwd();
const outDir = path.join(root, 'public', 'session-tabs');
const docsPath = path.join(outDir, 'search-docs.json');
const outPath = path.join(outDir, 'search-index.json');

if (!fs.existsSync(docsPath)) {
  console.error(`Missing ${docsPath}. Run build/build_session_data.py first.`);
  process.exit(1);
}

const { built_at, docs } = JSON.parse(fs.readFileSync(docsPath, 'utf-8'));
console.log(`Indexing ${docs.length} tunes (built_at=${built_at})…`);

const mini = new MiniSearch({
  idField: 'id',
  fields: ['name', 'aliases'],
  storeFields: ['name', 'type', 'mode'],
  extractField: (doc, field) =>
    Array.isArray(doc[field]) ? doc[field].join(' ') : doc[field],
});
mini.addAll(docs);

// {built_at, index}: built_at surfaces in the viewer; MiniSearch serializes
// itself via toJSON() when stringified inside this wrapper.
fs.writeFileSync(outPath, JSON.stringify({ built_at, index: mini }));
const bytes = fs.statSync(outPath).size;
console.log(`Wrote ${outPath} (${(bytes / 1024).toFixed(1)} KiB)`);

fs.unlinkSync(docsPath);
console.log(`Removed intermediate ${docsPath}`);
