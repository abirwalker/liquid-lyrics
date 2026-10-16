const HEART_OUTLINE = '<path d="M13.764 2.727a4.057 4.057 0 00-5.488-.253.558.558 0 01-.31.112.531.531 0 01-.311-.112 4.054 4.054 0 00-5.487.253A4.05 4.05 0 00.974 5.61c0 1.089.424 2.113 1.168 2.855l4.462 5.223a1.791 1.791 0 002.726 0l4.435-5.195A4.052 4.052 0 0014.96 5.61a4.057 4.057 0 00-1.196-2.883zm-.722 5.098L8.58 13.048c-.307.36-.921.36-1.228 0L2.864 7.797a3.072 3.072 0 01-.905-2.187c0-.826.321-1.603.905-2.187a3.091 3.091 0 012.191-.913 3.05 3.05 0 011.957.709c.041.036.408.351.954.351.531 0 .906-.31.94-.34a3.075 3.075 0 014.161.192 3.1 3.1 0 01-.025 4.403z"/>';
const HEART_FILLED = '<path d="M13.797 2.727a4.057 4.057 0 00-5.488-.253.558.558 0 01-.31.112.531.531 0 01-.311-.112 4.054 4.054 0 00-5.487.253c-.77.77-1.194 1.794-1.194 2.883s.424 2.113 1.168 2.855l4.462 5.223a1.791 1.791 0 002.726 0l4.435-5.195a4.052 4.052 0 001.195-2.883 4.057 4.057 0 00-1.196-2.883z"/>';
const ICON_OPEN_TRACK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" d="M15 7V1H9v1h4.29L7.11 8.18l.71.71L14 2.71V7h1zM1 15h12V9h-1v5H2V4h5V3H1v12z" clip-rule="evenodd"/></svg>';
const ICON_ARTIST = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.692 9.133a.202.202 0 01-.1-.143.202.202 0 01.046-.169l.925-1.084a4.035 4.035 0 00.967-2.619v-.353a4.044 4.044 0 00-1.274-2.94A4.011 4.011 0 007.233.744C5.124.881 3.472 2.7 3.472 4.886v.232c0 .96.343 1.89.966 2.618l.925 1.085a.203.203 0 01.047.169.202.202 0 01-.1.143l-2.268 1.304a4.04 4.04 0 00-2.041 3.505V15h1v-1.058c0-1.088.588-2.098 1.537-2.637L5.808 10a1.205 1.205 0 00.316-1.828l-.926-1.085a3.028 3.028 0 01-.726-1.969v-.232c0-1.66 1.241-3.041 2.826-3.144a2.987 2.987 0 012.274.812c.618.579.958 1.364.958 2.21v.354c0 .722-.258 1.421-.728 1.969l-.925 1.085A1.205 1.205 0 009.194 10l.341.196c.284-.248.6-.459.954-.605l-.797-.458zM13 6.334v4.665a2.156 2.156 0 00-1.176-.351c-1.2 0-2.176.976-2.176 2.176S10.625 15 11.824 15 14 14.024 14 12.824V8.065l1.076.622.5-.866L13 6.334zM11.824 14a1.177 1.177 0 01-1.176-1.176A1.177 1.177 0 1111.824 14z"/></svg>';
const ICON_ALBUM = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7.5 0a7.5 7.5 0 100 15 7.5 7.5 0 000-15zm0 14.012C3.909 14.012.988 11.091.988 7.5S3.909.988 7.5.988s6.512 2.921 6.512 6.512-2.921 6.512-6.512 6.512zM7.5 5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zm0 4.012c-.834 0-1.512-.678-1.512-1.512S6.666 5.988 7.5 5.988s1.512.679 1.512 1.512S8.334 9.012 7.5 9.012z"/></svg>';
const ICON_LINK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8.492 6.619a.522.522 0 00.058.737c.45.385.723.921.77 1.511.046.59-.14 1.163-.524 1.613l-2.372 2.777c-.385.45-.921.724-1.512.77a2.21 2.21 0 01-1.613-.524 2.22 2.22 0 01-.246-3.125l1.482-1.735a.522.522 0 10-.795-.679L2.259 9.7a3.266 3.266 0 00.362 4.599 3.237 3.237 0 002.374.771 3.234 3.234 0 002.224-1.134l2.372-2.777c.566-.663.84-1.505.771-2.375A3.238 3.238 0 009.228 6.56a.523.523 0 00-.736.059zm4.887-4.918A3.233 3.233 0 0011.004.93 3.234 3.234 0 008.78 2.064L6.409 4.84a3.241 3.241 0 00-.772 2.374 3.238 3.238 0 001.134 2.224.519.519 0 00.738-.058.522.522 0 00-.058-.737 2.198 2.198 0 01-.771-1.511 2.208 2.208 0 01.524-1.613l2.372-2.777c.385-.45.921-.724 1.512-.77a2.206 2.206 0 011.613.524 2.22 2.22 0 01.246 3.125l-1.482 1.735a.522.522 0 10.795.679L13.741 6.3a3.266 3.266 0 00-.362-4.599z"/></svg>';

