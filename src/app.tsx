import { fetchLyrics } from './lyrics/chain';
import { createLyricsController, initPlayerListener } from './player/listener';
import { fetchSpotifySongwriters } from './player/credits';
import { LyricsView } from './renderer/lyrics-view';
import type { LyricsResult } from './types/types';

const LIQUID_ICON = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 5 23 15" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <g transform="translate(6.5 11) rotate(36)">
    <path d="M -2.25 0 A 3.2 3.2 0 1 1 2.25 0" />
    <path d="M -2.25 0 L -1.75 7.5 A 1.75 1.75 0 0 0 1.75 7.5 L 2.25 0 Z" />
  </g>
  <path d="M 14 7 H 21" />
  <path d="M 14 12 H 18" />
  <path d="M 14 17 H 21" />
</svg>
`;

async function main() {
  while (!globalThis.Spicetify?.showNotification || !globalThis.Spicetify?.Player?.data ||
    (!globalThis.Spicetify.Playbar?.Button && !globalThis.Spicetify.Topbar?.Button)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const spicetify = globalThis.Spicetify;

  const BASE_ROUTE = '/liquid-lyrics';
  let playbarBtn: Spicetify.Button | null = null;
  let toggleElement: HTMLButtonElement | null = null;
  let previousPath = '/';
  let openedFromButton = false;
  const history = spicetify.Platform?.History;
  const isLyricsRoute = () => history?.location.pathname === BASE_ROUTE;
  const closeLyrics = () => {
    lyricsView.unmount();
    if (isLyricsRoute()) {
      if (openedFromButton) history?.goBack();
      else history?.push(previousPath);
    }
    toggleElement?.focus();
  };
  const lyricsView = new LyricsView({ onClose: closeLyrics, onVisibilityChange: updateButtonState });

  function updateButtonState(isActive: boolean) {
    if (playbarBtn) {
      playbarBtn.active = isActive;
    }
    if (toggleElement) {
      toggleElement.classList.toggle('active', isActive);
      toggleElement.setAttribute('aria-pressed', String(isActive));
    }
  }

  const openLyrics = () => {
    if (lyricsView.getIsVisible() || isLyricsRoute()) return;
    if (history) {
      previousPath = history.location.pathname;
      openedFromButton = true;
      history.push(BASE_ROUTE);
    } else {
      lyricsView.mount();
    }
  };

  const toggleLyrics = () => {
    if (lyricsView.getIsVisible() || isLyricsRoute()) closeLyrics();
    else openLyrics();
  };

  const EXTRA_CONTROLS_SEL = '.main-nowPlayingBar-extraControls';

  function findPlaybarControls(): HTMLElement | null {
    const playbar = document.querySelector('[data-testid="now-playing-bar"], .Root__now-playing-bar');
    const nativeControl = playbar?.querySelector<HTMLElement>(
      'button[data-testid="lyrics-button"], button[data-testid="pip-toggle-button"], button[data-testid="fullscreen-mode-button"]',
    );
    return nativeControl?.parentElement ?? document.querySelector<HTMLElement>(EXTRA_CONTROLS_SEL);
  }

  function makeBtn(icon: string, title: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'VL-PlaybarBtn ll-toggle';
    btn.setAttribute('aria-label', title);
    btn.innerHTML = icon;
    btn.addEventListener('click', onClick);

    const attachTooltip = () => {
      const sp = (globalThis as any).Spicetify;
      if (sp?.Tippy) {
        sp.Tippy(btn, {
          ...(sp.TippyProps?.default ?? sp.TippyProps),
          content: title,
        });
        return true;
      }
      return false;
    };

    if (!attachTooltip()) {
      const timer = setInterval(() => {
        if (attachTooltip()) clearInterval(timer);
      }, 200);
      setTimeout(() => clearInterval(timer), 5000);
    }

    return btn;
  }

  function injectButtons(): void {
    const container = findPlaybarControls();
    if (!container) return;
    if (toggleElement && container.contains(toggleElement)) return;

    if (playbarBtn) {
      playbarBtn.deregister();
      playbarBtn = null;
      toggleElement = null;
    }

    if (!toggleElement) {
      toggleElement = makeBtn(LIQUID_ICON, 'Liquid Lyrics', () => toggleLyrics());
    }
    container.prepend(toggleElement);
    updateButtonState(lyricsView.getIsVisible() || isLyricsRoute());
  }

  function observePlaybar(): void {
    const observer = new MutationObserver(() => {
      const container = findPlaybarControls();
      if (container && (!toggleElement || !container.contains(toggleElement))) {
        injectButtons();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  injectButtons();
  observePlaybar();
  const replaceFullscreen = (event: MouseEvent) => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>('button[data-testid="fullscreen-mode-button"]') : null;
    if (!button || button.disabled || !button.closest('[data-testid="now-playing-bar"], .Root__now-playing-bar')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    lyricsView.enterFullscreen(button);
  };
  window.addEventListener('click', replaceFullscreen, true);
  window.addEventListener('pagehide', () => {
    window.removeEventListener('click', replaceFullscreen, true);
    lyricsView.unmount();
  }, { once: true });

  if (!toggleElement && spicetify.Playbar?.Button) {
    try {
      playbarBtn = new spicetify.Playbar.Button(
        'Liquid Lyrics',
        LIQUID_ICON,
        () => toggleLyrics(),
        false,
        false,
      );
      toggleElement = playbarBtn.element;
    } catch (err) {
      playbarBtn = null;
      console.warn('[Liquid Lyrics] Playbar button registration failed, trying Topbar:', err);
    }
  }

  if (!toggleElement && spicetify.Topbar?.Button) {
    try {
      const topbarBtn = new spicetify.Topbar.Button('Liquid Lyrics', LIQUID_ICON, () => toggleLyrics());
      toggleElement = topbarBtn.button;
    } catch (err) {
      console.warn('[Liquid Lyrics] Topbar button registration failed:', err);
    }
  }

  if (toggleElement && !toggleElement.classList.contains('ll-toggle')) {
    toggleElement.classList.add('VL-PlaybarBtn', 'll-toggle');
    toggleElement.setAttribute('aria-label', 'Liquid Lyrics');
    toggleElement.removeAttribute('title');
  }
  updateButtonState(false);
  if (history) {
    const syncRoute = () => {
      if (isLyricsRoute()) lyricsView.mount();
      else {
        openedFromButton = false;
        previousPath = history.location.pathname;
        lyricsView.unmount();
      }
    };
    history.listen(syncRoute);
    syncRoute();
  }

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      toggleLyrics();
    }
  });

  const controller = createLyricsController(fetchLyrics, {
    onLyricsLoaded: (result, query) => {
      if (!result || result.instrumental || result.songwriters?.length || !query.spotifyId) return;
      void fetchSpotifySongwriters(query.spotifyId).then(songwriters => controller.setSongwriters(query, songwriters));
    },
  });

  let displayedItem: unknown = null;
  let displayedResult: LyricsResult | null = null;
  controller.subscribe(state => {
    const trackChanged = state.item !== displayedItem;
    if (trackChanged) {
      lyricsView.updateTrack(state.item);
      displayedItem = state.item;
      displayedResult = null;
    }
    if (state.status === 'loading') {
      lyricsView.setLoading();
      displayedResult = null;
    } else if (state.status === 'ready' && state.result) {
      if (displayedResult && displayedResult.lines === state.result.lines) {
        if (state.result.songwriters) lyricsView.setSongwriters(state.result.songwriters);
      } else lyricsView.setLyrics(state.result);
      displayedResult = state.result;
    } else if (state.status !== 'idle' || state.item !== null || trackChanged) {
      lyricsView.setLyrics(null);
      displayedResult = null;
    }
  });

  initPlayerListener(controller, spicetify);
}

void main().catch((error: unknown) => console.error('[Liquid Lyrics] Initialization failed:', error));
