import { manualFileName } from './instance';
import { removeOlderInstalls } from '../storage/marketplace';
import { logger } from './logger';

const CLEAN_KEY = 'liquid-lyrics:clean-version';
// Long enough to read a restart notice; the popup's close button dismisses it sooner.
const NOTICE_MS = 10000;
// Every Liquid Lyrics build carries this text, so a copy is recognisable whatever its file is named.
const BUNDLE_MARKER = '[liquidlyrics:extension]';

export interface CopyReport {
  removed: number;
  manualFiles: string[];
}

export async function findManualCopies(ownSource: string | null): Promise<string[]> {
  const files = new Set<string>();
  for (const script of document.querySelectorAll<HTMLScriptElement>('script[src]')) {
    const source = script.src.split(/[?#]/)[0];
    const file = manualFileName(source);
    if (!file || source === ownSource || files.has(file)) continue;
    try {
      if ((await (await fetch(script.src)).text()).includes(BUNDLE_MARKER)) files.add(file);
    } catch (error) {
      logger.warn(`[Liquid Lyrics] Could not read extension ${file}:`, error);
    }
  }
  return [...files];
}

// Marked clean only when a check finds nothing. Marketplace writes a removed entry back if another
// extension is installed in the same session, so a check that removed something runs again next start.
export async function checkCopies(version: string, ownSource: string | null): Promise<CopyReport> {
  const [removed, manualFiles] = await Promise.all([removeOlderInstalls(version), findManualCopies(ownSource)]);
  try {
    if (removed || manualFiles.length) localStorage.removeItem(CLEAN_KEY);
    else localStorage.setItem(CLEAN_KEY, version);
  } catch {
    // Without storage the check simply runs again next start.
  }
  return { removed, manualFiles };
}

export function isMarkedClean(version: string) {
  try {
    return localStorage.getItem(CLEAN_KEY) === version;
  } catch {
    return false;
  }
}

// Single quotes work in PowerShell and POSIX shells alike, for the rare file name that needs them.
const quote = (file: string) => /^[\w.-]+$/.test(file) ? file : `'${file}'`;

// One command per line, so no shell-specific separator is needed.
export const removeCommands = (files: string[]) =>
  [...files.map(file => `spicetify config extensions ${quote(file)}-`), 'spicetify apply'];

function commandRow(command: string) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:12px;margin-top:8px';
  const code = document.createElement('code');
  code.textContent = command;
  code.style.cssText = 'flex:1;min-width:0;padding:10px 12px;border-radius:6px;background:rgba(255,255,255,.07);' +
    'font-family:ui-monospace,Consolas,monospace;font-size:13px;line-height:1.5;user-select:text;overflow-wrap:anywhere';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Copy';
  button.setAttribute('aria-label', `Copy ${command}`);
  button.setAttribute('aria-live', 'polite');
  button.style.cssText = 'flex:none;min-width:84px;padding:6px 16px;border:1px solid rgba(255,255,255,.4);' +
    'border-radius:999px;background:transparent;color:inherit;font:inherit;font-weight:700;cursor:pointer';
  let reset: ReturnType<typeof setTimeout> | undefined;
  const show = (label: string) => {
    button.textContent = label;
    clearTimeout(reset);
    reset = setTimeout(() => { button.textContent = 'Copy'; }, 2000);
  };
  button.addEventListener('click', () => {
    void (navigator.clipboard?.writeText(command) ?? Promise.reject(new Error('No clipboard'))).then(
      () => show('Copied'),
      () => {
        // Selected text can still be copied by hand when the clipboard API is refused.
        getSelection()?.selectAllChildren(code);
        show('Selected');
      });
  });
  row.append(code, button);
  return row;
}

export function showNotice(title: string, message: string) {
  const spicetify = globalThis.Spicetify;
  if (!spicetify?.PopupModal) {
    spicetify?.showNotification(`${title}. ${message}`, false, NOTICE_MS);
    return;
  }
  const content = document.createElement('p');
  content.textContent = message;
  spicetify.PopupModal.display({ title, content });
  // Close only this notice; the user may have opened another dialog since.
  setTimeout(() => { if (content.isConnected) spicetify.PopupModal?.hide(); }, NOTICE_MS);
}

// Spotify cannot edit Spicetify's config, so a copy installed from a file can only be removed from a terminal.
export function showManualCopies(files: string[]) {
  const spicetify = globalThis.Spicetify;
  const commands = removeCommands(files);
  logger.warn(`[Liquid Lyrics] Installed more than once. Remove the extra copy with:\n${commands.join('\n')}`);
  if (!spicetify?.PopupModal) {
    spicetify?.showNotification(`Liquid Lyrics is installed twice. Run: ${commands.join(', then ')}`, true, NOTICE_MS);
    return;
  }
  // Inline styles: a copy that stepped aside has already removed its stylesheet.
  const content = document.createElement('div');
  const intro = document.createElement('p');
  intro.textContent = `Liquid Lyrics is also installed from a file (${files.join(', ')}). ` +
    'Run these in a terminal, one at a time, then restart Spotify.';
  intro.style.marginBottom = '8px';
  content.append(intro, ...commands.map(commandRow));
  spicetify.PopupModal.display({ title: 'Liquid Lyrics is installed twice', content });
}
