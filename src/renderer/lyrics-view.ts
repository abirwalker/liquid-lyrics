import { DomLyricPlayer, MeshGradientRenderer, LyricLineMouseEvent, LayoutReason, type LyricLine } from '@applemusic-like-lyrics/core';
import '@applemusic-like-lyrics/core/style.css';
import './styles.css';
import type { LyricsResult } from '../types/types';
import { convertToAmllLines, type DisplayLyricLine } from './adapter';
import { getSongwriters, isRecord } from '../types/types';
import { TrackPanel } from './track-panel';
import { FullscreenControls } from './fullscreen-controls';

const PROVIDER_CREDITS = new Map([
  ['binilyrics', 'BiniLyrics · Binimum'],
  ['lyricsplus', 'LyricsPlus · Binimum'],
  ['spotify', 'Spotify'],
  ['amll', 'AMLL'],
  ['lrclib', 'LRCLIB'],
]);

const LYRIC_ALIGN_POSITION = 0.35;
const CREDITS_END_POSITION = 0.7;

class CreditsLyricPlayer extends DomLyricPlayer {
  private cachedFooterOffset: number | null = null;

  public invalidateFooterOffset() {
    this.cachedFooterOffset = null;
  }

  public setReadingPosition(position: number) {
    this.invalidateFooterOffset();
    this.setAlignPosition(position);
  }

  public override calcLayout(reason: any) {
    if (reason === LayoutReason.Resize || reason === LayoutReason.ConfigChange) {
      this.cachedFooterOffset = null;
    }
    return super.calcLayout(reason);
  }

  constructor() {
    super();
    const layoutCalc = (this as any).layoutCalculator;
    if (layoutCalc && layoutCalc.beginFrame) {
      const originalBeginFrame = layoutCalc.beginFrame.bind(layoutCalc);
      layoutCalc.beginFrame = (ctx: any, config: any) => {
        const res = originalBeginFrame(ctx, config);
        const height = ctx.containerHeight || this.size[1];
        const footerHeight = (this as any).bottomLine?.lineSize?.[1] || 0;
        if (!height || !footerHeight || !(this as any).hasBottomContent || !res.session.isValid) {
          return res;
        }

        if (this.cachedFooterOffset === null) {
          const footer = this.getBottomLineElement().firstElementChild as HTMLElement | null;
          const bottomLineWrapper = (this as any).bottomLine?.getElement() as HTMLElement | undefined;
          if (footer && bottomLineWrapper) {
            const offset = footer.getBoundingClientRect().bottom - bottomLineWrapper.getBoundingClientRect().top;
            this.cachedFooterOffset = offset > 0 ? offset : footerHeight;
          }
        }
        const footerBottomOffset = this.cachedFooterOffset ?? footerHeight;

        const { focalTopY, anchorOffset, interludeTotalHeight, activeInterludeAnchor, alignPosition } = res.session;
        const containerHeight = res.session.containerHeight || height;
        if (containerHeight <= 0) return res;
        let totalContentHeight = layoutCalc.totalLyricHeight;
        if (activeInterludeAnchor !== void 0) totalContentHeight += interludeTotalHeight;
        const unscrolledBottom = containerHeight * alignPosition - anchorOffset - focalTopY + totalContentHeight + footerBottomOffset;
        const endPosition = containerHeight * CREDITS_END_POSITION;

        if (unscrolledBottom <= endPosition) {
          const shift = endPosition - unscrolledBottom;
          res.session.alignPosition += shift / containerHeight;
          res.bounds.max = 0;
        } else {
          res.bounds.max = Math.max(0, unscrolledBottom - endPosition);
        }
        return res;
      };
    }

    const focusCtrl = (this as any).focusController;
    if (focusCtrl && focusCtrl.resolve) {
      const origResolve = focusCtrl.resolve.bind(focusCtrl);
      focusCtrl.resolve = (snapshot: any, lineCount: number, flags: any) => {
        const target = origResolve(snapshot, lineCount, flags);
        const groupCount = this.currentLyricGroups?.length ?? lineCount;
        if (
          !flags?.isAutoAlignSuspended &&
          flags?.hasBottomContent &&
          groupCount > 0 &&
          !snapshot.activeInterlude &&
          snapshot.scrollToIndex >= groupCount - 1
        ) {
          const lastGroup = this.currentLyricGroups[groupCount - 1];
          const lastStart = Number(lastGroup?.startTime ?? 0);
          const mainEnd = Number(lastGroup?.endTime ?? lastStart);
          const bgEnd = Number((lastGroup?.bgLine as any)?.getLine?.()?.endTime ?? 0);
          const lastEnd = Math.max(mainEnd, bgEnd);
          const effectiveEnd = lastEnd > lastStart ? lastEnd : (lastStart + 2000);
          const currentTime = Number(snapshot.currentTime ?? 0);
          if (currentTime >= effectiveEnd && snapshot.playingGroups.size === 0) {
            const bottomTarget = { type: 'bottom' as const };
            focusCtrl.target = bottomTarget;
            return bottomTarget;
          }
        }
        return target;
      };
    }
  }
}

