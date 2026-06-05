async function run() {
  const { Innertube } = await import('youtubei.js');
  const yt = await Innertube.create({ client_type: 'WEB' });
  const videoId = 'kCtNCtr4q58'; // The ID that failed
  
  console.log('Calling getBasicInfo for kCtNCtr4q58...');
  try {
    const info = await yt.getBasicInfo(videoId);
    console.log('Success! basic_info exists:', !!info.basic_info);
    if (info.basic_info) {
      console.log('Title:', info.basic_info.title);
      console.log('Category:', info.basic_info.category);
    } else {
      console.log('No basic_info, keys of info:', Object.keys(info));
    }
  } catch (err) {
    console.error('getBasicInfo failed:', err.message);
  }
}

run().catch(console.error);
