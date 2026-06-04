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
        
        queue.startAloneTimer();
      } else {
        
        queue.clearAloneTimer();
      }
    } catch {}
  },
};

