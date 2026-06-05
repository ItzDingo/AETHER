const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { getDirectStreamUrl, extractVideoId } = require('./ytResolver');

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

    let downloadUrl = songUrl;
    let usingDirectUrl = false;

    const urlResult = extractVideoId(songUrl);
    if (urlResult) {
      try {
        console.log(`[downloader] Resolving direct stream URL via youtubei.js for ${urlResult.id}...`);
        const directUrl = await getDirectStreamUrl(urlResult.id);
        if (directUrl) {
          downloadUrl = directUrl;
          usingDirectUrl = true;
          console.log(`[downloader] Successfully resolved stream URL via youtubei.js`);
        } else {
          console.log(`[downloader] youtubei.js returned no stream URL, falling back to YouTube URL.`);
        }
      } catch (err) {
        console.warn(`[downloader] youtubei.js resolution failed:`, err.message);
      }
    }

    console.log(`[downloader] Downloading and converting to MP3: ${usingDirectUrl ? '(direct stream URL)' : songUrl}`);
    console.log(`[downloader] Output path: ${outputPath}`);

    if (usingDirectUrl) {
      const ffmpegArgs = [
        '-y',
        '-loglevel', 'error',
        '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
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
    } else {
      const args = [
        '-f', 'bestaudio/best',
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', '5',
        '--ffmpeg-location', getFfmpegPath(),
        '--user-agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      ];

      const cookiesPath = path.join(__dirname, '..', '..', 'temp', 'cookies.txt');
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
        downloadUrl
      );

      const ytdlp = spawn(getYtdlpBinary(), args, {
        windowsHide: true,
      });

      await waitForProcessOutput(ytdlp);
    }

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