export class LyricsView {
  private overlay: HTMLElement;
  private fullscreen = false;
  private returnToMain = false;
  private fullscreenControls: FullscreenControls | null = null;
  private fullscreenTrigger: HTMLElement | null = null;
  private rootOverflow = '';
  private bodyOverflow = '';
  private statusEl: HTMLElement;
  private plainLyrics: HTMLElement;
  private player: CreditsLyricPlayer;
  private trackPanel: TrackPanel;
  private background: MeshGradientRenderer | null = null;
  private artworkUrl = '';
  private artworkVersion = 0;
  private artworkRequestVersion = -1;
  private artworkTask: Promise<void> = Promise.resolve();
  private reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  private host: HTMLElement | null = null;
  private hostPosition = '';
  private changedHostPosition = false;
  private mountTimer: ReturnType<typeof setTimeout> | null = null;
  private mountFrame: number | null = null;
  private mountAttempts = 0;
  private requestedOpen = false;
  private lastPlaying: boolean | null = null;
  private lastProgress: number | null = null;
  private lines: LyricLine[] = [];
  private finalLyricStart: number | null = null;
  private creditResult: LyricsResult | null = null;
  private backingCues: Array<{ element: HTMLElement; wrapper: HTMLElement; startMs: number; endMs: number; inferred: boolean }> = [];
  private isOpen = false;
  private animFrameId: number | null = null;
  private lastFrameTime = performance.now();
  private hiddenSiblings = new Map<HTMLElement, string>();
  private hostObserver = new MutationObserver(() => this.hideHostContent());
  private savedScrollTop = 0;
  private callbacks: { onClose: () => void; onVisibilityChange: (visible: boolean) => void };

