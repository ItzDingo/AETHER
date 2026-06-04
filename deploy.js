require('dotenv').config();
const { REST, Routes } = require('discord.js');

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Clearing ALL global commands...');
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [] });
    console.log('Global commands cleared.');

    console.log('Clearing ALL guild commands...');
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: [] });
    console.log('Guild commands cleared.');

    console.log('Registering /play and /force-restart...');
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), {
      body: [
        {
          name: 'play',
          description: 'Play a song from YouTube Music',
        },
        {
          name: 'force-restart',
          description: 'Force restart the Musico bot (restricted role only)',
        },
      ],
    });

    console.log('Done! Commands registered. Restart the bot now.');
  } catch (err) {
    console.error('Error:', err.message);
  }
})();
