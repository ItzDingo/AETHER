require('dotenv').config();
const dns = require('dns');
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}
const { Client, GatewayIntentBits, Collection, Partials } = require('discord.js');
const { loadCommands } = require('./handlers/commandHandler');
const { loadEvents } = require('./handlers/eventHandler');

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err?.message || err);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
  rest: {
    timeout: 60000,
  },
});

client.commands = new Collection();
client.queues = new Map();

loadCommands(client);
loadEvents(client);

// Warm up YouTube Innertube clients in the background to speed up first search/playback
try {
  const { getAndroidInnertube, getInnertube } = require('./utils/ytResolver');
  console.log('[Bot] Warming up YouTube API clients...');
  getInnertube().catch(err => console.warn('[Bot] Failed to pre-warm WEB Innertube client:', err?.message || err));
  getAndroidInnertube().catch(err => console.warn('[Bot] Failed to pre-warm ANDROID Innertube client:', err?.message || err));
} catch (err) {
  console.warn('[Bot] Failed to pre-warm Innertube clients:', err?.message || err);
}

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('[login error]', err.message);
  setTimeout(() => process.exit(1), 2000);
});