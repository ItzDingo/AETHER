const play = require('play-dl');

async function setupPlayDl() {
  try {
    await play.setToken({
      useragent: [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      ],
    });
  } catch {}
}

module.exports = { setupPlayDl };
