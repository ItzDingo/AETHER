const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
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

function getYtdlpBinary() {
  const fs = require('fs');
  if (fs.existsSync('/usr/local/bin/yt-dlp')) {
    return '/usr/local/bin/yt-dlp';
  }
  if (fs.existsSync('/usr/bin/yt-dlp')) {
    return '/usr/bin/yt-dlp';
  }

  try {
    const ytdl = require('youtube-dl-exec');
    if (
      ytdl.constants &&
      ytdl.constants.YOUTUBE_DL_PATH &&
      fs.existsSync(ytdl.constants.YOUTUBE_DL_PATH)
    ) {
      return ytdl.constants.YOUTUBE_DL_PATH;
    }
  } catch {}

  return 'yt-dlp';
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


    console.log(`[downloader] Downloading and converting to MP3: ${songUrl}`);
    console.log(`[downloader] Output path: ${outputPath}`);

    const cookiesPath = path.join(__dirname, '..', '..', 'temp', 'cookies.txt');
    const args = [
      '-f', 'bestaudio/best',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '5',
      '--ffmpeg-location', getFfmpegPath(),
      '--user-agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ];

    if (fs.existsSync(cookiesPath)) {
      console.log(`[downloader] Executing yt-dlp WITH cookies from: ${cookiesPath}`);
      args.push('--cookies', cookiesPath);
    } else {
      console.warn('[downloader] WARNING: cookies.txt not found! Executing yt-dlp WITHOUT cookies.');
    }

    args.push(
      '-o', outputPath,
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      songUrl
    );

    const ytdlp = spawn(getYtdlpBinary(), args, {
      windowsHide: true,
    });

    await waitForProcessOutput(ytdlp);

    if (fs.existsSync(outputPath)) {
      return outputPath;
    }

    return null;
  } catch (err) {
    console.error('[downloader] Error downloading MP3:', err.message);
    return null;
  }
}

module.exports = { downloadMp3 };
