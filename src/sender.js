require('dotenv').config();
const http = require('http');
const fs = require('fs');
const dns = require('dns');
const { Client, GatewayIntentBits, Partials, AttachmentBuilder } = require('discord.js');

if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

const PORT = process.env.PORT || process.env.SENDER_PORT || 3000;
const TOKEN = process.env.SENDER_DISCORD_TOKEN;

if (!TOKEN) {
  console.error('[Sender Process] ERROR: SENDER_DISCORD_TOKEN is not defined in .env.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
  rest: {
    timeout: 60000,
  },
});

async function loginWithRetry(retries = 5, delay = 5000) {
  for (let i = 1; i <= retries; i++) {
    try {
      console.log(`[Sender Process] Attempting Discord login (attempt ${i}/${retries})...`);
      await client.login(TOKEN);
      console.log(`[Sender Process] Logged in as ${client.user.tag}`);
      startServer();
      return;
    } catch (err) {
      console.error(`[Sender Process] Login attempt ${i} failed:`, err.message);
      if (i === retries) {
        console.error('[Sender Process] Max login retries reached. Exiting.');
        process.exit(1);
      }
      console.log(`[Sender Process] Retrying in ${delay / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

loginWithRetry();

function startServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/send') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { filePath, userId, channelId, title, author } = JSON.parse(body);

          if (!filePath || !fs.existsSync(filePath)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'File not found on disk' }));
          }

          console.log(`[Sender Process] Received request to send ${filePath} to User ${userId}`);

          const stats = fs.statSync(filePath);
          const safeTitle = title.replace(/[\\/:*?\"<>|]/g, '_');
          const attachmentName = `${safeTitle}.mp3`;

          let dmSent = false;
          let channelSent = false;
          let lastError = null;

          // Attempt 1: Send to DM
          try {
            const targetUser = await client.users.fetch(userId);
            const stream = fs.createReadStream(filePath);
            const attachment = new AttachmentBuilder(stream, { name: attachmentName });
            await targetUser.send({
              content: `🎵 **${title}** by ${author}\n⬇️ Here is your MP3 file!`,
              files: [attachment]
            });
            dmSent = true;
          } catch (err) {
            console.error(`[Sender Process] DM send failed: ${err.message}`);
            lastError = err.message;
          }

          // Attempt 2: If DM failed, send to channel
          if (!dmSent && channelId) {
            try {
              console.log(`[Sender Process] DM failed. Attempting channel send to ${channelId}...`);
              const targetChannel = await client.channels.fetch(channelId);
              const stream = fs.createReadStream(filePath);
              const attachment = new AttachmentBuilder(stream, { name: attachmentName });
              await targetChannel.send({
                content: `🎵 **${title}** by ${author}\n⬇️ Here is your MP3 file, <@${userId}>!`,
                files: [attachment]
              });
              channelSent = true;
            } catch (err) {
              console.error(`[Sender Process] Channel send failed: ${err.message}`);
              lastError = err.message;
            }
          }

          if (dmSent || channelSent) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, method: dmSent ? 'dm' : 'channel' }));
          } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: `Upload failed: ${lastError}` }));
          }

        } catch (err) {
          console.error('[Sender Process] Request handling error:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: err.message }));
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Sender Process] HTTP Server listening at http://0.0.0.0:${PORT}`);
  });
}
