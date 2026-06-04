const { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song from YouTube Music'),

  async execute(interaction, client) {
    const modal = new ModalBuilder()
      .setCustomId('modal_play_song')
      .setTitle('🎵 Play a Song');

    const input = new TextInputBuilder()
      .setCustomId('song_input')
      .setLabel('Song name or YouTube Music / YouTube URL')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. Blinding Lights or https://music.youtube.com/...')
      .setRequired(true)
      .setMaxLength(300);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
  },
};
