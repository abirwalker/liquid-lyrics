const LL_STORAGE_KEY = 'liquid-lyrics:debug';
const AMLL_STORAGE_KEY = 'liquid-lyrics:amll-debug';

declare const __SPICE_CREATOR_DEV__: boolean | undefined;

type ConsoleMethod =
  | 'log'
  | 'info'
  | 'warn'
  | 'error'
  | 'debug'
  | 'groupCollapsed'
  | 'groupEnd';

interface AmllConsoleBridge {
  log: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  groupCollapsed: (...args: unknown[]) => void;
  groupEnd: () => void;
}

declare global {
  interface Window {
    enableLLDebug: (enable?: boolean) => void;
    enableAMLLDebug: (enable?: boolean) => void;
    liquidLyricsDebug?: boolean;
  }

  var __amllConsole: AmllConsoleBridge | undefined;
}

export const isDev: boolean =
  typeof __SPICE_CREATOR_DEV__ !== 'undefined'
    ? Boolean(__SPICE_CREATOR_DEV__)
    : typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';

function getStorage(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function setStorageFlag(key: string, enabled: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (enabled) {
      localStorage.setItem(key, 'true');
    } else {
      localStorage.removeItem(key);
    }
  } catch {}
}

// Dev starts with Liquid Lyrics logs visible; dist requires opt-in via enableLLDebug().
let isLLDebug = isDev || getStorage(LL_STORAGE_KEY) === 'true';

// AMLL logs stay off by default in dev until enableAMLLDebug() is called; dist strips them.
let isAMLLDebug = isDev && getStorage(AMLL_STORAGE_KEY) === 'true';

// Dynamic Reflect lookup keeps call-time console spies working and prevents esbuild
// define/pure transforms on static console.* calls from rewriting or stripping our logger.
function callConsole(method: ConsoleMethod, ...args: unknown[]): void {
  if (typeof console === 'undefined' || typeof Reflect === 'undefined') return;
  const fn = Reflect.get(console, method);
  if (typeof fn === 'function') {
    Reflect.apply(fn, console, args);
  }
}

function withPrefix(prefix: string, args: unknown[]): unknown[] {
  if (args.length > 0 && typeof args[0] === 'string') {
    if (args[0].startsWith(prefix)) return args;
    return [`${prefix} ${args[0]}`, ...args.slice(1)];
  }
  return [prefix, ...args];
}

export function enableLLDebug(enable = true): void {
  const next = Boolean(enable);
  isLLDebug = next;
  setStorageFlag(LL_STORAGE_KEY, next);
  callConsole(
    'info',
    `%c[Liquid Lyrics] Debug logs ${next ? 'ENABLED' : 'DISABLED'}`,
    `color: ${next ? '#1ed760' : '#ff5555'}; font-weight: bold;`
  );
}

export function enableAMLLDebug(enable = true): void {
  if (!isDev) {
    callConsole('warn', '[Liquid Lyrics] AMLL internal logs are stripped in production builds.');
    return;
  }
  const next = Boolean(enable);
  isAMLLDebug = next;
  setStorageFlag(AMLL_STORAGE_KEY, next);
  callConsole(
    'info',
    `%c[AMLL] Internal logs ${next ? 'ENABLED' : 'DISABLED'}`,
    `color: ${next ? '#3b82f6' : '#ff5555'}; font-weight: bold;`
  );
}

if (isDev && typeof globalThis !== 'undefined') {
  const amllTarget: AmllConsoleBridge =
    globalThis.__amllConsole ??
    (globalThis.__amllConsole = {
      log: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
      groupCollapsed: () => {},
      groupEnd: () => {},
    });

  const forwardAmll =
    (method: 'log' | 'debug' | 'warn' | 'error') =>
    (...args: unknown[]) => {
      if (isAMLLDebug) callConsole(method, ...withPrefix('[AMLL]', args));
    };

  amllTarget.log = forwardAmll('log');
  amllTarget.debug = forwardAmll('debug');
  amllTarget.warn = forwardAmll('warn');
  amllTarget.error = forwardAmll('error');
  amllTarget.groupCollapsed = (...args: unknown[]) => {
    if (isAMLLDebug) callConsole('groupCollapsed', ...args);
  };
  amllTarget.groupEnd = () => {
    if (isAMLLDebug) callConsole('groupEnd');
  };
}

if (typeof window !== 'undefined') {
  window.enableLLDebug = enableLLDebug;
  window.enableAMLLDebug = enableAMLLDebug;

  Object.defineProperty(window, 'liquidLyricsDebug', {
    get() {
      return isLLDebug;
    },
    set(value: unknown) {
      enableLLDebug(Boolean(value));
    },
    configurable: true,
  });
}

export function isDebugLogging(): boolean {
  return isLLDebug;
}

const forwardLL =
  (method: 'log' | 'info' | 'warn') =>
  (...args: unknown[]) => {
    if (isLLDebug) callConsole(method, ...withPrefix('[Liquid Lyrics]', args));
  };

export const logger = {
  log: forwardLL('log'),
  info: forwardLL('info'),
  warn: forwardLL('warn'),
  error: (...args: unknown[]) => {
    callConsole('error', ...withPrefix('[Liquid Lyrics]', args));
  },
};
