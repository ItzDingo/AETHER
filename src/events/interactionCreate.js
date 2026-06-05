const { handleButton } = require('../handlers/buttonHandler');

module.exports = {
  name: 'interactionCreate',
  async execute(interaction, client) {
    try {
      if (interaction.isChatInputCommand()) {
        const command = client.commands.get(interaction.commandName);
        if (!command) return;

        await command.execute(interaction, client);
      } else if (interaction.isButton()) {
        await handleButton(interaction, client);
      } else if (interaction.isModalSubmit()) {
        const { handleModal } = require('../handlers/modalHandler');
        await handleModal(interaction, client);
      }
    } catch {}
  },
};