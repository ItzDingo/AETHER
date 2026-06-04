# 🎵 Musico — Discord Music Bot

A professional, stable Discord music bot that plays songs exclusively from YouTube Music with a full interactive control panel.

---

## Features

- `/play` — Opens a modal to search by song name or paste a YouTube Music / YouTube link
- `/force-restart` — Restarts the bot (role-restricted)
- Interactive control panel with buttons: Add, Queue, Pause, Resume, Skip, Loop, Stop, Download
- Panel updates in-place when songs change (no spam)
- Only allows YouTube Music content — regular YouTube videos are blocked
- Auto-leaves voice channel after inactivity
- Rejects play requests when occupied in another voice channel
- Ephemeral error messages (only visible to the user)
- Auto-restarts itself on crashes
- MP3 download via mp3juice.sc sent to user DMs

---

## Requirements

- Node.js 18 or higher
- FFmpeg (installed via `ffmpeg-static` package automatically)
- A Discord bot token

---

## Setup

### 1. Create your Discord Bot

1. Go to https://discord.com/developers/applications
2. Click **New Application** → name it **Musico**
3. Go to **Bot** tab → click **Add Bot**
4. Under **Token** → click **Reset Token** and copy it
5. Under **Privileged Gateway Intents**, enable:
   - **Server Members Intent**
   - **Message Content Intent**
6. Go to **OAuth2 → URL Generator**
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Connect`, `Speak`, `Send Messages`, `Embed Links`, `Read Message History`, `Use Slash Commands`
7. Copy the generated URL and invite the bot to your server

---

### 2. Configure the Bot

1. Copy `.env.example` to `.env`:
   ```
   cp .env.example .env
   ```

2. Fill in your `.env` file:

   ```env
   DISCORD_TOKEN=your_bot_token_here
   CLIENT_ID=your_bot_client_id_here
   GUILD_ID=your_discord_server_id_here
   ALLOWED_CHANNEL_IDS=channel_id_1,channel_id_2
   DJ_ROLE_ID=role_id_for_force_restart
   AUTO_LEAVE_TIMEOUT=300000
   ```

   **How to get IDs:**
   - Enable Developer Mode in Discord: `Settings → Advanced → Developer Mode`
   - Right-click your server → **Copy Server ID** → `GUILD_ID`
   - Right-click a channel → **Copy Channel ID** → add to `ALLOWED_CHANNEL_IDS`
   - Right-click a role in Server Settings → **Copy Role ID** → `DJ_ROLE_ID`
   - `CLIENT_ID` is the **Application ID** found on the Discord Developer Portal main page

---

### 3. Install Dependencies

```bash
npm install
```

---

### 4. Start the Bot

```bash
npm start
```

The bot will:
1. Register slash commands with your server
2. Log in and show as online
3. Auto-restart itself if it ever crashes

---

## How to Use

### Playing a Song

1. Join a voice channel
2. Go to an allowed text channel
3. Type `/play`
4. A popup modal appears — type a song name or paste a URL:
   - `Blinding Lights`
   - `https://music.youtube.com/watch?v=rw1x12nLhFk`
   - `https://www.youtube.com/watch?v=rw1x12nLhFk`
5. The bot searches YouTube Music, joins your voice channel, and sends the control panel

### Panel Buttons

| Button | Action |
|--------|--------|
| ➕ Add | Opens modal to add a song to the queue |
| 📋 Queue | Shows the current queue (only you can see it) |
| ⏸️ Pause | Pauses the current song |
| ▶️ Resume | Resumes the paused song |
| ⏭️ Skip | Skips to the next queued song |
| 🔁 Loop | Toggles loop on/off for current song |
| ⏹️ Stop | Stops playback and clears queue |
| ⬇️ Download | Sends an MP3 download link to your DMs |

### Force Restart

Only users with the configured `DJ_ROLE_ID` role can run `/force-restart`. This will destroy the current music session and restart the bot process.

---

## Configuration Reference

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Your bot token from Discord Developer Portal |
| `CLIENT_ID` | Your bot's Application ID |
| `GUILD_ID` | The Discord server ID the bot works in |
| `ALLOWED_CHANNEL_IDS` | Comma-separated list of text channel IDs where commands work |
| `DJ_ROLE_ID` | Role ID that can use `/force-restart` |
| `AUTO_LEAVE_TIMEOUT` | Milliseconds of inactivity before auto-leaving (default: 300000 = 5 min) |

---

## Troubleshooting

**Bot doesn't respond to `/play`:**
- Make sure you're in an allowed channel (`ALLOWED_CHANNEL_IDS`)
- Make sure the bot has `Use Slash Commands` and `Send Messages` permissions in that channel

**Bot can't join voice:**
- Make sure the bot has `Connect` and `Speak` permissions in your voice channel

**Song not found:**
- Only YouTube Music content is allowed
- Try searching with a more specific song name and artist
- Use a direct YouTube Music URL: `https://music.youtube.com/watch?v=...`

**Download not working:**
- The download feature depends on mp3juice.sc availability
- If it fails, the bot will provide a fallback message with the site link
