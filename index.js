const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
require('dotenv').config();


// --- OAuth2 Credentials (preferred, persistent) ---
if (process.env.YOUTUBE_OAUTH_CREDENTIALS) {
  try {
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const oauthPath = path.join(tempDir, 'oauth_credentials.json');
    let oauthContent = process.env.YOUTUBE_OAUTH_CREDENTIALS.trim();

    // Check if it's base64 encoded (JSON starts with '{', base64 won't)
    if (!oauthContent.startsWith('{')) {
      oauthContent = Buffer.from(oauthContent, 'base64').toString('utf-8');
    }

    // Validate it's valid JSON with expected fields
    const parsed = JSON.parse(oauthContent);
    if (parsed.access_token) {
      fs.writeFileSync(oauthPath, JSON.stringify(parsed, null, 2), 'utf-8');
      console.log('[Runner] Successfully loaded YouTube OAuth2 credentials.');
    } else {
      console.warn('[Runner] YOUTUBE_OAUTH_CREDENTIALS is present but missing access_token.');
    }
  } catch (err) {
    console.error('[Runner] Error loading YouTube OAuth2 credentials:', err.message);
  }
} else {
  console.log('[Runner] YOUTUBE_OAUTH_CREDENTIALS not set. OAuth2 not configured.');
  console.log('[Runner] Run "node setup_oauth.js" to set up persistent authentication.');
}

// --- Legacy Cookie Loading (fallback) ---
if (process.env.YOUTUBE_COOKIES) {
  try {
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const cookiesPath = path.join(tempDir, 'cookies.txt');
    let cookiesContent = process.env.YOUTUBE_COOKIES.trim();

    const cleanContent = cookiesContent.replace(/\s+/g, '');
    const isBase64 = !cookiesContent.startsWith('#') && /^[A-Za-z0-9+/=]+$/.test(cleanContent);

    if (isBase64) {
      cookiesContent = Buffer.from(cleanContent, 'base64').toString('utf-8');
    }

    fs.writeFileSync(cookiesPath, cookiesContent, 'utf-8');
    console.log('[Runner] YouTube cookies loaded (legacy fallback).');
  } catch (err) {
    console.error('[Runner] Error writing YouTube cookies file:', err.message);
  }
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
