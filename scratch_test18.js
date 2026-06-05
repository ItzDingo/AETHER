const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Define helpers exactly as in ytResolver.js
function getYtdlpBinary() {
  if (fs.existsSync('/usr/local/bin/yt-dlp')) return '/usr/local/bin/yt-dlp';
  if (fs.existsSync('/usr/bin/yt-dlp')) return '/usr/bin/yt-dlp';
  try {
    const ytdl = require('youtube-dl-exec');
    if (ytdl.constants && ytdl.constants.YOUTUBE_DL_PATH && fs.existsSync(ytdl.constants.YOUTUBE_DL_PATH)) {
      return ytdl.constants.YOUTUBE_DL_PATH;
    }
  } catch {}
  return 'yt-dlp';
}

function waitForProcessOutput(proc) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    proc.once('error', reject);
    proc.once('close', (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || `Exit code ${code}`));
      else resolve({ stdout, stderr });
    });
  });
}

function formatDuration(seconds) {
  if (!seconds || Number.isNaN(seconds)) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatReleaseDate(dateStr) {
  if (!dateStr) return 'Unknown';
  const cleaned = String(dateStr).trim();
  if (/^\d{8}$/.test(cleaned)) {
    const y = cleaned.slice(0, 4);
    const m = cleaned.slice(4, 6);
    const d = cleaned.slice(6, 8);
    return `${y},${m},${d}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
    return cleaned.replace(/-/g, ',');
  }
  return cleaned;
}

function withTimeout(promise, ms, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

async function resolveWithYtdlp(videoId) {
  try {
    console.log(`[ytResolver] Trying yt-dlp metadata fallback for ${videoId}...`);
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const binary = getYtdlpBinary();

    const args = [
      '--dump-json',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
    ];

    const localCookiesPath = path.join(__dirname, 'temp', 'cookies.txt');
    if (fs.existsSync(localCookiesPath)) {
      args.push('--cookies', localCookiesPath);
    }

    args.push(url);

    const proc = spawn(binary, args, { windowsHide: true });
    const { stdout } = await withTimeout(waitForProcessOutput(proc), 12000, 'yt-dlp metadata process');
    
    const meta = JSON.parse(stdout);
    if (meta && meta.title) {
      let parsedReleaseDate = 'Unknown';
      const rawDate = meta.release_date || meta.upload_date;
      if (rawDate && rawDate.length === 8) {
        parsedReleaseDate = `${rawDate.substring(0, 4)},${rawDate.substring(4, 6)},${rawDate.substring(6, 8)}`;
      }

      const song = {
        title: meta.title,
        author: meta.uploader || meta.artist || 'Unknown Artist',
        duration: formatDuration(meta.duration || 0),
        durationSec: meta.duration || 0,
        thumbnail: meta.thumbnail || null,
        url: url,
        videoId: videoId,
        releaseDate: formatReleaseDate(parsedReleaseDate),
      };
      console.log('Successfully resolved metadata via yt-dlp:');
      console.log(song);
      return song;
    }
  } catch (err) {
    console.error('Failed:', err.message);
  }
  return null;
}

resolveWithYtdlp('xU6LmbTctFc');