  constructor(callbacks: { onClose: () => void; onVisibilityChange: (visible: boolean) => void }) {
    this.callbacks = callbacks;
    this.overlay = document.createElement('div');
    this.overlay.id = 'liquid-lyrics-overlay';
    const layout = document.createElement('div');
    layout.className = 'll-layout';
    const lyricStage = document.createElement('div');
    lyricStage.className = 'll-lyric-stage';
    this.trackPanel = new TrackPanel(this.overlay);
    layout.append(this.trackPanel.element, lyricStage);
    this.overlay.append(layout);

    this.player = new CreditsLyricPlayer();
    this.applyMotionPreference();
    this.player.setWordFadeWidth(0.5);
    this.player.setLinePosYSpringParams({ mass: 1.3 });
    this.player.setReadingPosition(LYRIC_ALIGN_POSITION);
    this.player.setOptimizeOptions({ tryAdvanceStartTime: false });

    const playerElement = this.player.getElement();
    playerElement.classList.add('ll-player');
    lyricStage.appendChild(playerElement);
    playerElement.tabIndex = 0;
    playerElement.setAttribute('role', 'region');
    playerElement.setAttribute('aria-label', 'Lyrics. Use Up and Down to seek between lines.');
    this.player.addEventListener('line-click', (event) => {
      if (event instanceof LyricLineMouseEvent) this.seekToLine(event.line.getLine().startTime);
    });
    playerElement.addEventListener('keydown', (event) => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || !this.lines.length) return;
      event.preventDefault();
      const progress = this.getProgress();
      let index = this.lines.length - 1;
      if (event.key === 'Home') index = 0;
      else if (event.key === 'ArrowDown') index = this.lines.findIndex((line) => line.startTime > progress + 100);
      else if (event.key === 'ArrowUp') {
        while (index >= 0 && this.lines[index].startTime >= progress - 100) index--;
      }
      if (index >= 0) this.seekToLine(this.lines[index].startTime);
    });

    this.plainLyrics = document.createElement('div');
    this.plainLyrics.className = 'll-plain-lyrics';
    this.plainLyrics.tabIndex = 0;
    this.plainLyrics.setAttribute('role', 'region');
    this.plainLyrics.setAttribute('aria-label', 'Lyrics without timing');
    this.plainLyrics.hidden = true;
    lyricStage.appendChild(this.plainLyrics);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'll-status-msg';
    this.statusEl.setAttribute('role', 'status');
    this.statusEl.textContent = 'Play a song to see its lyrics';
    lyricStage.appendChild(this.statusEl);

    window.addEventListener('keydown', (event) => {
      if (this.fullscreen && event.key === 'Tab') {
        const focusable = [...this.overlay.querySelectorAll<HTMLElement>('button, a[href], input, [tabindex="0"]')]
          .filter(element => element.getClientRects().length && !element.matches(':disabled'));
        const index = focusable.indexOf(document.activeElement as HTMLElement);
        if (focusable.length && (index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === focusable.length - 1)) {
          event.preventDefault();
          focusable[event.shiftKey ? focusable.length - 1 : 0].focus();
        }
      }
      if (event.key === 'Escape' && this.requestedOpen) {
        if (this.fullscreen) this.exitFullscreen();
        else this.callbacks.onClose();
      }
    });
    this.reducedMotion.addEventListener('change', () => this.applyMotionPreference());
  }

  private seekToLine(time: number) {
    if (!Number.isFinite(time) || time < 0) return;
    globalThis.Spicetify?.Player.seek(time);
    this.player.resetScroll();
    this.player.setCurrentTime(time, true);
    this.updateCreditFocus(time);
    this.updateTimedBacking(time);
    this.lastProgress = time;
  }

  private getProgress() {
    const progress = globalThis.Spicetify?.Player.getProgress() ?? 0;
    return Number.isFinite(progress) ? Math.max(0, Math.round(progress)) : 0;
  }

  private applyMotionPreference() {
    const animate = !this.reducedMotion.matches;
    this.player.setEnableBlur(animate);
    this.player.setEnableSpring(animate);
    this.player.setEnableScale(false);
    this.background?.setStaticMode(!animate || !globalThis.Spicetify?.Player.isPlaying());
  }

  public setLyrics(result: LyricsResult | null) {
    if (!result || result.instrumental) {
      this.showStatus(result?.instrumental ? 'Instrumental track' : 'No lyrics available');
      return;
    }

    this.creditResult = result;
    this.finalLyricStart = null;
    this.updateCreditFocus(0);

    if (result.lines.length && result.lines.every((line) => line.timing === 'none')) {
      this.lines = [];
      this.backingCues = [];
      this.player.setLyricLines([]);
      this.player.getBottomLineElement().replaceChildren();
      this.player.getElement().hidden = true;
      this.statusEl.hidden = true;
      this.plainLyrics.replaceChildren(...result.lines.map((line) => {
        const paragraph = document.createElement('p');
        paragraph.textContent = line.text;
        return paragraph;
      }));
      this.plainLyrics.appendChild(this.makeCredits(result));
      this.plainLyrics.hidden = false;
      this.plainLyrics.scrollTop = 0;
      return;
    }

    const lines = convertToAmllLines(result);
    if (lines.length === 0) {
      this.showStatus('No lyrics available');
      return;
    }

    this.lines = lines;
    this.finalLyricStart = lines.filter(line => !line.isBG && line.words.some(word => word.word.trim()))
      .at(-1)?.startTime ?? null;
    this.plainLyrics.hidden = true;
    this.plainLyrics.replaceChildren();
    this.player.getElement().hidden = false;
    const progress = this.getProgress();
    this.statusEl.hidden = true;
    this.player.getBottomLineElement().replaceChildren(this.makeCredits(result));
    this.player.invalidateFooterOffset();
    this.player.resetScroll();
    this.player.setLyricLines(lines, progress);
    this.backingCues = this.player.currentLyricGroups.flatMap((group) => {
      const backing = group.bgLine?.getLine() as DisplayLyricLine | undefined;
      if (!backing?.words.length || !group.bgLine || !group.bgWrapper) return [];
      return [{ element: group.bgLine.getElement(), wrapper: group.bgWrapper,
        startMs: backing.words[0].startTime, endMs: backing.words[backing.words.length - 1].endTime,
        inferred: backing.inferredBacking === true }];
    });
    this.player.setCurrentTime(progress, true);
    this.updateCreditFocus(progress);
    this.updateTimedBacking(progress);
    this.player.update(0);
    this.lastPlaying = null;
  }

  public setLoading() {
    this.showStatus('Looking for lyrics…');
  }

  public setSongwriters(names: string[]) {
    const songwriters = getSongwriters(names);
    if (!this.creditResult || !songwriters.length || this.creditResult.songwriters?.length) return;
    this.creditResult = { ...this.creditResult, songwriters };
    const footer = this.overlay.querySelector('.ll-credits');
    footer?.replaceWith(this.makeCredits(this.creditResult));
    this.player.invalidateFooterOffset();
  }

  private makeCredits(result: LyricsResult): HTMLElement {
    const footer = document.createElement('footer');
    footer.className = 'll-credits';
    footer.setAttribute('aria-label', 'Song and lyric credits');
    if (result.songwriters?.length) {
      const label = document.createElement('p');
      label.className = 'll-credits-label';
      label.textContent = 'Written by';
      const writers = document.createElement('p');
      writers.className = 'll-credits-writers';
      writers.textContent = result.songwriters.join(', ');
      footer.append(label, writers);
    }
    const provider = document.createElement('p');
    provider.className = 'll-credits-source';
    provider.textContent = `Provided by ${PROVIDER_CREDITS.get(result.source) ?? result.source}`;
    footer.appendChild(provider);
    return footer;
  }

  private showStatus(message: string) {
    this.creditResult = null;
    this.finalLyricStart = null;
    this.updateCreditFocus(0);
    this.lines = [];
    this.backingCues = [];
    this.plainLyrics.hidden = true;
    this.plainLyrics.replaceChildren();
    this.player.getElement().hidden = true;
    this.player.setLyricLines([]);
    this.player.getBottomLineElement().replaceChildren();
    this.player.update(0);
    this.statusEl.textContent = message;
    this.statusEl.hidden = false;
  }

  public updateTrack(track: unknown) {
    this.trackPanel.updateTrack(track);
    const metadata = isRecord(track) && isRecord(track.metadata) ? track.metadata : {};
    const source = metadata.image_xlarge_url ?? metadata.image_large_url ?? metadata.image_url;
    const url = typeof source === 'string' ? source.replace(/^spotify:image:/, 'https://i.scdn.co/image/') : '';
    if (url === this.artworkUrl) return;
    this.trackPanel.setArtwork(null);
    this.artworkUrl = url;
    this.artworkVersion++;
    if (!url && this.background) {
      this.background.getElement().dataset.ready = 'false';
      this.pruneStaleBackgroundMeshes(1);
    }
    if (this.isOpen) this.loadArtwork();
  }

  private pruneStaleBackgroundMeshes(keepCount = 1) {
    const bg = this.background as any;
    if (Array.isArray(bg?.meshStates) && bg.meshStates.length > keepCount) {
      const stale = bg.meshStates.splice(0, bg.meshStates.length - keepCount);
      for (const state of stale) {
        state.mesh?.dispose?.();
        state.texture?.dispose?.();
      }
    }
  }

  private loadArtwork() {
    if (!this.artworkUrl) return;
    if (this.artworkRequestVersion === this.artworkVersion) return;
    const version = this.artworkVersion;
    this.artworkRequestVersion = version;
    const background = this.background;
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.src = this.artworkUrl;
    void image.decode().then(() => {
      if (version !== this.artworkVersion) return;
      this.trackPanel.setArtwork(image);
      if (!background) return;
      // Serialize texture uploads so an old track cannot overwrite a newer one.
      this.artworkTask = this.artworkTask.then(async () => {
        if (version !== this.artworkVersion) return;
        this.pruneStaleBackgroundMeshes(1);
        await background.setAlbum(image);
        if (version !== this.artworkVersion) return;
        this.pruneStaleBackgroundMeshes(2);
        background.getElement().dataset.ready = 'true';
        background.resume();
        background.setStaticMode(this.reducedMotion.matches || !globalThis.Spicetify?.Player.isPlaying());
        if (!this.isOpen) background.pause();
      }).catch((error: unknown) => {
        if (version !== this.artworkVersion) return;
        this.artworkRequestVersion = -1;
        background.getElement().dataset.ready = 'false';
        console.warn('[Liquid Lyrics] Artwork rendering failed:', error);
      });
    }).catch((error: unknown) => {
      if (version !== this.artworkVersion) return;
      this.artworkRequestVersion = -1;
      if (background) background.getElement().dataset.ready = 'false';
      console.warn('[Liquid Lyrics] Artwork unavailable:', error);
    });
  }

  private getPageRoot(): HTMLElement | null {
    const selectors = [
      '.Root__main-view .main-view-container',
      '.Root__main-view',
      'main[aria-label]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el) return el;
    }
    return null;
  }

  public enterFullscreen(trigger?: HTMLElement) {
    if (this.fullscreen) return;
    if (document.fullscreenElement && document.fullscreenElement !== this.overlay) {
      globalThis.Spicetify?.showNotification('Exit the current full-screen view first.', true);
      return;
    }
    if (!this.isOpen && !this.getPageRoot()) {
      globalThis.Spicetify?.showNotification('Could not open full screen. Try again when Spotify finishes loading.', true);
      return;
    }
    this.returnToMain = this.isOpen;
    this.mount();
    if (!this.isOpen) return;
    this.fullscreen = true;
    this.rootOverflow = document.documentElement.style.overflow;
    this.bodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    this.fullscreenTrigger = trigger ?? null;
    this.overlay.classList.add('ll-fullscreen');
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-label', 'Liquid Lyrics full screen');
    document.body.append(this.overlay);
    this.trackPanel.setFullscreen(true);
    this.fullscreenControls = new FullscreenControls(() => this.exitFullscreen());
    this.trackPanel.element.append(this.fullscreenControls.element);
    this.overlay.append(this.fullscreenControls.exitButton, this.fullscreenControls.volume, this.fullscreenControls.trackActions.feedback);
    this.player.setReadingPosition(LYRIC_ALIGN_POSITION);
    this.fullscreenControls.update();
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    this.fullscreenControls.exitButton.focus();
    this.player.calcLayout(LayoutReason.Resize);
    // A blocked browser API still leaves a usable full-window lyrics view.
    if (this.overlay.requestFullscreen) void this.overlay.requestFullscreen().then(() => {
      if (!this.fullscreen && document.fullscreenElement === this.overlay) void document.exitFullscreen();
    }).catch(error => console.info('[Liquid Lyrics] Using full-window mode:', error));
  }

  private onFullscreenChange = () => {
    if (this.fullscreen && document.fullscreenElement !== this.overlay) this.exitFullscreen();
  };

  public exitFullscreen() {
    if (!this.fullscreen) return;
    this.fullscreen = false;
    document.documentElement.style.overflow = this.rootOverflow;
    document.body.style.overflow = this.bodyOverflow;
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    if (document.fullscreenElement === this.overlay) void document.exitFullscreen().catch(error =>
      console.warn('[Liquid Lyrics] Full-screen exit failed:', error));
    this.fullscreenControls?.dispose();
    this.fullscreenControls?.element.remove();
    this.fullscreenControls?.exitButton.remove();
    this.fullscreenControls?.volume.remove();
    this.player.setReadingPosition(LYRIC_ALIGN_POSITION);
    this.fullscreenControls = null;
    this.overlay.classList.remove('ll-fullscreen');
    this.overlay.removeAttribute('role');
    this.overlay.removeAttribute('aria-modal');
    this.overlay.removeAttribute('aria-label');
    this.host?.prepend(this.overlay);
    this.trackPanel.setFullscreen(false);
    if (!this.returnToMain) this.unmount();
    else this.player.calcLayout(LayoutReason.Resize);
    this.fullscreenTrigger?.focus();
    this.fullscreenTrigger = null;
  }

  public mount() {
    this.requestedOpen = true;
    if (this.isOpen) return;
    if (this.mountTimer !== null) clearTimeout(this.mountTimer);
    this.mountTimer = null;
    const pageRoot = this.getPageRoot();
    if (!pageRoot) {
      if (++this.mountAttempts < 50) this.mountTimer = setTimeout(() => this.mount(), 100);
      else {
        this.requestedOpen = false;
        this.mountAttempts = 0;
        globalThis.Spicetify?.showNotification('Could not open lyrics. Try opening them again.', true);
        this.callbacks.onClose();
      }
      return;
    }

    this.isOpen = true;
    this.mountAttempts = 0;
    this.host = pageRoot;
    this.hostPosition = pageRoot.style.position;
    this.changedHostPosition = getComputedStyle(pageRoot).position === 'static';
    if (this.changedHostPosition) pageRoot.style.position = 'relative';
    this.savedScrollTop = pageRoot.scrollTop;
    this.hideHostContent();
    pageRoot.prepend(this.overlay);
    this.trackPanel.mount();
    this.hostObserver.observe(pageRoot, { childList: true });
    pageRoot.scrollTop = 0;

    if (!this.background) {
      try {
        const canvas = document.createElement('canvas');
        canvas.className = 'll-background';
        this.background = new MeshGradientRenderer(canvas);
        this.background.setFPS(30);
        this.background.setFlowSpeed(2);
        this.background.setStaticMode(this.reducedMotion.matches);
        this.overlay.prepend(canvas);
      } catch (error) {
        console.warn('[Liquid Lyrics] Background unavailable:', error);
      }
    }
    this.loadArtwork();
    this.callbacks.onVisibilityChange(true);

    this.startLoop();

    // AMLL measures its stage on layout. Remeasure after the browser places
    // the overlay so the anchor math uses the visible box, not a stale one.
    this.mountFrame = requestAnimationFrame(() => {
      this.mountFrame = null;
      if (!this.isOpen) return;
      pageRoot.scrollTop = 0;
      this.player.setCurrentTime(this.getProgress(), true);
      this.player.calcLayout(LayoutReason.Resize);
    });
  }

  private hideHostContent() {
    if (!this.host) return;
    for (const child of this.host.children) {
      if (!(child instanceof HTMLElement) || child === this.overlay) continue;
      if (!this.hiddenSiblings.has(child)) this.hiddenSiblings.set(child, child.style.display);
      child.style.display = 'none';
    }
  }

  public unmount() {
    if (this.fullscreen) {
      this.returnToMain = true;
      this.exitFullscreen();
    }
    this.requestedOpen = false;
    this.mountAttempts = 0;
    if (this.mountTimer !== null) clearTimeout(this.mountTimer);
    this.mountTimer = null;
    if (this.mountFrame !== null) cancelAnimationFrame(this.mountFrame);
    this.mountFrame = null;
    if (!this.isOpen) return;
    this.isOpen = false;

    this.hostObserver.disconnect();
    this.trackPanel.unmount();
    this.overlay.remove();

    for (const [el, display] of this.hiddenSiblings) {
      el.style.display = display;
    }
    this.hiddenSiblings.clear();
    if (this.host) {
      if (this.changedHostPosition) this.host.style.position = this.hostPosition;
      this.host.scrollTop = this.savedScrollTop;
    }
    this.host = null;

    this.stopLoop();
    this.player.pause();
    this.background?.pause();
    this.pruneStaleBackgroundMeshes(1);
    this.callbacks.onVisibilityChange(false);
  }

  public getIsVisible() {
    return this.requestedOpen;
  }

  private startLoop() {
    this.lastFrameTime = performance.now();
    this.lastPlaying = null;
    this.lastProgress = null;
    if (this.animFrameId === null) this.animFrameId = requestAnimationFrame(this.onFrame);
  }

  private updateCreditFocus(progress: number) {
    this.player.getBottomLineElement().classList.toggle('ll-credits-readable',
      this.finalLyricStart !== null && progress >= this.finalLyricStart);
  }

  private updateTimedBacking(progress: number) {
    for (const cue of this.backingCues) {
      const finished = progress >= cue.endMs;
      if (finished && !cue.wrapper.classList.contains('ll-backing-finished')) {
        cue.wrapper.style.setProperty('--ll-backing-height', `${cue.wrapper.offsetHeight}px`);
      }
      cue.element.classList.toggle('ll-backing-singing', cue.inferred && progress >= cue.startMs && progress < cue.endMs);
      cue.element.classList.toggle('ll-backing-finished', finished);
      cue.wrapper.classList.toggle('ll-backing-finished', finished);
      cue.wrapper.classList.toggle('ll-backing-past', progress >= cue.endMs + 450);
    }
  }

  private stopLoop() {
    if (this.animFrameId === null) return;
    cancelAnimationFrame(this.animFrameId);
    this.animFrameId = null;
  }

  private onFrame = (now: number) => {
    this.fullscreenControls?.update();
    if (!this.isOpen) {
      this.animFrameId = null;
      return;
    }

    const deltaMs = Math.min(now - this.lastFrameTime, 100);
    this.lastFrameTime = now;
    const spotifyPlayer = globalThis.Spicetify?.Player;
    if (spotifyPlayer) {
      const playing = spotifyPlayer.isPlaying();
      if (playing !== this.lastPlaying) {
        if (playing) this.player.resume();
        else this.player.pause();
        this.background?.setStaticMode(!playing || this.reducedMotion.matches);
        this.background?.resume();
        this.lastPlaying = playing;
      }
      const progress = this.getProgress();
      const seeking = this.lastProgress === null || Math.abs(progress - this.lastProgress) > 1000;
      this.player.setCurrentTime(progress, seeking);
      this.updateCreditFocus(progress);
      this.lastProgress = progress;
      this.player.update(deltaMs);
      this.updateTimedBacking(progress);
    }
    this.animFrameId = requestAnimationFrame(this.onFrame);
  };
}
