module.exports = {
  name: 'voiceStateUpdate',
  async execute(oldState, newState, client) {
    try {
      const queue = client.queues.get(oldState.guild.id);
      if (!queue) return;

      const botChannel = queue.connection?.joinConfig?.channelId;
      if (!botChannel) return;

      const channel = oldState.guild.channels.cache.get(botChannel);
      if (!channel) return;

      const members = channel.members.filter(m => !m.user.bot);
      if (members.size === 0) {
        // Bot is alone — start 60-second alone timer
        queue.startAloneTimer();
      } else {
        // Someone is in the channel — cancel the alone timer
        queue.clearAloneTimer();
      }
    } catch {}
  },
};

