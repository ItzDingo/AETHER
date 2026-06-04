const { spawn } = require('child_process');
const path = require('path');
require('dotenv').config();

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

// Start both
startSender();
startBot();
