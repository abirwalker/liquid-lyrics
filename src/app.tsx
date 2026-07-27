async function main() {
  while (!Spicetify?.showNotification) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  Spicetify.showNotification("Liquid Lyrics loaded!");
}

main();
