import './fullscreen.css';

const SYMBOLS = {
  previous: {
    viewBox: '0 0 28.605 14.921',
    path: '<path d="M26.525 13.56V1.348c0-.915-.53-1.348-1.162-1.348-.276 0-.572.08-.854.238L14.255 6.21c-.742.433-1.018.75-1.018 1.244s.276.81 1.018 1.244L24.51 14.67c.282.157.578.238.854.238.633 0 1.162-.433 1.162-1.348m-13.238 0V1.348C13.287.433 12.758 0 12.123 0c-.273 0-.57.08-.852.238L1.018 6.21C.286 6.643 0 6.96 0 7.454s.286.81 1.018 1.244L11.27 14.67c.282.157.579.238.852.238.635 0 1.164-.433 1.164-1.348"/>',
  },
  next: {
    viewBox: '0 0 28.584 14.921',
    path: '<path d="M2.07 13.56c0 .915.529 1.348 1.162 1.348.275 0 .572-.08.852-.238l10.253-5.972c.732-.433 1.02-.75 1.02-1.244s-.288-.81-1.02-1.244L4.084.238A1.76 1.76 0 0 0 3.232 0C2.599 0 2.07.433 2.07 1.348Zm13.237 0c0 .915.53 1.348 1.162 1.348.276 0 .562-.08.842-.238l10.253-5.972c.742-.433 1.02-.75 1.02-1.244s-.278-.81-1.02-1.244L17.311.238A1.7 1.7 0 0 0 16.469 0c-.633 0-1.162.433-1.162 1.348Z"/>',
  },
  play: {
    viewBox: '0 0 16.659 16.407',
    path: '<path d="M2.08 14.974c0 .965.554 1.421 1.222 1.421.288 0 .6-.091.892-.25L15.57 9.5c.808-.477 1.088-.786 1.088-1.303s-.28-.825-1.088-1.302L4.194.251A1.9 1.9 0 0 0 3.302 0C2.634 0 2.08.456 2.08 1.42Z"/>',
  },
  pause: {
    viewBox: '0 0 11.912 16.158',
    path: '<path d="M1.305 16.146h2.22c.848 0 1.294-.446 1.294-1.305V1.305C4.819.405 4.373 0 3.524 0h-2.22C.447 0 0 .446 0 1.305V14.84c0 .859.446 1.305 1.305 1.305m7.093 0h2.22c.848 0 1.294-.446 1.294-1.305V1.305c0-.9-.446-1.305-1.294-1.305h-2.22C7.54 0 7.093.446 7.093 1.305V14.84c0 .859.446 1.305 1.305 1.305"/>',
  },
  exit: {
    viewBox: '0 0 15.492 15.501',
    path: '<path d="M14.001.27.258 14.013a.89.89 0 0 0 0 1.237.896.896 0 0 0 1.245 0L15.236 1.516c.336-.338.346-.91 0-1.245-.348-.328-.899-.338-1.235 0m1.235 13.742L1.503.271C1.165-.057.593-.067.258.27a.91.91 0 0 0 0 1.245L14 15.249c.326.336.898.336 1.235 0 .336-.348.336-.91 0-1.237"/>',
  },
  shuffle: {
    viewBox: '0 0 22.444 17.726',
    path: '<path d="M17.374.64v6.18c0 .396.235.622.635.622.174 0 .36-.067.495-.185l3.7-3.057c.313-.25.313-.645 0-.928L18.505.205a.82.82 0 0 0-.496-.174c-.4 0-.635.216-.635.61M0 13.872c0 .494.367.817.9.817h2.228c1.619 0 2.549-.46 3.726-1.823l5.917-6.907c.841-.975 1.543-1.332 2.62-1.332h3.427a.82.82 0 0 0 .816-.817.82.82 0 0 0-.816-.817h-3.484c-1.621 0-2.561.461-3.736 1.823l-5.909 6.908c-.852.974-1.523 1.342-2.517 1.342H.9c-.529 0-.9.33-.9.806m17.374 3.245c0 .394.235.61.635.61.174 0 .36-.066.495-.185l3.699-3.055c.313-.283.313-.677 0-.928L18.505 10.5a.77.77 0 0 0-.496-.185c-.4 0-.635.216-.635.612ZM0 3.886c0 .477.371.806.9.806h2.272c.994 0 1.665.358 2.517 1.342l5.909 6.908c1.175 1.362 2.115 1.823 3.736 1.823h3.484a.82.82 0 0 0 .816-.817.82.82 0 0 0-.816-.817h-3.426c-1.078 0-1.78-.357-2.621-1.342L6.854 4.892C5.677 3.528 4.747 3.069 3.128 3.069H.9c-.533 0-.9.323-.9.817"/>',
  },
  repeat: {
    viewBox: '0 0 20.8383 17.3782',
    path: '<path d="M8.65655 16.7686L8.65655 10.5792C8.65655 10.1853 8.42019 9.96966 8.01993 9.96966C7.84568 9.96966 7.66127 10.036 7.51596 10.1543L3.82602 13.2121C3.52293 13.4632 3.50223 13.8681 3.82602 14.1378L7.51596 17.1957C7.66127 17.314 7.84568 17.3782 8.01993 17.3782C8.42019 17.3782 8.65655 17.1647 8.65655 16.7686ZM20.0112 8.34934C19.5427 8.34934 19.1944 8.70799 19.1944 9.18071L19.1944 10.1087C19.1944 11.7818 18.0292 12.8744 16.2668 12.8744L7.21319 12.8744C6.76328 12.8744 6.39428 13.2434 6.39428 13.6808C6.39428 14.1307 6.76328 14.4976 7.21319 14.4976L16.1136 14.4976C19.0181 14.4976 20.8383 12.8536 20.8383 10.2226L20.8383 9.18071C20.8383 8.70799 20.4818 8.34934 20.0112 8.34934Z"/><path d="M12.1839 0.624156L12.1839 6.81353C12.1839 7.20746 12.4099 7.42311 12.8081 7.42311C12.9927 7.42311 13.1688 7.35679 13.3141 7.23851L17.002 4.191C17.3154 3.92952 17.3361 3.52464 17.002 3.25492L13.3141 0.197064C13.1688 0.0787857 12.9927 0.0145711 12.8081 0.0145711C12.4099 0.0145711 12.1839 0.228117 12.1839 0.624156ZM0.82715 9.04344C1.28529 9.04344 1.64395 8.68478 1.64395 8.21207L1.64395 7.28403C1.64395 5.61095 2.7988 4.51841 4.56121 4.51841L13.6273 4.51841C14.0751 4.51841 14.4337 4.1494 14.4337 3.71196C14.4337 3.26205 14.0751 2.89516 13.6273 2.89516L4.72682 2.89516C1.82021 2.89516 0 4.5392 0 7.17017L0 8.21207C0 8.68478 0.358656 9.04344 0.82715 9.04344Z"/>',
  },
  repeat1: {
    viewBox: '0 0 20.884 17.918',
    path: '<path d="M10.0866 0.894076L10.0866 7.08345C10.0866 7.47738 10.323 7.69303 10.7211 7.69303C10.8954 7.69303 11.0819 7.62671 11.2272 7.50843L14.9172 4.46092C15.2285 4.19944 15.2388 3.79456 14.9172 3.52484L11.2272 0.466985C11.0819 0.348706 10.8954 0.284491 10.7211 0.284491C10.323 0.284491 10.0866 0.498037 10.0866 0.894076ZM0.82715 9.31336C1.28529 9.31336 1.64395 8.9547 1.64395 8.48199L1.64395 7.55395C1.64395 5.88087 2.7988 4.78833 4.56121 4.78833L11.53 4.78833C11.9778 4.78833 12.3468 4.41932 12.3468 3.98188C12.3468 3.53197 11.9778 3.16508 11.53 3.16508L4.72682 3.16508C1.82021 3.16508 3.55271e-15 4.80912 3.55271e-15 7.44009L3.55271e-15 8.48199C3.55271e-15 8.9547 0.358656 9.31336 0.82715 9.31336ZM8.65655 17.0385L8.65655 10.8492C8.65655 10.4552 8.42019 10.2396 8.01993 10.2396C7.84568 10.2396 7.66127 10.3059 7.51596 10.4242L3.82602 13.482C3.52293 13.7332 3.50223 14.138 3.82602 14.4078L7.51596 17.4656C7.66127 17.5839 7.84568 17.6481 8.01993 17.6481C8.42019 17.6481 8.65655 17.4346 8.65655 17.0385ZM20.0112 8.61926C19.5427 8.61926 19.1944 8.97791 19.1944 9.45063L19.1944 10.3787C19.1944 12.0517 18.0292 13.1443 16.2668 13.1443L7.21319 13.1443C6.76328 13.1443 6.39428 13.5133 6.39428 13.9507C6.39428 14.4006 6.76328 14.7675 7.21319 14.7675L16.1136 14.7675C19.0181 14.7675 20.8383 13.1235 20.8383 10.4925L20.8383 9.45063C20.8383 8.97791 20.4818 8.61926 20.0112 8.61926Z"/><path d="M20.0215 6.51005C20.5564 6.51005 20.884 6.18033 20.884 5.63727L20.884 1.08421C20.884 0.431111 20.463 0 19.8266 0C19.3169 0 19.0079 0.161592 18.612 0.478644L17.3073 1.47552C17.0937 1.64133 17.0356 1.78855 17.0356 1.98964C17.0356 2.28197 17.2678 2.49973 17.6078 2.49973C17.7365 2.49973 17.8712 2.45411 18.0081 2.35251L19.0449 1.53009L19.1488 1.53009L19.1488 5.63727C19.1488 6.18033 19.4785 6.51005 20.0215 6.51005Z"/>',
  },
  speakerLow: {
    viewBox: '0 0 17.3528 17.2299',
    path: '<path d="M15.1015 12.7722C15.4331 12.9918 15.8889 12.9255 16.1521 12.5464C16.8998 11.5558 17.3528 10.1065 17.3528 8.60871C17.3528 7.11088 16.8998 5.67194 16.1521 4.67105C15.8889 4.29189 15.4331 4.22557 15.1015 4.45559C14.7119 4.72913 14.6456 5.20778 14.9502 5.61397C15.5221 6.38966 15.8338 7.47165 15.8338 8.60871C15.8338 9.74576 15.5118 10.8174 14.9502 11.6034C14.656 12.02 14.7119 12.4883 15.1015 12.7722Z"/><path d="M10.5281 17.2299C11.1628 17.2299 11.6271 16.7673 11.6271 16.1286L11.6271 1.16128C11.6271 0.532909 11.1628 0.00824052 10.5074 0.00824052C10.0512 0.00824052 9.7337 0.207415 9.23838 0.679929L5.07542 4.58583C5.01714 4.64411 4.93393 4.68149 4.84017 4.68149L2.0437 4.68149C0.720424 4.68149 1.33227e-15 5.40192 1.33227e-15 6.81835L1.33227e-15 10.4512C1.33227e-15 11.8552 0.720424 12.586 2.0437 12.586L4.84017 12.586C4.93393 12.586 5.01714 12.6151 5.07542 12.6734L9.23838 16.6182C9.6923 17.041 10.0719 17.2299 10.5281 17.2299Z"/>',
  },
  speakerHigh: {
    viewBox: '0 0 21.7911 17.2299',
    path: '<path d="M18.7319 15.3123C19.0946 15.5527 19.5401 15.4781 19.8033 15.0968C21.0515 13.3859 21.7911 11.016 21.7911 8.60871C21.7911 6.20143 21.0618 3.81084 19.8033 2.12058C19.5401 1.73931 19.0946 1.66474 18.7319 1.90512C18.3713 2.14761 18.3071 2.60344 18.5931 3.00963C19.6675 4.51589 20.2721 6.53095 20.2721 8.60871C20.2721 10.6865 19.6468 12.6912 18.5931 14.2078C18.3175 14.614 18.3713 15.0698 18.7319 15.3123Z"/><path d="M15.1118 12.7722C15.4434 12.9918 15.8993 12.9255 16.1625 12.5464C16.9101 11.5558 17.3631 10.1065 17.3631 8.60871C17.3631 7.11088 16.9101 5.67194 16.1625 4.67105C15.8993 4.29189 15.4434 4.22557 15.1118 4.45559C14.7223 4.72913 14.656 5.20778 14.9606 5.61397C15.5325 6.38966 15.8442 7.47165 15.8442 8.60871C15.8442 9.74576 15.5221 10.8174 14.9606 11.6034C14.6663 12.02 14.7223 12.4883 15.1118 12.7722Z"/><path d="M10.5281 17.2299C11.1628 17.2299 11.6271 16.7673 11.6271 16.1286L11.6271 1.16128C11.6271 0.532909 11.1628 0.00824052 10.5074 0.00824052C10.0512 0.00824052 9.74405 0.207415 9.23838 0.679929L5.07542 4.58583C5.01714 4.64411 4.93393 4.68149 4.84017 4.68149L2.0437 4.68149C0.720424 4.68149 1.33227e-15 5.40192 1.33227e-15 6.81835L1.33227e-15 10.4512C1.33227e-15 11.8552 0.720424 12.586 2.0437 12.586L4.84017 12.586C4.93393 12.586 5.01714 12.6151 5.07542 12.6734L9.23838 16.6182C9.6923 17.041 10.0719 17.2299 10.5281 17.2299Z"/>',
  },
  speakerMute: {
    viewBox: '0 0 20.9264 22.002',
    path: '<path d="M15.0942 18.8493C14.9643 19.3088 14.5645 19.6159 14.0406 19.6159C13.5822 19.6159 13.2048 19.4271 12.7509 19.0043L8.59826 15.0595C8.53997 15.0012 8.44642 14.972 8.35266 14.972L5.55619 14.972C4.23291 14.972 3.51249 14.2413 3.51249 12.8373L3.51249 9.20443C3.51249 8.56167 3.66083 8.06224 3.94805 7.71001ZM15.1396 3.54736L15.1396 13.534L8.5851 6.9836C8.5899 6.97998 8.59417 6.97599 8.59826 6.9719L12.7509 3.06601C13.2565 2.59349 13.5636 2.39432 14.0199 2.39432C14.6835 2.39432 15.1396 2.91899 15.1396 3.54736Z"/><path d="M18.5106 20.6399C18.8049 20.9341 19.2878 20.9341 19.5716 20.6399C19.8598 20.3414 19.868 19.8731 19.5716 19.5767L2.84543 2.86089C2.5533 2.57911 2.07044 2.56454 1.77408 2.86089C1.48808 3.14689 1.48808 3.64834 1.77408 3.93434Z"/>',
  },
};

