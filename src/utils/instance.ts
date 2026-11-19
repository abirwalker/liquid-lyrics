import { logger } from './logger';

export type Origin = 'dev' | 'marketplace' | 'manual' | 'other';

export interface Copy {
  readonly version: string;
  readonly origin: Origin;
  readonly source: string | null;
}

export interface Instance extends Copy {
  readonly cssId: string;
  dispose(): void;
  noticeCopy(copy: Copy): void;
}

// Marketplace keys installs by file path, so each release path is a separate install and
// updating can leave several copies loading at every start. Shared across bundles via Symbol.for.
const KEY = Symbol.for('liquid-lyrics.instance');
const registry = globalThis as typeof globalThis & { [KEY]?: Instance };
// v1.3.2 and older create this element as soon as their script runs; newer builds use versioned ids.
const LEGACY_STYLE_ID = 'liquid-lyrics-styles';

export function compareVersions(a: string, b: string) {
  const parse = (version: string) => version.split('-')[0].split('.').map(Number);
  const [left, right] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    const difference = (left[i] || 0) - (right[i] || 0);
    if (difference) return difference;
  }
  return 0;
}

// The stack names the file this code was loaded from; document.currentScript is already null
// after the async startup. File names can contain brackets, as in a second download "liquid-lyrics (1).js".
export function ownSource(): string | null {
  const url = new Error().stack?.match(/(https?:\/\/\S+?):\d+:\d+(?:\)|$)/m)?.[1];
  return url ? url.split(/[?#]/)[0] : null;
}

// Spicetify serves extensions installed from a file under /extensions/, whatever they were renamed to.
export function manualFileName(source: string | null): string | null {
  if (!source) return null;
  try {
    const file = new URL(source).pathname.match(/\/extensions\/([^/]+\.m?js)$/i)?.[1];
    return file ? decodeURIComponent(file) : null;
  } catch {
    return null;
  }
}

export function originOf(source: string | null, dev: boolean): Origin {
  if (dev) return 'dev';
  if (manualFileName(source)) return 'manual';
  try {
    if (/jsdelivr|githubusercontent/.test(new URL(source ?? '').hostname)) return 'marketplace';
  } catch {
    // An unparseable source falls through to 'other'.
  }
  return 'other';
}

// A dev build wins so the dev server can run beside an installed copy. On a version tie the
// Marketplace copy wins, since it is the one that receives updates.
function outranks(candidate: Copy, current: Copy) {
  if ((candidate.origin === 'dev') !== (current.origin === 'dev')) return candidate.origin === 'dev';
  const byVersion = compareVersions(candidate.version, current.version);
  if (byVersion) return byVersion > 0;
  return candidate.origin === 'marketplace' && current.origin !== 'marketplace';
}

const describe = ({ version, origin, source }: Copy): Copy => ({ version, origin, source });

function removeStyles(instance: Instance) {
  // Copies of the same build share one style element, which the running copy still needs.
  if (registry[KEY]?.cssId !== instance.cssId) document.getElementById(instance.cssId)?.remove();
}

export function claimInstance(instance: Instance): boolean {
  const current = registry[KEY];
  if (current && !outranks(instance, current)) {
    removeStyles(instance);
    current.noticeCopy(describe(instance));
    return false;
  }
  // Registered before the old copy shuts down, so its release sees a successor and keeps a style
  // element they share when both are the same build.
  registry[KEY] = instance;
  if (current) {
    try {
      current.dispose();
    } catch (error) {
      logger.warn('[Liquid Lyrics] Older copy did not shut down cleanly:', error);
    }
    instance.noticeCopy(describe(current));
  }
  return true;
}

export function releaseInstance(instance: Instance) {
  if (registry[KEY] === instance) delete registry[KEY];
  removeStyles(instance);
}

export const legacyCopyLoaded = () => document.getElementById(LEGACY_STYLE_ID) !== null;

export function watchForLegacyCopy(onFound: () => void): () => void {
  const observer = new MutationObserver(() => {
    if (!legacyCopyLoaded()) return;
    observer.disconnect();
    onFound();
  });
  observer.observe(document.head, { childList: true });
  return () => observer.disconnect();
}