export class TrackActions {
  readonly element = document.createElement('div');
  private like = document.createElement('button');
  private more = document.createElement('button');
  private menu = document.createElement('div');
  readonly feedback = document.createElement('div');
  private feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  private copyRequest = 0;
  private events = new AbortController();
  private uri: string | undefined;

  constructor() {
    this.element.className = 'll-track-actions';
    this.like.type = this.more.type = 'button';
    this.like.className = 'll-track-like';
    const icons = globalThis.Spicetify?.SVGIcons;
    this.like.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><g class="ll-heart-outline">${icons?.heart ?? HEART_OUTLINE}</g><g class="ll-heart-fill">${icons?.['heart-active'] ?? HEART_FILLED}</g></svg>`;
    this.like.addEventListener('click', () => {
      globalThis.Spicetify?.Player.toggleHeart?.();
      this.update();
    });
    this.more.setAttribute('aria-label', 'More track actions');
    this.more.setAttribute('aria-haspopup', 'menu');
    this.more.setAttribute('aria-expanded', 'false');
    this.more.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${icons?.more ?? '<path d="M2 6.5a1.5 1.5 0 10-.001 2.999A1.5 1.5 0 002 6.5zm6 0a1.5 1.5 0 100 3 1.5 1.5 0 000-3zm6 0a1.5 1.5 0 10-.001 2.999A1.5 1.5 0 0014 6.5z"/>'}</svg>`;
    this.more.addEventListener('click', () => this.menu.hidden ? this.open() : this.close());
    this.menu.className = 'll-track-menu';
    this.menu.setAttribute('role', 'menu');
    this.menu.setAttribute('aria-label', 'Track actions');
    this.menu.hidden = true;
    this.feedback.className = 'll-track-feedback';
    this.feedback.setAttribute('role', 'status');
    this.feedback.setAttribute('aria-live', 'polite');
    this.feedback.setAttribute('aria-atomic', 'true');
    this.feedback.hidden = true;
    this.element.append(this.like, this.more, this.menu);
    this.element.addEventListener('keydown', event => {
      if (this.menu.hidden) return;
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
        }
        this.close();
        return;
      }
      const items = [...this.menu.querySelectorAll<HTMLButtonElement>('button')];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      let next = index;
      if (event.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % items.length;
      else if (event.key === 'ArrowUp') next = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = items.length - 1;
      else return;
      event.preventDefault();
      items[next]?.focus();
    });
    document.addEventListener('pointerdown', event => {
      if (!this.menu.hidden && event.target instanceof Node && !this.element.contains(event.target)) this.close(false);
    }, { signal: this.events.signal });
    this.update();
  }

  update() {
    const player = globalThis.Spicetify?.Player;
    const uri = player?.data?.item?.uri;
    if (uri !== this.uri) {
      this.close(false);
      this.uri = uri;
    }
    const track = typeof uri === 'string' && /^spotify:track:[A-Za-z0-9]{22}$/.test(uri);
    this.like.hidden = !track || !player?.getHeart || !player.toggleHeart;
    this.more.hidden = !track;
    const liked = player?.getHeart?.() ?? false;
    this.like.setAttribute('aria-pressed', String(liked));
    this.like.setAttribute('aria-label', liked ? 'Remove from Liked Songs' : 'Save to Liked Songs');
  }

  dispose() {
    this.events.abort();
    clearTimeout(this.feedbackTimer);
    this.feedback.remove();
    this.element.remove();
  }

  private showFeedback(message: string, request: number) {
    if (this.events.signal.aborted || request !== this.copyRequest) return;
    clearTimeout(this.feedbackTimer);
    this.feedback.textContent = message;
    this.feedback.hidden = false;
    this.feedbackTimer = setTimeout(() => { this.feedback.hidden = true; }, 2500);
  }

  private close(restoreFocus = true) {
    const wasOpen = !this.menu.hidden;
    this.menu.hidden = true;
    this.more.setAttribute('aria-expanded', 'false');
    if (wasOpen && restoreFocus) this.more.focus();
  }

  private open() {
    const api = globalThis.Spicetify;
    const item = api?.Player.data?.item;
    const uri = item?.uri;
    if (!uri || !/^spotify:track:[A-Za-z0-9]{22}$/.test(uri)) return;
    this.menu.replaceChildren();
    const action = (label: string, iconSvg: string, run: () => void, isDividerBefore = false, isLiked = false) => {
      if (isDividerBefore) {
        const divider = document.createElement('div');
        divider.className = 'll-track-menu-divider';
        divider.setAttribute('role', 'separator');
        divider.setAttribute('aria-hidden', 'true');
        this.menu.append(divider);
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      if (isLiked) button.classList.add('ll-menu-liked');

      const labelSpan = document.createElement('span');
      labelSpan.className = 'll-menu-label';
      labelSpan.textContent = label;

      const iconSpan = document.createElement('span');
      iconSpan.className = 'll-menu-icon';
      iconSpan.innerHTML = iconSvg;

      button.append(labelSpan, iconSpan);
      button.addEventListener('click', () => { this.close(); run(); });
      this.menu.append(button);
    };
    const liked = api?.Player.getHeart?.() ?? false;
    //green heart hehe
    if (api?.Player.getHeart && api.Player.toggleHeart) {
      const heartIcon = liked
        ? `<svg viewBox="0 0 16 16" aria-hidden="true">${api?.SVGIcons?.['heart-active'] ?? HEART_FILLED}</svg>`
        : `<svg viewBox="0 0 16 16" aria-hidden="true">${api?.SVGIcons?.heart ?? HEART_OUTLINE}</svg>`;
      action(liked ? 'Remove from Liked Songs' : 'Save to Liked Songs', heartIcon, () => {
        api.Player.toggleHeart?.();
        this.update();
      }, false, liked);
    }
    const navigate = (label: string, iconSvg: string, target: string | undefined) => {
      const match = target && /^spotify:(track|artist|album):([A-Za-z0-9]{22})$/.exec(target);
      if (match && api?.Platform?.History) action(label, iconSvg, () => api.Platform?.History?.push(`/${match[1]}/${match[2]}`));
    };
    const spotifyIcon = (name: string, fallback: string) => {
      const glyph = api?.SVGIcons?.[name];
      return glyph ? `<svg viewBox="0 0 16 16" aria-hidden="true">${glyph}</svg>` : fallback;
    };
    navigate('Go to song', spotifyIcon('external-link', ICON_OPEN_TRACK), uri);
    navigate('Go to artist', spotifyIcon('artist', ICON_ARTIST), item?.artists?.[0]?.uri ?? item?.metadata?.artist_uri);
    navigate('Go to album', spotifyIcon('album', ICON_ALBUM), item?.album?.uri ?? item?.metadata?.album_uri);
    if (navigator.clipboard?.writeText) action('Copy Song Link', spotifyIcon('copy', ICON_LINK), () => {
      const request = ++this.copyRequest;
      void navigator.clipboard.writeText(`https://open.spotify.com/track/${uri.split(':')[2]}`)
        .then(() => this.showFeedback('Song link copied', request))
        .catch(() => this.showFeedback('Could not copy song link', request));
    }, true);
    this.menu.hidden = false;
    this.menu.style.setProperty('--ll-menu-shift', '0px');
    const bounds = this.menu.getBoundingClientRect();
    const shift = Math.max(8 - bounds.left, Math.min(0, innerWidth - 8 - bounds.right));
    this.menu.style.setProperty('--ll-menu-shift', `${shift}px`);
    this.more.setAttribute('aria-expanded', 'true');
    this.menu.querySelector('button')?.focus();
  }
}
