import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { access, appendFile, readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import vm from 'node:vm';

const ALLOWED_HTTP_PREFIXES = [
  'http://www.w3.org/',
  'http://music.apple.com/',
  'http://itunes.apple.com/',
  'http://lrc.red/',
  'http://127.0.0.1',
  'http://localhost',
];

const RISKY_DOM_PROP = new Set(['innerHTML', 'outerHTML']);
const RISKY_IDENT_RE = /\b(title|artist|album|lyrics?|song|writer|trackName|message|err|error|html|response|payload)\b/i;

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function hasEnclosingTry(node) {
  let cur = node.parent;
  while (cur) {
    if (ts.isTryStatement(cur)) return true;
    if (ts.isFunctionLike(cur)) return false;
    cur = cur.parent;
  }
  return false;
}

function fetchHasSignal(node) {
  const init = node.arguments[1];
  if (!init || !ts.isObjectLiteralExpression(init)) return true;
  return init.properties.some(prop => {
    if (ts.isSpreadAssignment(prop)) return true;
    const name = ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop) ? prop.name : null;
    return name && ts.isIdentifier(name) && name.text === 'signal';
  });
}

export function scanTypeScriptText(relPath, code, scope, report) {
  const rel = relPath.replace(/\\/g, '/');
  const scriptKind = rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(rel, code, ts.ScriptTarget.ES2022, true, scriptKind);
  const allowConsole = rel === 'src/utils/logger.ts';

  function walk(node) {
    if (ts.isDebuggerStatement(node)) {
      report('error', rel, lineOf(sf, node), 'Leftover `debugger` statement.');
    }

    if (ts.isCallExpression(node)) {
      const expr = node.expression;

      if (scope === 'src' && !allowConsole && ts.isPropertyAccessExpression(expr) &&
          ts.isIdentifier(expr.expression) && expr.expression.text === 'console') {
        report('error', rel, lineOf(sf, node), `Direct \`console.${expr.name.text}()\` bypasses \`src/utils/logger.ts\`.`);
      }

      if (scope === 'src' && ts.isPropertyAccessExpression(expr) &&
          ts.isIdentifier(expr.expression) && expr.expression.text === 'JSON' &&
          expr.name.text === 'parse' && !hasEnclosingTry(node)) {
        report('error', rel, lineOf(sf, node), '`JSON.parse(...)` in src/ must be wrapped in `try/catch` to avoid crashing on malformed API or cache data.');
      }

      if (scope === 'src' && ts.isIdentifier(expr) && expr.text === 'fetch') {
        if (node.arguments.length < 2 || !fetchHasSignal(node)) {
          report('error', rel, lineOf(sf, node), '`fetch(...)` in src/ must pass an explicit Abort `signal` option.');
        }
      }

      if (ts.isIdentifier(expr) && (expr.text === 'eval' || expr.text === 'Function')) {
        report('error', rel, lineOf(sf, node), `Dynamic \`${expr.text}()\` execution is forbidden.`);
      }

      if (scope === 'src' && ts.isPropertyAccessExpression(expr) && expr.name.text === 'insertAdjacentHTML') {
        report('error', rel, lineOf(sf, node), '`insertAdjacentHTML()` is disallowed; construct elements with `textContent`.');
      }

      if (scope === 'tests' && ts.isPropertyAccessExpression(expr) && expr.name.text === 'only' &&
          ts.isIdentifier(expr.expression) && ['it', 'test', 'describe'].includes(expr.expression.text)) {
        report('error', rel, lineOf(sf, node), `Focused test \`${expr.expression.text}.only()\` left in test file.`);
      }
    }

    if (scope === 'src' && ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') {
      report('error', rel, lineOf(sf, node), 'Dynamic `new Function()` is forbidden.');
    }

    if (scope === 'src' && ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) && RISKY_DOM_PROP.has(node.left.name.text)) {
      const rhsText = node.right.getText(sf);
      if (RISKY_IDENT_RE.test(rhsText) && !/makeIcon|spotifyIcon|ICON_|HEART_/.test(rhsText)) {
        report('error', rel, lineOf(sf, node), `Suspicious dynamic \`${node.left.name.text}\` assignment referencing metadata/lyric data (\`${rhsText.slice(0, 60)}\`). Use \`textContent\` instead.`);
      }
    }

    if (scope === 'src' && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      const val = node.text;
      if (val.startsWith('http://') && !ALLOWED_HTTP_PREFIXES.some(prefix => val.startsWith(prefix))) {
        report('error', rel, lineOf(sf, node), `Insecure \`http://\` URL in src/: \`${val}\`. Use \`https://\`.`);
      }
    }

    ts.forEachChild(node, walk);
  }
  walk(sf);
}