function makeIcon(name: keyof typeof SYMBOLS): string {
  const sym = SYMBOLS[name];
  return `<svg viewBox="${sym.viewBox}" aria-hidden="true" fill="currentColor">${sym.path}</svg>`;
}

function time(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export class FullscreenControls {
  readonly element = document.createElement('div');
  readonly exitButton: HTMLButtonElement;
  readonly volume = document.createElement('div');
  private readonly volumeRange = document.createElement('input');
  private readonly muteBtn: HTMLButtonElement;
  private readonly play: HTMLButtonElement;
  private readonly shuffle: HTMLButtonElement;
  private readonly repeat: HTMLButtonElement;
  private readonly seek = document.createElement('input');
  private readonly elapsed = document.createElement('span');
  private readonly remaining = document.createElement('span');
  private playing: boolean | null = null;
  private dragging = false;
  private muted: boolean | null = null;
  private repeatMode: number | null = null;
  private lastAudibleVolume = .5;

  constructor(exit: () => void) {
    this.element.className = 'll-fullscreen-controls';
    const button = (name: string, icon: keyof typeof SYMBOLS, click: () => void) => {
      const node = document.createElement('button');
      node.type = 'button';
      node.setAttribute('aria-label', name);
      node.innerHTML = makeIcon(icon);
      node.addEventListener('click', click);
      return node;
    };

    this.exitButton = button('Exit full screen', 'exit', exit);
    this.exitButton.className = 'll-fullscreen-exit';

    const transport = document.createElement('div');
    transport.className = 'll-fullscreen-transport';
    const player = globalThis.Spicetify?.Player;
    const previous = button('Previous track', 'previous', () => globalThis.Spicetify?.Player.back?.());
    previous.className = 'll-fullscreen-prev';
    const next = button('Next track', 'next', () => globalThis.Spicetify?.Player.next?.());
    next.className = 'll-fullscreen-next';
    previous.hidden = !player?.back;
    next.hidden = !player?.next;
    this.play = button('Play', 'play', () => globalThis.Spicetify?.Player.togglePlay?.());
    this.play.className = 'll-fullscreen-play';
    this.play.hidden = !player?.togglePlay;
    this.shuffle = button('Shuffle', 'shuffle', () => globalThis.Spicetify?.Player.toggleShuffle?.());
    this.repeat = button('Repeat', 'repeat', () => globalThis.Spicetify?.Player.toggleRepeat?.());
    this.shuffle.hidden = !player?.toggleShuffle;
    this.repeat.hidden = !player?.toggleRepeat;
    this.shuffle.className = 'll-fullscreen-secondary ll-fullscreen-shuffle';
    this.repeat.className = 'll-fullscreen-secondary ll-fullscreen-repeat';
    transport.append(this.shuffle, previous, this.play, next, this.repeat);

    const timeline = document.createElement('div');
    timeline.className = 'll-fullscreen-timeline';
    this.seek.type = 'range';
    this.seek.min = '0';
    this.seek.step = '1000';
    this.seek.setAttribute('aria-label', 'Playback position');
    this.seek.addEventListener('input', () => {
      this.dragging = true;
      this.elapsed.textContent = time(Number(this.seek.value));
    });
    this.seek.addEventListener('change', () => {
      globalThis.Spicetify?.Player.seek(Number(this.seek.value));
      this.dragging = false;
    });
    this.seek.addEventListener('blur', () => { this.dragging = false; });

    timeline.append(this.seek, this.elapsed, this.remaining);
    this.element.append(timeline, transport);

    this.volume.className = 'll-fullscreen-volume ll-fullscreen-top-right-capsule';
    this.muteBtn = document.createElement('button');
    this.muteBtn.type = 'button';
    this.muteBtn.className = 'll-fullscreen-mute-btn';
    this.muteBtn.setAttribute('aria-label', 'Mute');
    this.muteBtn.innerHTML = makeIcon('speakerLow');
    this.muteBtn.addEventListener('click', () => {
      const player = globalThis.Spicetify?.Player;
      const volume = player?.getVolume?.();
      if (typeof volume !== 'number' || !Number.isFinite(volume)) return;
      if (volume > 0) this.lastAudibleVolume = volume;
      player?.setVolume?.(volume > 0 ? 0 : this.lastAudibleVolume);
      this.update();
    });

    const speakerMax = document.createElement('span');
    speakerMax.className = 'll-fullscreen-speaker-icon';
    speakerMax.setAttribute('aria-hidden', 'true');
    speakerMax.innerHTML = makeIcon('speakerHigh');

    this.volumeRange.type = 'range';
    this.volumeRange.min = '0';
    this.volumeRange.max = '1';
    this.volumeRange.step = '.01';
    this.volumeRange.setAttribute('aria-label', 'Volume');
    this.volumeRange.addEventListener('input', () => {
      const val = Number(this.volumeRange.value);
      this.volumeRange.style.setProperty('--ll-volume', `${val * 100}%`);
      globalThis.Spicetify?.Player.setVolume?.(val);
    });
    this.volume.append(this.muteBtn, this.volumeRange, speakerMax);
    this.volume.hidden = !player?.setVolume || !player?.getVolume;

  }

  update() {
    const player = globalThis.Spicetify?.Player;
    const duration = player?.getDuration() ?? 0;
    const progress = player?.getProgress() ?? 0;
    const volume = player?.getVolume?.();
    if (typeof volume === 'number' && Number.isFinite(volume)) {
      if (volume > 0) this.lastAudibleVolume = Math.min(1, volume);
      if (document.activeElement !== this.volumeRange) {
        this.volumeRange.value = String(volume);
        this.volumeRange.style.setProperty('--ll-volume', `${volume * 100}%`);
      }
      const muted = volume <= 0;
      if (muted !== this.muted) {
        this.muted = muted;
        this.muteBtn.innerHTML = makeIcon(muted ? 'speakerMute' : 'speakerLow');
        this.muteBtn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
        this.muteBtn.setAttribute('aria-pressed', String(muted));
      }
    }
    this.shuffle.setAttribute('aria-pressed', String(player?.getShuffle?.() ?? false));
    const repeat = player?.getRepeat?.() ?? 0;
    this.repeat.setAttribute('aria-pressed', String(repeat > 0));
    this.repeat.setAttribute('aria-label', repeat === 2 ? 'Repeat one' : 'Repeat');
    if (repeat !== this.repeatMode) {
      this.repeatMode = repeat;
      this.repeat.innerHTML = makeIcon(repeat === 2 ? 'repeat1' : 'repeat');
    }
    this.seek.max = String(Number.isFinite(duration) ? Math.max(0, duration) : 0);
    this.seek.disabled = !Number.isFinite(duration) || duration <= 0;
    if (!this.dragging) {
      this.seek.value = String(Number.isFinite(progress) ? Math.max(0, progress) : 0);
      this.elapsed.textContent = time(Number(this.seek.value));
    }
    this.remaining.textContent = `−${time(Math.max(0, Number(this.seek.max) - Number(this.seek.value)))}`;
    this.seek.style.setProperty('--ll-progress', `${Number(this.seek.max) > 0 ? Number(this.seek.value) / Number(this.seek.max) * 100 : 0}%`);
    this.seek.setAttribute('aria-valuetext', `${this.elapsed.textContent} of ${time(Number(this.seek.max))}`);
    const playing = player?.isPlaying() ?? false;
    if (playing !== this.playing) {
      this.playing = playing;
      this.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      this.play.innerHTML = makeIcon(playing ? 'pause' : 'play');
    }
  }
}
