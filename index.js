const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
require('dotenv').config();


if (process.env.YOUTUBE_COOKIES) {
  try {
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const cookiesPath = path.join(tempDir, 'cookies.txt');
    let cookiesContent = process.env.YOUTUBE_COOKIES.trim();
    
    // Check if YOUTUBE_COOKIES looks like a Base64 string
    // A base64 string shouldn't start with '#' and should only contain base64 characters
    const cleanContent = cookiesContent.replace(/\s+/g, '');
    const isBase64 = !cookiesContent.startsWith('#') && /^[A-Za-z0-9+/=]+$/.test(cleanContent);
    
    if (isBase64) {
      console.log('[Runner] YOUTUBE_COOKIES environment variable detected as Base64 encoded. Decoding...');
      cookiesContent = Buffer.from(cleanContent, 'base64').toString('utf-8');
    } else {
      console.log('[Runner] YOUTUBE_COOKIES environment variable detected as raw Netscape text format.');
    }
    
    fs.writeFileSync(cookiesPath, cookiesContent, 'utf-8');
    const firstLine = cookiesContent.split('\n')[0] || '';
    console.log(`[Runner] Successfully loaded YouTube cookies. File starts with: "${firstLine.substring(0, 100)}"`);
  } catch (err) {
    console.error('[Runner] Error writing YouTube cookies file:', err.message);
  }
} else {
  console.log('[Runner] WARNING: YOUTUBE_COOKIES environment variable is not defined!');
}

let restartCount = 0;
const MAX_RESTARTS = 10;
const RESTART_DELAY = 3000;

let botProcess = null;
let senderProcess = null;

function startBot() {
  botProcess = spawn(process.execPath, [path.join(__dirname, 'src', 'bot.js')], {
    stdio: 'inherit',
    env: process.env,
  });

  botProcess.on('exit', (code, signal) => {
    if (signal === 'SIGTERM' || signal === 'SIGINT') {
      if (senderProcess) senderProcess.kill();
      process.exit(0);
    }

    if (restartCount >= MAX_RESTARTS) {
      process.exit(1);
    }

    restartCount++;
    setTimeout(() => {
      restartCount = Math.max(0, restartCount - 1);
      startBot();
    }, RESTART_DELAY * restartCount);
  });

  botProcess.on('error', () => {
    setTimeout(startBot, RESTART_DELAY);
  });
}

function startSender() {
  if (!process.env.SENDER_DISCORD_TOKEN) {
    console.log('[Runner] SENDER_DISCORD_TOKEN not configured. Sender Bot process will not start.');
    return;
  }

  senderProcess = spawn(process.execPath, [path.join(__dirname, 'src', 'sender.js')], {
    stdio: 'inherit',
    env: process.env,
  });

  senderProcess.on('exit', (code, signal) => {
    if (signal === 'SIGTERM' || signal === 'SIGINT') {
      return;
    }
    console.log('[Runner] Sender Bot process exited. Restarting in 5s...');
    setTimeout(startSender, 5000);
  });

  senderProcess.on('error', (err) => {
    console.error('[Runner] Sender process error:', err.message);
    setTimeout(startSender, 5000);
  });
}


startSender();
startBot();