export function auditCssText(relPath, css, report) {
  const rel = relPath.replace(/\\/g, '/');
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/'(?:\\.|[^'])*'|"(?:\\.|[^"])*"/g, '');
  let depth = 0;
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}') {
      depth--;
      if (depth < 0) {
        report('error', rel, 1, 'Unmatched closing `}` in CSS.');
        return;
      }
    }
  }
  if (depth !== 0) {
    report('error', rel, 1, `Unclosed \`{\` brace in CSS (depth ${depth}).`);
  }
  if (/@keyframes\s+/i.test(css) && !/prefers-reduced-motion\s*:\s*reduce/i.test(css)) {
    report('error', rel, 1, 'CSS defines `@keyframes` animations without a `@media (prefers-reduced-motion: reduce)` rule.');
  }
}

export function auditBundleText(code, report) {
  try {
    new vm.Script(code, { filename: 'dist/liquid-lyrics.js' });
  } catch (error) {
    report('error', 'dist/liquid-lyrics.js', 1, `Built bundle failed syntax parse: ${error.message}`);
  }
  if (/^(<{7}|={7}|>{7})/m.test(code)) {
    report('error', 'dist/liquid-lyrics.js', 1, 'Built bundle contains merge conflict markers.');
  }
  if (code.includes('设置歌词行') || code.includes('歌词视图构建完成')) {
    report('error', 'dist/liquid-lyrics.js', 1, 'Production bundle leaked stripped AMLL Chinese debug logs.');
  }
  const kb = Buffer.byteLength(code) / 1024;
  const gzipKb = gzipSync(code).length / 1024;
  if (kb > 900) {
    report('error', 'dist/liquid-lyrics.js', 1, `Bundle size ${kb.toFixed(2)} kB exceeds 900 kB ceiling.`);
  }
  return { kb, gzipKb };
}

async function listFiles(dir, extList) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(full, extList));
    else if (extList.some(ext => entry.name.endsWith(ext))) files.push(full);
  }
  return files;
}

function checkConflictMarkers(relPath, content, report) {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^(<{7}(\s|$)|={7}$|>{7}(\s|$))/.test(lines[i])) {
      report('error', relPath.replace(/\\/g, '/'), i + 1, 'Leftover merge conflict marker.');
    }
  }
}

async function writeStepSummary(root) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  const lines = ['## Liquid Lyrics CI Checks', ''];
  try {
    const raw = await readFile(resolve(root, 'logs/adapter-tests/source-result.json'), 'utf8');
    const adapter = JSON.parse(raw);
    lines.push(`- **Lyrics adapter suite**: ${adapter.formats?.checks ?? 0} format checks, ${adapter.boundaries?.checks ?? 0} boundary checks`);
  } catch {
    lines.push('- **Lyrics adapter suite**: no result file produced');
  }
  try {
    const bundle = await readFile(resolve(root, 'dist/liquid-lyrics.js'), 'utf8');
    const kb = (Buffer.byteLength(bundle) / 1024).toFixed(2);
    const gzipKb = (gzipSync(bundle).length / 1024).toFixed(2);
    lines.push(`- **Production bundle**: \`dist/liquid-lyrics.js\` (${kb} kB, ${gzipKb} kB gzip)`);
  } catch {
    lines.push('- **Production bundle**: not built');
  }
  lines.push('');
  await appendFile(summaryPath, lines.join('\n'));
}

