const { initOAuth, hasOAuthCredentials } = require('./src/utils/ytOAuth');

async function testClient(clientType, useOAuth) {
  console.log(`\n--- Testing ${clientType} (OAuth: ${useOAuth}) ---`);
  try {
    const { Innertube, Platform } = await import('youtubei.js');
    if (Platform && Platform.shim) {
      Platform.shim.eval = async (data) => {
        return new Function(data.output)();
      };
    }
    const yt = await Innertube.create({ client_type: clientType });
    if (useOAuth) {
      if (hasOAuthCredentials()) {
        const success = await initOAuth(yt);
        console.log(`OAuth init success: ${success}`);
      } else {
        console.log('No OAuth credentials available');
        return;
      }
    }
    const videoId = 'xU6LmbTctFc';
    console.log('Calling getBasicInfo...');
    const info = await yt.getBasicInfo(videoId);
    console.log('Success!');
    console.log('Has streaming_data:', !!info.streaming_data);
    if (info.streaming_data) {
      const formats = [
        ...(info.streaming_data.formats || []),
        ...(info.streaming_data.adaptive_formats || [])
      ];
      console.log(`Total formats: ${formats.length}`);
      const withUrl = formats.filter(f => f.url);
      console.log(`Formats with direct url: ${withUrl.length}`);
      if (withUrl.length > 0) {
        console.log(`Sample direct url: ${withUrl[0].url.substring(0, 100)}...`);
      }
    }
  } catch (err) {
    console.error(`Failed:`, err.message);
  }
}

async function run() {
  await testClient('ANDROID', false);
  await testClient('ANDROID', true);
  await testClient('TVHTML5', false);
  await testClient('TVHTML5', true);
  await testClient('WEB', false);
  await testClient('WEB', true);
}

run();
