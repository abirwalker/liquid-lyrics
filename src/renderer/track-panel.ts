import { isRecord } from '../types/types';

function trackLink(name: string, uri: unknown, type: 'track' | 'artist' | 'album'): Node {
  const match = typeof uri === 'string' ? /^spotify:(track|artist|album):([A-Za-z0-9]{22})$/.exec(uri) : null;
  if (!match || match[1] !== type || !name) return document.createTextNode(name);
  const path = `/${type}/${match[2]}`;
  const link = document.createElement('a');
  link.href = `https://open.spotify.com${path}`;
  link.textContent = name;
  link.addEventListener('click', event => {
    const history = globalThis.Spicetify?.Platform?.History;
    if (!history || event.defaultPrevented || event.button !== 0 ||
        event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    history.push(path);
  });
  return link;
}

function getWindowZoom(): number {
  if (innerWidth <= 0 || innerHeight <= 0 || outerWidth <= 0 || outerHeight <= 0) return 1;
  // Outer window dimensions stay in OS units during page zoom. The smaller ratio
  // avoids treating a docked DevTools pane on one axis as additional zoom.
  const zoom = Math.min(outerWidth / innerWidth, outerHeight / innerHeight);
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

export function getNowPlayingState(previous: 'visible' | 'hidden' | 'unknown' = 'unknown'): 'visible' | 'hidden' | 'unknown' {
  // Queue replaces the sidebar without exposing whether NPV was open underneath.
  if (document.querySelector('[data-testid="control-button-queue"]')?.getAttribute('aria-pressed') === 'true') return previous;
  const panel = document.getElementById('Desktop_PanelContainer_Id');
  if (!panel || panel.closest('[aria-hidden="true"], [hidden]')) return 'hidden';
  const panelLabel = panel.getAttribute('aria-label')?.trim();
  const triggerLabel = document.querySelector('[data-testid="cover-art-button"]')?.getAttribute('aria-label')?.trim();
  if (!panelLabel || !triggerLabel) return 'unknown';
  if (panelLabel !== triggerLabel) return previous;
  for (let element: HTMLElement | null = panel; element; element = element.parentElement) {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' ||
        style.visibility === 'collapse' || Number(style.opacity) === 0) return 'hidden';
  }
  const rect = panel.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 &&
    rect.left < innerWidth && rect.top < innerHeight ? 'visible' : 'hidden';
}

export class TrackPanel {
  readonly element = document.createElement('section');
  private cover = document.createElement('div');
  private title = document.createElement('p');
  private artist = document.createElement('p');
  private album = document.createElement('span');
  private mounted = false;
  private nowPlayingState: 'visible' | 'hidden' | 'unknown' = 'unknown';
  private frame: number | null = null;
  private hasArtwork = false;
  private hasTitle = false;
  private overlay: HTMLElement;
  private resizeObserver = new ResizeObserver(() => this.schedule());
  private observer = new MutationObserver(records => {
    const panel = document.getElementById('Desktop_PanelContainer_Id');
    const trigger = document.querySelector('[data-testid="cover-art-button"]');
    const queue = document.querySelector('[data-testid="control-button-queue"]');
    const selector = '#Desktop_PanelContainer_Id, [data-testid="cover-art-button"], [data-testid="control-button-queue"]';
    if (records.some(record => {
      if (this.overlay.contains(record.target)) return false;
      if (record.type === 'attributes') return record.target instanceof Element &&
        ((panel !== null && record.target.contains(panel)) || (trigger !== null && record.target.contains(trigger)) ||
          (queue !== null && record.target.contains(queue)));
      return [...record.addedNodes, ...record.removedNodes].some(node =>
        node instanceof Element && (node.matches(selector) || node.querySelector(selector)));
    })) this.schedule();
  });

  constructor(overlay: HTMLElement) {
    this.overlay = overlay;
    this.element.className = 'll-track-panel';
    this.element.setAttribute('aria-label', 'Current track');
    this.element.hidden = true;
    this.cover.className = 'll-track-cover';
    this.title.className = 'll-track-title';
    this.artist.className = 'll-track-artist';
    this.album.className = 'll-track-album';
    this.album.hidden = true;
    this.element.append(this.cover, this.title, this.artist);
  }

  updateTrack(track: unknown) {
    const item = isRecord(track) ? track : {};
    const metadata = isRecord(item.metadata) ? item.metadata : {};
    const title = typeof item.name === 'string' ? item.name : metadata.title;
    this.title.replaceChildren(trackLink(typeof title === 'string' ? title.trim() : '', item.uri, 'track'));
    const artists = Array.isArray(item.artists) ? item.artists.flatMap(artist =>
      isRecord(artist) && typeof artist.name === 'string' && artist.name.trim() ?
        [{ name: artist.name.trim(), uri: artist.uri }] : []) : [];
    this.artist.replaceChildren();
    if (artists.length) artists.forEach((artist, index) => {
      if (index) this.artist.append(', ');
      this.artist.append(trackLink(artist.name, artist.uri, 'artist'));
    });
    else this.artist.textContent = typeof metadata.artist_name === 'string' ? metadata.artist_name.trim() : '';
    const album = isRecord(item.album) ? item.album : {};
    const albumName = typeof album.name === 'string' ? album.name.trim() : '';
    const metadataAlbum = typeof metadata.album_title === 'string' ? metadata.album_title.trim() : '';
    this.album.replaceChildren(trackLink(albumName || metadataAlbum, album.uri ?? metadata.album_uri, 'album'));
    this.album.hidden = !this.album.textContent;
    if (this.artist.textContent && this.album.textContent) this.artist.append(' — ');
    this.artist.append(this.album);
    this.artist.hidden = !this.artist.textContent;
    this.hasTitle = !!this.title.textContent;
    this.schedule();
  }

  setArtwork(image: HTMLImageElement | null) {
    if (image) {
      image.alt = '';
      this.cover.replaceChildren(image);
    } else this.cover.replaceChildren();
    this.hasArtwork = !!image;
    this.schedule();
  }

  mount() {
    if (this.mounted) return;
    this.mounted = true;
    this.nowPlayingState = 'unknown';
    this.resizeObserver.observe(this.overlay);
    this.observer.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['aria-label', 'aria-hidden', 'aria-pressed', 'hidden', 'class', 'style'] });
    this.schedule();
  }

  unmount() {
    this.mounted = false;
    this.resizeObserver.disconnect();
    this.observer.disconnect();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  private schedule() {
    if (!this.mounted) return;
    this.nowPlayingState = getNowPlayingState(this.nowPlayingState);
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      const { width, height } = this.overlay.getBoundingClientRect();
      const zoom = getWindowZoom();
      const artworkColumn = width * 0.28 * zoom;
      const lyricWidth = width * 0.75 - artworkColumn;
      // Reserve a readable lyric column and room below the square cover for metadata.
      const visible = this.hasArtwork && this.hasTitle && width >= 1120 && height >= 480 && lyricWidth >= 480 &&
        this.nowPlayingState === 'hidden';
      this.overlay.style.setProperty('--ll-window-zoom', `${zoom}`);
      this.overlay.style.setProperty('--ll-artwork-column-width', `${artworkColumn}px`);
      this.overlay.style.setProperty('--ll-view-height', `${height}px`);
      const coverSize = Math.min(artworkColumn, height * 0.45 * zoom);
      this.overlay.style.setProperty('--ll-view-width', `${width}px`);
      this.overlay.style.setProperty('--ll-cover-size', `${Math.max(0, coverSize)}px`);
      this.overlay.style.setProperty('--ll-artwork-lyric-size', `${Math.max(28, coverSize * 0.115)}px`);
      this.overlay.classList.toggle('ll-with-track', visible);
      this.element.hidden = !visible;
    });
  }
}
