const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
} = require('discord.js');
const { updatePanel } = require('../utils/panelManager');
const { downloadMp3 } = require('../utils/downloader');

const downloadCooldowns = new Map();

async function handleButton(interaction, client) {
  const queue = client.queues.get(interaction.guildId);
  console.log(`[Interaction] Button "${interaction.customId}" clicked by ${interaction.user.tag} (Guild ID: ${interaction.guildId}). Active queue exists in memory: ${!!queue}`);

  if (interaction.customId === 'btn_add') {
    const modal = new ModalBuilder()
      .setCustomId('modal_add_song')
      .setTitle('➕ Add a Song to Queue');

    const input = new TextInputBuilder()
      .setCustomId('song_input')
      .setLabel('Song name or YouTube Music / YouTube URL')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. Blinding Lights or https://music.youtube.com/...')
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  if (interaction.customId === 'btn_queue') {
    if (!queue || queue.songs.length === 0) {
      return interaction.reply({ content: '📋 The queue is empty.', ephemeral: true });
    }

    const list = queue.songs
      .slice(0, 20)
      .map((s, i) => `**${i + 1}.** ${s.title} — ${s.author} (${s.duration})`)
      .join('\n');

    const embed = new EmbedBuilder()
      .setColor('#1DB954')
      .setTitle('📋 Queue')
      .setDescription(list)
      .setFooter({ text: `${queue.songs.length} song(s) in queue` });

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (interaction.customId === 'btn_pause') {
    if (!queue || !queue.current) {
      return interaction.reply({ content: '❌ Nothing is playing.', ephemeral: true });
    }
    queue.pause();
    return interaction.reply({ content: '⏸️ Paused.', ephemeral: true });
  }

  if (interaction.customId === 'btn_resume') {
    if (!queue || !queue.current) {
      return interaction.reply({ content: '❌ Nothing is playing.', ephemeral: true });
    }
    queue.resume();
    return interaction.reply({ content: '▶️ Resumed.', ephemeral: true });
  }

  if (interaction.customId === 'btn_skip') {
    if (!queue || !queue.current) {
      return interaction.reply({ content: '❌ Nothing is playing.', ephemeral: true });
    }
    queue.skip();
    return interaction.reply({ content: '⏭️ Skipped.', ephemeral: true });
  }

  if (interaction.customId === 'btn_stop') {
    if (!queue) {
      return interaction.reply({ content: '❌ Nothing is playing.', ephemeral: true });
    }
    queue.stop();
    await updatePanel(queue);
    return interaction.reply({ content: '⏹️ Stopped and queue cleared.', ephemeral: true });
  }

  if (interaction.customId === 'btn_loop') {
    if (!queue) {
      return interaction.reply({ content: '❌ No active session.', ephemeral: true });
    }
    const looping = queue.toggleLoop();
    await updatePanel(queue);
    return interaction.reply({ content: `🔁 Loop is now **${looping ? 'ON' : 'OFF'}**.`, ephemeral: true });
  }

  if (interaction.customId === 'btn_reverb') {
    if (!queue) {
      return interaction.reply({ content: '❌ No active session.', ephemeral: true });
    }
    const reverbOn = queue.toggleReverb();
    await updatePanel(queue);
    return interaction.reply({ content: `🔊 Reverb is now **${reverbOn ? 'ON' : 'OFF'}**.`, ephemeral: true });
  }

  if (interaction.customId === 'btn_download') {
    if (!queue || !queue.current) {
      return interaction.reply({ content: '❌ Nothing is playing.', ephemeral: true });
    }

    const song = queue.current;

    
    if (song.durationSec > 480) {
      return interaction.reply({
        content: `⚠️ The current song is longer than 8 minutes (${song.duration || '0:00'}). Downloading this song is restricted.`,
        ephemeral: true
      });
    }

    const userId = interaction.user.id;
    const cooldownTime = 30000;
    const now = Date.now();
    if (downloadCooldowns.has(userId)) {
      const expirationTime = downloadCooldowns.get(userId) + cooldownTime;
      if (now < expirationTime) {
        const timeLeft = Math.ceil((expirationTime - now) / 1000);
        return interaction.reply({
          content: `⏳ Please wait **${timeLeft}s** before using the download button again.`,
          ephemeral: true
        });
      }
    }

    downloadCooldowns.set(userId, now);

    await interaction.reply({ content: '⬇️ Downloading and converting to MP3, please wait...', ephemeral: true });

    let filePath = null;
    const fs = require('fs');
    const webConverter = song.url
      .replace('music.youtube.com', 'youtubepp.com')
      .replace('youtube.com', 'youtubepp.com');

    try {
      filePath = await downloadMp3(song.url, song.title);

      if (!filePath || !fs.existsSync(filePath)) {
        return interaction.editReply({
          content: `❌ Could not download the song automatically. You can convert it manually here:\n💿 **Web Converter**: ${webConverter}`
        });
      }

      const stats = fs.statSync(filePath);
      const fileSizeMb = stats.size / (1024 * 1024);
      console.log(`[btn_download] File ready: ${filePath} (${fileSizeMb.toFixed(2)} MB)`);

      if (fileSizeMb > 25) {
        return interaction.editReply({
          content: `⚠️ The song is too large (${fileSizeMb.toFixed(1)}MB) to send via Discord (max 25MB). You can download it manually here:\n💿 **Web Converter**: ${webConverter}`
        });
      }

      const safeTitle = song.title.replace(/[\\/:*?\"<>|]/g, '_');
      const attachmentName = `${safeTitle}.mp3`;

      await interaction.editReply({ content: '⬆️ Uploading MP3 to Discord...' });

      const port = process.env.PORT || process.env.SENDER_PORT || 3000;
      let sentSuccessfully = false;
      let sendMethod = '';

      if (process.env.SENDER_DISCORD_TOKEN) {
        console.log(`[btn_download] Requesting independent Sender Bot (port ${port}) to send the file...`);
        await interaction.editReply({ content: '⬆️ Decoupling upload: Requesting Sender Bot to deliver MP3...' });

        try {
          const response = await fetch(`http://127.0.0.1:${port}/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              filePath: filePath,
              userId: interaction.user.id,
              channelId: interaction.channel?.id,
              title: song.title,
              author: song.author,
            }),
          });

          const result = await response.json();
          if (response.ok && result.success) {
            sentSuccessfully = true;
            sendMethod = result.method; // 'dm' or 'channel'
          } else {
            console.warn(`[btn_download] Sender Bot failed to upload: ${result.error || 'Unknown error'}`);
          }
        } catch (err) {
          console.error(`[btn_download] Failed to reach Sender Bot process: ${err.message}. Falling back to main bot...`);
        }
      }

      if (sentSuccessfully) {
        const methodLabel = sendMethod === 'dm' ? 'your DMs' : 'this channel';
        return interaction.editReply({ content: `📨 MP3 file sent to ${methodLabel}!` });
      }

      // FALLBACK: If Sender Bot is not configured or failed to upload, the Music Bot tries itself:
      console.log('[btn_download] Running fallback: Music Bot uploading file directly...');
      // Helper: attempt to send a file with retries and delays
      const { AttachmentBuilder } = require('discord.js');
      const maxRetries = 3;

      async function trySendFile(sendFn, label) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            const stream = fs.createReadStream(filePath);
            const attachment = new AttachmentBuilder(stream, { name: attachmentName });
            await sendFn(attachment);
            return true;
          } catch (err) {
            console.error(`[btn_download] ${label} attempt ${attempt}/${maxRetries} failed: ${err.message}`);
            if (attempt < maxRetries) {
              await new Promise(r => setTimeout(r, 2000 * attempt));
            }
          }
        }
        return false;
      }

      // Try 1: Send to DMs
      const dmSent = await trySendFile(async (attachment) => {
        await interaction.user.send({
          content: `🎵 **${song.title}** by ${song.author}\n⬇️ Here is your MP3 file!`,
          files: [attachment]
        });
      }, 'DM send');

      if (dmSent) {
        return interaction.editReply({ content: '📨 MP3 file sent to your DMs!' });
      }

      // Try 2: Send directly in the text channel
      const channelSent = await trySendFile(async (attachment) => {
        await interaction.channel.send({
          content: `🎵 **${song.title}** by ${song.author}\n⬇️ Here is your MP3 file, <@${interaction.user.id}>!`,
          files: [attachment]
        });
      }, 'Channel send');

      if (channelSent) {
        return interaction.editReply({ content: '📨 MP3 file sent in this channel!' });
      }

      // All attempts failed — give web converter link
      return interaction.editReply({
        content: `❌ Discord keeps dropping the file upload. This usually happens on slow connections.\n\n💿 You can download it manually here: ${webConverter}`
      });

    } catch (err) {
      console.error('[btn_download] error:', err.message);
      await interaction.editReply({ content: `❌ An error occurred while generating the MP3 download.\n\n💿 Try manually: ${webConverter}` });
    } finally {
      if (filePath && fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (e) {
          console.error('[btn_download] Failed to delete temp file:', e.message);
        }
      }
    }
  }
}

module.exports = { handleButton };