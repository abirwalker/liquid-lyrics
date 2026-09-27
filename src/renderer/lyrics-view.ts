import { DomLyricPlayer, MeshGradientRenderer, LyricLineMouseEvent, type LyricLine } from '@applemusic-like-lyrics/core';
import '@applemusic-like-lyrics/core/style.css';
import './styles.css';
import type { LyricsResult } from '../types/types';
import { convertToAmllLines, type DisplayLyricLine } from './adapter';
import { isRecord } from '../types/types';

export class LyricsView {
  private overlay: HTMLElement;
  private statusEl: HTMLElement;
  private plainLyrics: HTMLElement;
  private player: DomLyricPlayer;
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

    this.player = new DomLyricPlayer();
    this.applyMotionPreference();
    this.player.setWordFadeWidth(0.5);
    this.player.setLinePosYSpringParams({ mass: 1.3 });
    this.player.setAlignPosition(0.35);
    this.player.setOptimizeOptions({ tryAdvanceStartTime: false });

    const playerElement = this.player.getElement();
    playerElement.classList.add('ll-player');
    this.overlay.appendChild(playerElement);
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
    this.overlay.appendChild(this.plainLyrics);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'll-status-msg';
    this.statusEl.setAttribute('role', 'status');
    this.statusEl.textContent = 'Play a song to see its lyrics';
    this.overlay.appendChild(this.statusEl);

    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.requestedOpen) this.callbacks.onClose();
    });
    this.reducedMotion.addEventListener('change', () => this.applyMotionPreference());
  }

  private seekToLine(time: number) {
    if (!Number.isFinite(time) || time < 0) return;
    globalThis.Spicetify?.Player.seek(time);
    this.player.resetScroll();
    this.player.setCurrentTime(time, true);
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

    if (result.lines.length && result.lines.every((line) => line.timing === 'none')) {
      this.lines = [];
      this.backingCues = [];
      this.player.setLyricLines([]);
      this.player.getElement().hidden = true;
      this.statusEl.hidden = true;
      this.plainLyrics.replaceChildren(...result.lines.map((line) => {
        const paragraph = document.createElement('p');
        paragraph.textContent = line.text;
        return paragraph;
      }));
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
    this.plainLyrics.hidden = true;
    this.plainLyrics.replaceChildren();
    this.player.getElement().hidden = false;
    const progress = this.getProgress();
    this.statusEl.hidden = true;
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
    this.updateTimedBacking(progress);
    this.player.update(0);
    this.lastPlaying = null;
  }

  public setLoading() {
    this.showStatus('Looking for lyrics…');
  }

  private showStatus(message: string) {
    this.lines = [];
    this.backingCues = [];
    this.plainLyrics.hidden = true;
    this.plainLyrics.replaceChildren();
    this.player.getElement().hidden = true;
    this.player.setLyricLines([]);
    this.player.update(0);
    this.statusEl.textContent = message;
    this.statusEl.hidden = false;
  }

  public updateTrack(track: unknown) {
    const metadata = isRecord(track) && isRecord(track.metadata) ? track.metadata : {};
    const source = metadata.image_xlarge_url ?? metadata.image_large_url ?? metadata.image_url;
    const url = typeof source === 'string' ? source.replace(/^spotify:image:/, 'https://i.scdn.co/image/') : '';
    if (url === this.artworkUrl) return;
    this.artworkUrl = url;
    this.artworkVersion++;
    if (!url && this.background) this.background.getElement().dataset.ready = 'false';
    if (this.isOpen) this.loadArtwork();
  }

  private loadArtwork() {
    if (!this.artworkUrl || !this.background) return;
    if (this.artworkRequestVersion === this.artworkVersion) return;
    const version = this.artworkVersion;
    this.artworkRequestVersion = version;
    const background = this.background;
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.src = this.artworkUrl;
    void image.decode().then(() => {
      // Serialize texture uploads so an old track cannot overwrite a newer one.
      this.artworkTask = this.artworkTask.then(async () => {
        if (version !== this.artworkVersion) return;
        await background.setAlbum(image);
        if (version !== this.artworkVersion) return;
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
      background.getElement().dataset.ready = 'false';
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
      void this.player.calcLayout(true, true).catch((error: unknown) => {
        console.warn('[Liquid Lyrics] Layout failed:', error);
      });
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
    this.requestedOpen = false;
    this.mountAttempts = 0;
    if (this.mountTimer !== null) clearTimeout(this.mountTimer);
    this.mountTimer = null;
    if (this.mountFrame !== null) cancelAnimationFrame(this.mountFrame);
    this.mountFrame = null;
    if (!this.isOpen) return;
    this.isOpen = false;

    this.hostObserver.disconnect();
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
      this.lastProgress = progress;
      this.player.update(deltaMs);
      this.updateTimedBacking(progress);
    }
    this.animFrameId = requestAnimationFrame(this.onFrame);
  };
}
