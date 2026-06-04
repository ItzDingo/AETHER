const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

function buildPanel(queue) {
  const song = queue.current;

  const embed = new EmbedBuilder()
    .setColor(song ? '#1DB954' : '#2C2F33')
    .setAuthor({ name: '🎵 Musico — Now Playing' })
    .setFooter({ text: 'Musico Music Bot' });

  if (song) {
    embed
      .setTitle(song.title)
      .setURL(song.url)
      .setDescription(`**Artist:** ${song.author}\n**Released:** ${song.releaseDate}\n**Duration:** ${song.duration}`)
      .setThumbnail(song.thumbnail);
  } else {
    embed
      .setTitle('No song playing')
      .setDescription('Use `/play` to start listening to music.');
  }

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('btn_add')
      .setLabel('Add')
      .setEmoji('➕')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('btn_queue')
      .setLabel('Queue')
      .setEmoji('📋')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('btn_pause')
      .setLabel('Pause')
      .setEmoji('⏸️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!song),
    new ButtonBuilder()
      .setCustomId('btn_resume')
      .setLabel('Resume')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!song),
    new ButtonBuilder()
      .setCustomId('btn_skip')
      .setLabel('Skip')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!song),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('btn_loop')
      .setLabel(queue.loop ? 'Loop: ON' : 'Loop: OFF')
      .setEmoji('🔁')
      .setStyle(queue.loop ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('btn_reverb')
      .setLabel(queue.reverb ? 'Reverb: ON' : 'Reverb: OFF')
      .setEmoji('🔊')
      .setStyle(queue.reverb ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('btn_stop')
      .setLabel('Stop')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!song && queue.songs.length === 0),
    new ButtonBuilder()
      .setCustomId('btn_download')
      .setLabel('Download')
      .setEmoji('⬇️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!song),
  );

  return { embeds: [embed], components: [row1, row2] };
}

async function sendPanel(queue, channel) {
  try {
    const panelData = buildPanel(queue);

    if (queue.panelMessage) {
      try {
        await queue.panelMessage.edit(panelData);
        return;
      } catch {
        queue.panelMessage = null;
      }
    }

    const msg = await channel.send(panelData);
    queue.panelMessage = msg;
    queue.panelChannelId = channel.id;
  } catch {}
}

async function updatePanel(queue) {
  try {
    if (!queue.panelMessage) return;

    const panelData = buildPanel(queue);
    await queue.panelMessage.edit(panelData);
  } catch {
    queue.panelMessage = null;
  }
}

module.exports = { buildPanel, sendPanel, updatePanel };
