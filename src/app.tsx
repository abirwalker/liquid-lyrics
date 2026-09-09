import { fetchLyrics } from './lyrics/chain';
import { createLyricsController, initPlayerListener } from './player/listener';

async function main() {
  while (!Spicetify?.showNotification || !Spicetify?.Player) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  Spicetify.showNotification('Liquid Lyrics loaded!');

  const controller = createLyricsController(fetchLyrics);
  initPlayerListener(controller, Spicetify);
}

main();
