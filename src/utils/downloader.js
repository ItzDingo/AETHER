const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { getDirectStreamUrl, extractVideoId, getUserAgentForUrl } = require('./ytResolver');

function getFfmpegPath() {
  const fs = require('fs');
  if (fs.existsSync('/usr/bin/ffmpeg')) {
    return '/usr/bin/ffmpeg';
  }
  if (fs.existsSync('/usr/local/bin/ffmpeg')) {
    return '/usr/local/bin/ffmpeg';
  }
  try {
    const staticFfmpeg = require('ffmpeg-static');
    if (staticFfmpeg && fs.existsSync(staticFfmpeg)) {
      return staticFfmpeg;
    }
  } catch {}
  return 'ffmpeg';
}

function waitForProcessOutput(proc) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.once('error', reject);
    proc.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Process exited with code ${code}`));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

async function downloadMp3(songUrl, songTitle) {
  try {
    const safeTitle = songTitle.replace(/[\\/:*?\"<>|]/g, '_');
    const tempDir = path.join(__dirname, '..', '..', 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const outputPath = path.join(tempDir, `${safeTitle}-${Date.now()}.mp3`);

    let downloadUrl = null;
    const urlResult = extractVideoId(songUrl);
    if (urlResult) {
      try {
        console.log(`[downloader] Resolving direct stream URL via youtubei.js for ${urlResult.id}...`);
        downloadUrl = await getDirectStreamUrl(urlResult.id);
      } catch (err) {
        console.warn(`[downloader] youtubei.js resolution failed:`, err.message);
      }
    }

    if (!downloadUrl) {
      console.warn(`[downloader] Failed to resolve direct stream URL for download. Failing.`);
      return null;
    }

    console.log(`[downloader] Downloading and converting to MP3 from direct stream: ${songTitle}`);
    console.log(`[downloader] Output path: ${outputPath}`);

    const ffmpegArgs = [
      '-y',
      '-loglevel', 'error',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_at_eof', '1',
      '-reconnect_delay_max', '5',
      '-user_agent', getUserAgentForUrl(downloadUrl),
      '-i', downloadUrl,
      '-vn',
      '-c:a', 'libmp3lame',
      '-q:a', '5',
      outputPath
    ];

    console.log(`[downloader] Running ffmpeg directly on direct stream URL...`);
    const ffmpegProcess = spawn(getFfmpegPath(), ffmpegArgs, {
      windowsHide: true,
    });
    await waitForProcessOutput(ffmpegProcess);

    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1024) {
      console.log(`[downloader] Direct stream ffmpeg download succeeded.`);
      return outputPath;
    }

    console.warn('[downloader] ffmpeg completed but output file is missing or too small.');
    return null;
  } catch (err) {
    console.error('[downloader] Error downloading MP3:', err.message);
    return null;
  }
}

module.exports = { downloadMp3 };
