import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const [requestedTag, notesPath] = process.argv.slice(2);
const tag = requestedTag ?? `v${pkg.version}`;
if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) {
  throw new Error('Use a stable version tag such as v1.0.0.');
}
if (tag !== `v${pkg.version}`) {
  throw new Error(`Tag ${tag} does not match package.json (${pkg.version}). Bump the version before tagging.`);
}

const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
  throw new Error('package-lock.json is out of date. Use npm version with --no-git-tag-version.');
}
if (manifest.version !== pkg.version || manifest.main !== `Extension/Build/${tag}/liquid-lyrics.js`) {
  throw new Error('Marketplace metadata is out of date. Run npm run build before committing the release.');
}

const changelog = await readFile(new URL('Extension/CHANGELOG.md', root), 'utf8');
const releases = changelog.split(/^## (?=\[)/m).slice(1);
const heading = releases[0]?.split(/\r?\n/, 1)[0];
if (!heading?.startsWith(`[${pkg.version}] - `)) {
  throw new Error(`Add the newest release entry as ## [${pkg.version}] - YYYY-MM-DD in Extension/CHANGELOG.md.`);
}
const notes = releases[0].slice(heading.length).trim();
if (!notes) {
  throw new Error(`Changelog notes for ${tag} are empty.`);
}
if (notesPath) await writeFile(notesPath, notes + '\n');
console.log(`Release ready: ${tag}`);
