const { resolveSong } = require('../utils/ytResolver');
const { sendPanel } = require('../utils/panelManager');
const MusicQueue = require('../utils/MusicQueue');

async function handleModal(interaction, client) {
  if (interaction.customId === 'modal_play_song') {
    await handlePlayModal(interaction, client);
  } else if (interaction.customId === 'modal_add_song') {
    await handleAddModal(interaction, client);
  }
}

async function handlePlayModal(interaction, client) {
  await interaction.deferReply({ ephemeral: true });

  const input = interaction.fields.getTextInputValue('song_input')?.trim();
  if (!input) return interaction.editReply({ content: '❌ No input provided.' });

  const member = interaction.member;
  const voiceChannel = member?.voice?.channel;

  if (!voiceChannel) {
    return interaction.editReply({ content: '❌ You must be in a voice channel to play music.' });
  }

  let queue = client.queues.get(interaction.guildId);

  if (queue) {
    const currentChannelId = queue.getVoiceChannelId();
    if (currentChannelId && currentChannelId !== voiceChannel.id) {
      return interaction.editReply({ content: '❌ Musico is currently occupied in another voice channel.' });
    }
  }

  await interaction.editReply({ content: '🔍 Searching for your song...' });

  const song = await resolveSong(input);
  if (!song) {
    return interaction.editReply({ content: '❌ Could not find a matching song on YouTube Music. Try a YouTube Music link or a different song name.' });
  }

  if (!queue) {
    queue = new MusicQueue(interaction.guildId, client);
    client.queues.set(interaction.guildId, queue);
  }

  try {
    await queue.connect(voiceChannel);
  } catch (err) {
    console.error('[handlePlayModal] connect error:', err.message);
    client.queues.delete(interaction.guildId);
    return interaction.editReply({ content: `❌ Failed to join voice channel: ${err.message}` });
  }

  const channel = interaction.channel;

  if (queue.isPlaying || queue.current) {
    queue.addToQueue(song);
    await sendPanel(queue, channel);
    return interaction.editReply({ content: `✅ Added **${song.title}** by ${song.author} to the queue.` });
  }

  await queue.playSong(song);
  await sendPanel(queue, channel);

  return interaction.editReply({ content: `▶️ Now playing **${song.title}** by ${song.author}` });
}

async function handleAddModal(interaction, client) {
  await interaction.deferReply({ ephemeral: true });

  const input = interaction.fields.getTextInputValue('song_input')?.trim();
  if (!input) return interaction.editReply({ content: '❌ No input provided.' });

  const member = interaction.member;
  const voiceChannel = member?.voice?.channel;

  if (!voiceChannel) {
    return interaction.editReply({ content: '❌ You must be in a voice channel to add songs.' });
  }

  const song = await resolveSong(input);
  if (!song) {
    return interaction.editReply({ content: '❌ Could not find a matching song on YouTube Music.' });
  }

  let queue = client.queues.get(interaction.guildId);
  if (!queue) {
    queue = new MusicQueue(interaction.guildId, client);
    client.queues.set(interaction.guildId, queue);
  }

  const currentChannelId = queue.getVoiceChannelId();
  if (currentChannelId && currentChannelId !== voiceChannel.id) {
    return interaction.editReply({ content: '❌ Musico is currently occupied in another voice channel.' });
  }

  try {
    await queue.connect(voiceChannel);
  } catch (err) {
    console.error('[handleAddModal] connect error:', err.message);
    client.queues.delete(interaction.guildId);
    return interaction.editReply({ content: `❌ Failed to join voice channel: ${err.message}` });
  }

  const channel = interaction.channel;

  if (queue.isPlaying || queue.current) {
    queue.addToQueue(song);
    await sendPanel(queue, channel);
    return interaction.editReply({ content: `✅ Added **${song.title}** by ${song.author} to the queue.` });
  }

  await queue.playSong(song);
  await sendPanel(queue, channel);

  return interaction.editReply({ content: `▶️ Now playing **${song.title}** by ${song.author}` });
}

module.exports = { handleModal };