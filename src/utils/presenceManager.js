const { ActivityType } = require('discord.js');

let presenceInterval = null;
let currentPresenceIndex = 0;

function setIdlePresence(client) {
  try {
    if (currentPresenceIndex === 0) {
      client.user.setPresence({
        activities: [{ name: '🎵 Music | /play', type: ActivityType.Listening }],
        status: 'online',
      });
    } else {
      client.user.setPresence({
        activities: [{ name: 'developed by Dingo', type: ActivityType.Custom, state: 'developed by Dingo' }],
        status: 'online',
      });
    }
  } catch (err) {
    console.error('[Presence] Failed to set idle presence:', err.message);
  }
}

function initPresence(client) {
  if (presenceInterval) clearInterval(presenceInterval);

  currentPresenceIndex = 0;
  setIdlePresence(client);

  presenceInterval = setInterval(() => {
    let anyPlaying = false;
    if (client.queues) {
      for (const queue of client.queues.values()) {
        if (queue.isPlaying && queue.current) {
          anyPlaying = true;
          break;
        }
      }
    }

    if (!anyPlaying) {
      currentPresenceIndex = (currentPresenceIndex + 1) % 2;
      setIdlePresence(client);
    }
  }, 15000);
}

async function updateBotPresenceAndVoiceStatus(queue, song) {
  const client = queue.client;

  // 1. Update Voice Channel Status
  if (queue.connection) {
    const channelId = queue.getVoiceChannelId();
    if (channelId) {
      try {
        const statusText = song ? `Playing: ${song.title}`.substring(0, 500) : '';
        await client.rest.put(`/channels/${channelId}/voice-status`, {
          body: { status: statusText }
        });
        if (statusText) {
          console.log(`[Presence] Set voice channel ${channelId} status: "${statusText}"`);
        } else {
          console.log(`[Presence] Cleared voice channel ${channelId} status`);
        }
      } catch (err) {
        console.error('[Presence] Failed to set voice channel status:', err.message);
      }
    }
  }

  // 2. Update Bot Presence
  if (song) {
    try {
      client.user.setPresence({
        activities: [{ name: `playing ${song.title}`, type: ActivityType.Playing }],
        status: 'online',
      });
    } catch (err) {
      console.error('[Presence] Failed to set playing presence:', err.message);
    }
  } else {
    let otherPlayingSong = null;
    if (client.queues) {
      for (const q of client.queues.values()) {
        if (q !== queue && q.isPlaying && q.current) {
          otherPlayingSong = q.current;
          break;
        }
      }
    }

    if (otherPlayingSong) {
      try {
        client.user.setPresence({
          activities: [{ name: `playing ${otherPlayingSong.title}`, type: ActivityType.Playing }],
          status: 'online',
        });
      } catch (err) {
        console.error('[Presence] Failed to set playing presence:', err.message);
      }
    } else {
      currentPresenceIndex = 0;
      setIdlePresence(client);
    }
  }
}

module.exports = {
  initPresence,
  updateBotPresenceAndVoiceStatus,
};
