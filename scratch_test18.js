const ytSearch = require('yt-search');

async function run() {
  const videoId = 'kCtNCtr4q58';
  console.log('Running ytSearch for videoId...');
  try {
    const result = await ytSearch({ videoId });
    console.log('Result keys:', Object.keys(result));
    console.log('Title:', result.title);
  } catch (err) {
    console.error('yt-search failed:', err.message);
  }
}

run().catch(console.error);
