const { getDirectStreamUrl } = require('./src/utils/ytResolver');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

function getFfmpegPath() {
  if (fs.existsSync('/usr/bin/ffmpeg')) return '/usr/bin/ffmpeg';
  if (fs.existsSync('/usr/local/bin/ffmpeg')) return '/usr/local/bin/ffmpeg';
  try {
    const staticFfmpeg = require('ffmpeg-static');
    if (staticFfmpeg && fs.existsSync(staticFfmpeg)) return staticFfmpeg;
  } catch {}
  return 'ffmpeg';
}

function waitForProcessOutput(proc) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.once('error', reject);
    proc.once('close', (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || `Exit code ${code}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function run() {
  const videoId = 'xU6LmbTctFc'; // DIOR by A.L.A
  console.log('Resolving stream URL...');
  const directUrl = await getDirectStreamUrl(videoId);
  if (!directUrl) {
    console.error('Failed to resolve direct stream URL');
    return;
  }
  console.log('Resolved direct URL:', directUrl);

  const outputPath = path.join(__dirname, `test_download_${Date.now()}.mp3`);
  console.log('Output path:', outputPath);

  console.log('\n--- Testing Direct Ffmpeg Transcode ---');
  const start = Date.now();
  try {
    const args = [
      '-y',
      '-loglevel', 'error',
      '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      '-i', directUrl,
      '-vn',
      '-c:a', 'libmp3lame',
      '-q:a', '5',
      outputPath
    ];
    const proc = spawn(getFfmpegPath(), args, { windowsHide: true });
    await waitForProcessOutput(proc);
    console.log(`Ffmpeg download succeeded in ${((Date.now() - start) / 1000).toFixed(2)}s!`);
    console.log(`File size: ${fs.statSync(outputPath).size} bytes`);
  } catch (err) {
    console.error('Ffmpeg download failed:', err.message);
  } finally {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  }
}

run().catch(console.error);