if (pathToFileURL(resolve(process.argv[1] ?? '')).href === import.meta.url) {
  const root = resolve('.');
  const isCI = process.env.GITHUB_ACTIONS === 'true';
  const findings = [];
  const report = (level, file, line, message) => {
    findings.push({ level, file, line, message });
    if (isCI) {
      const tag = level === 'error' ? '::error' : '::warning';
      const loc = file ? (line ? `file=${file.replace(/\\/g, '/')},line=${line}` : `file=${file.replace(/\\/g, '/')}`) : '';
      console.log(loc ? `${tag} ${loc}::${message}` : `${tag}::${message}`);
    } else {
      console.log(`[${level.toUpperCase()}] ${file ?? '(bundle)'}${line ? `:${line}` : ''}: ${message}`);
    }
  };

  const checkSummary = process.argv.includes('--summary');
  const checkBundle = process.argv.includes('--bundle');
  const checkSource = process.argv.includes('--source') || (!checkBundle && !checkSummary);

  if (checkSource) {
    const srcFiles = await listFiles(resolve(root, 'src'), ['.ts', '.tsx']);
    const testFiles = await listFiles(resolve(root, 'tests'), ['.ts', '.tsx']);
    const cssFiles = await listFiles(resolve(root, 'src'), ['.css']);
    const scriptFiles = await listFiles(resolve(root, 'scripts'), ['.mjs']);
    const workflowFiles = await listFiles(resolve(root, '.github'), ['.yml', '.yaml']);

    for (const file of srcFiles) {
      const content = await readFile(file, 'utf8');
      const rel = relative(root, file);
      checkConflictMarkers(rel, content, report);
      scanTypeScriptText(rel, content, 'src', report);
    }
    for (const file of testFiles) {
      const content = await readFile(file, 'utf8');
      const rel = relative(root, file);
      checkConflictMarkers(rel, content, report);
      scanTypeScriptText(rel, content, 'tests', report);
    }
    for (const file of cssFiles) {
      const content = await readFile(file, 'utf8');
      const rel = relative(root, file);
      checkConflictMarkers(rel, content, report);
      auditCssText(rel, content, report);
    }
    for (const file of scriptFiles) {
      const content = await readFile(file, 'utf8');
      checkConflictMarkers(relative(root, file), content, report);
      try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      } catch (error) {
        report('error', relative(root, file), 1, `Script syntax check failed: ${error.stderr?.toString() || error.message}`);
      }
    }
    for (const file of workflowFiles) {
      checkConflictMarkers(relative(root, file), await readFile(file, 'utf8'), report);
    }
    for (const meta of ['package.json', 'manifest.json', 'Extension/CHANGELOG.md']) {
      checkConflictMarkers(meta, await readFile(resolve(root, meta), 'utf8'), report);
    }

    const runners = await Promise.all([
      readFile(resolve(root, 'scripts/test-lyrics.mjs'), 'utf8'),
      readFile(resolve(root, 'scripts/test-renderer.mjs'), 'utf8'),
      readFile(resolve(root, 'tests/lyrics.ts'), 'utf8'),
    ]);
    const combined = runners.join('\n');
    for (const file of testFiles) {
      const rel = relative(root, file).replace(/\\/g, '/');
      const base = rel.replace(/^tests\//, '').replace(/\.(ts|tsx)$/, '');
      if (!combined.includes(base)) {
        report('error', rel, 1, `Test file \`${rel}\` is not referenced by \`tests/lyrics.ts\` or \`scripts/test-*.mjs\`.`);
      }
    }
    console.log(`Source audit scanned ${srcFiles.length} src, ${testFiles.length} tests, ${cssFiles.length} CSS, ${scriptFiles.length} scripts.`);
  }

  if (checkBundle) {
    const bundlePath = resolve(root, 'dist/liquid-lyrics.js');
    await access(bundlePath);
    const metrics = auditBundleText(await readFile(bundlePath, 'utf8'), report);
    console.log(`Bundle audit OK: ${metrics.kb.toFixed(2)} kB (gzip ${metrics.gzipKb.toFixed(2)} kB).`);
  }

  if (checkSummary) {
    await writeStepSummary(root);
  }

  const errors = findings.filter(f => f.level === 'error');
  if (errors.length > 0) process.exitCode = 1;
}
