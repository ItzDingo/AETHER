const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const ffmpegPath = require('ffmpeg-static');

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
    const ffmpegDir = path.dirname(ffmpegPath);

    console.log(`[downloader] Downloading and converting to MP3: ${songUrl}`);
    console.log(`[downloader] Output path: ${outputPath}`);

    const cookiesPath = path.join(__dirname, '..', '..', 'temp', 'cookies.txt');
    const args = [
      '-f', 'bestaudio/best',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '5',
      '--ffmpeg-location', ffmpegDir,
    ];

    if (fs.existsSync(cookiesPath)) {
      args.push('--cookies', cookiesPath);
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
