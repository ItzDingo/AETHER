const { initPresence } = require('../utils/presenceManager');

module.exports = {
  name: 'ready',
  once: true,
  execute(client) {
    console.log(`[Bot] Logged in as ${client.user.tag}`);
    initPresence(client);
  },
};