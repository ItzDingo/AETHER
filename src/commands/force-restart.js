const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('force-restart')
    .setDescription('Force restart the Musico bot (restricted role only)'),

  async execute(interaction, client) {
    const djRoleId = process.env.DJ_ROLE_ID;

    if (!djRoleId) {
      return interaction.reply({ content: '❌ No DJ role configured.', ephemeral: true });
    }

    const hasRole = interaction.member?.roles?.cache?.has(djRoleId);
    if (!hasRole) {
      return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
    }

    const queue = client.queues.get(interaction.guildId);
    if (queue) {
      queue.destroy();
    }

    await interaction.reply({ content: '🔄 Musico is restarting...', ephemeral: true });

    setTimeout(() => {
      process.exit(1);
    }, 1500);
  },
};
