const { resolveSong, buildSongDataFromInnertube } = require('./src/utils/ytResolver');

async function run() {
  try {
    const query = 'a.l.a dior';
    console.log(`Resolving song for query: "${query}"...`);
    const song = await resolveSong(query);
    console.log('Final resolved song metadata:', song);
  } catch (err) {
    console.error('Failed:', err);
  }
}

run();
