import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
if (pkg.name !== 'liquid-lyrics' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
  throw new Error('Expected a Liquid Lyrics package with a valid release version.');
}
const manifest = {
  name: 'Liquid Lyrics',
  description: 'An Apple Music-inspired lyrics view for Spotify, with word-by-word highlighting, backing vocals and an animated background.',
  preview: 'docs/preview.gif',
  main: `Extension/Build/v${pkg.version}/liquid-lyrics.js`,
  readme: 'README.md',
  authors: [{ name: 'abirwalker', url: 'https://github.com/abirwalker' }],
  tags: ['lyrics', 'synced-lyrics', 'word-sync', 'apple-music'],
  version: pkg.version,
};
await Promise.all([manifest.preview, manifest.readme, 'LICENSE'].map(path => access(new URL(path, root))));
const bundle = await readFile(new URL('dist/liquid-lyrics.js', root), 'utf8');
const header = `/*! Liquid Lyrics v${pkg.version}
 * Copyright (C) 2026 abirwalker
 * SPDX-License-Identifier: ${pkg.license}
 * Source and license: https://github.com/abirwalker/liquid-lyrics
 */\n`;
const destination = new URL(manifest.main, root);
await mkdir(new URL('./', destination), { recursive: true });
await writeFile(destination, header + bundle);
await writeFile(new URL('manifest.json', root), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Prepared ${manifest.name} ${pkg.version}: ${fileURLToPath(destination)}`);
