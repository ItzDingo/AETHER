const { spawn } = require('child_process');
const {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  StreamType,
} = require('@discordjs/voice');
const { updatePanel } = require('../utils/panelManager');
const ffmpegPath = require('ffmpeg-static');

function getYtdlpBinary() {
  const fs = require('fs');
  if (fs.existsSync('/usr/local/bin/yt-dlp')) {
    return '/usr/local/bin/yt-dlp';
  }
  if (fs.existsSync('/usr/bin/yt-dlp')) {
    return '/usr/bin/yt-dlp';
  }

  try {
    const ytdl = require('youtube-dl-exec');
    if (
      ytdl.constants &&
      ytdl.constants.YOUTUBE_DL_PATH &&
      fs.existsSync(ytdl.constants.YOUTUBE_DL_PATH)
    ) {
      return ytdl.constants.YOUTUBE_DL_PATH;
    }
  } catch {}

  return 'yt-dlp';
}

// In-memory cache for yt-dlp direct URLs (videoId -> { url, timestamp })
const directUrlCache = new Map();
const URL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCachedUrl(videoId) {
  const entry = directUrlCache.get(videoId);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > URL_CACHE_TTL) {
    directUrlCache.delete(videoId);
    return null;
  }
  return entry.url;
}

function waitForProcessOutput(proc) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.once('error', reject);
    proc.once('close', (code) => {
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `Process exited with code ${code}`));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

class MusicQueue {
  constructor(guildId, client) {
    this.guildId = guildId;
    this.client = client;
    this.songs = [];
    this.current = null;
    this.connection = null;
    this.player = createAudioPlayer();
    this.player.on('stateChange', (oldState, newState) => {
      console.log(`[Player] ${oldState.status} -> ${newState.status}`);
    });
    this.loop = false;
    this.reverb = false;
    this.panelMessage = null;
    this.panelChannelId = null;
    this.autoLeaveTimer = null;
    this.aloneLeaveTimer = null;
    this.isPlaying = false;
    this.activeProcesses = [];
    this.resource = null;
    this.currentSeekTime = 0;
    this.isReverbToggling = false;

    this.player.on(AudioPlayerStatus.Idle, () => {
      if (this.isReverbToggling) {
        console.log('[Player] Idle state ignored because we are toggling reverb/seeking');
        return;
      }
      if (this.loop && this.current) {
        this.playSong(this.current);
      } else {
        this.advance();
      }
    });

    this.player.on('error', (err) => {
      console.error('[AudioPlayer error]', err.message);
      this.cleanupActiveProcesses();
      this.advance();
    });
  }

  cleanupActiveProcesses() {
    for (const proc of this.activeProcesses) {
      try {
        if (proc && !proc.killed) proc.kill('SIGTERM');
      } catch { }
    }
    this.activeProcesses = [];
  }

  async connect(voiceChannel) {
    const existing = getVoiceConnection(this.guildId);
    if (existing) {
      // If the existing connection is in Ready state, reuse it
      if (existing.state.status === VoiceConnectionStatus.Ready) {
        this.connection = existing;
        this.connection.subscribe(this.player);
        return;
      }
      // If it's stuck in a bad state, destroy it and recreate
      console.log(`[Voice] Existing connection in "${existing.state.status}" state, destroying and reconnecting...`);
      try { existing.destroy(); } catch { }
    }

    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(`[Voice] Connection attempt ${attempt}/${maxAttempts}...`);

      this.connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: this.guildId,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: true,
      });

      this.connection.on('error', (err) => {
        console.error('[Voice connection error]', err.message);
      });

      this.connection.on('debug', (message) => {
        console.log('[Voice debug]', message);
      });

      this.connection.on('stateChange', (oldState, newState) => {
        console.log(`[Voice] ${oldState.status} -> ${newState.status}`);
        if (newState.status === VoiceConnectionStatus.Connecting) {
          console.log('[Voice] Networking config:', JSON.stringify(newState.networking?.state?.connectionData ?? 'none'));
        }
      });

      try {
        await entersState(
          this.connection,
          VoiceConnectionStatus.Ready,
          30000
        );
        console.log('[Voice] Ready');
        break; // success
      } catch (err) {
        console.error(`[MusicQueue] Voice connection attempt ${attempt} failed:`, err.message);

        // Destroy the broken connection so it doesn't keep cycling
        try { this.connection.destroy(); } catch { }
        this.connection = null;

        if (attempt < maxAttempts) {
          console.log('[Voice] Retrying in 2 seconds...');
          await new Promise(r => setTimeout(r, 2000));
        } else {
          throw new Error('Could not establish voice connection after multiple attempts. Check the console for [Voice debug] logs.');
        }
      }
    }

    this.connection.subscribe(this.player);

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch {
        this.destroy();
      }
    });
  }

  async getDirectAudioUrl(videoUrl, videoId) {
    // Check URL cache first
    if (videoId) {
      const cached = getCachedUrl(videoId);
      if (cached) {
        console.log(`[MusicQueue] URL cache hit for ${videoId}`);
        return cached;
      }
    }

    const path = require('path');
    const fs = require('fs');
    const cookiesPath = path.join(__dirname, '..', '..', 'temp', 'cookies.txt');

    const args = [
      '-f',
      'bestaudio',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--add-header',
      'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ];

    if (fs.existsSync(cookiesPath)) {
      args.push('--cookies', cookiesPath);
    }

    args.push('-g', videoUrl);

    const ytdlp = spawn(getYtdlpBinary(), args, {
      windowsHide: true,
    });

    this.activeProcesses.push(ytdlp);

    const { stdout } = await waitForProcessOutput(ytdlp);
    const directUrl = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);

    if (!directUrl) {
      throw new Error('yt-dlp did not return a direct audio URL.');
    }

    // Cache the URL
    if (videoId) {
      directUrlCache.set(videoId, { url: directUrl, timestamp: Date.now() });
    }

    return directUrl;
  }

  _buildFfmpegArgs(directUrl, seekTimeMs = 0) {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
    ];

    if (seekTimeMs > 0) {
      const seekSeconds = (seekTimeMs / 1000).toFixed(3);
      args.push('-ss', seekSeconds);
    }

    args.push(
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      '-i', directUrl,
      '-vn', '-sn', '-dn'
    );

    // Audio filter chain: loudness normalization + optional reverb
    const filters = [];
    filters.push('loudnorm=I=-14:TP=-1:LRA=11');
    if (this.reverb) {
      filters.push('aecho=0.8:0.88:60:0.4');
    }
    args.push('-af', filters.join(','));

    args.push(
      '-ac', '2',
      '-ar', '48000',
      '-f', 's16le',
      'pipe:1',
    );

    return args;
  }

  async playSong(song, seekTime = 0) {
    let ffmpeg = null;
    let ytdlp = null;

    try {
      this.cleanupActiveProcesses();

      this.current = song;
      this.isPlaying = true;
      this.clearAutoLeaveTimer();

      if (seekTime === 0) {
        this.currentSeekTime = 0;
      } else {
        this.currentSeekTime = seekTime;
      }

      await updatePanel(this).catch(() => { });

      const videoUrl = song.videoId
        ? `https://www.youtube.com/watch?v=${song.videoId}`
        : song.url;

      console.log(`[MusicQueue] Resolving direct stream URL for: ${videoUrl}`);

      const directUrl = await this.getDirectAudioUrl(videoUrl, song.videoId);
      console.log(`[MusicQueue] Streaming via ffmpeg from direct audio URL (seekTime: ${seekTime}ms)`);

      ffmpeg = spawn(ffmpegPath, this._buildFfmpegArgs(directUrl, seekTime), {
        windowsHide: true,
      });

      this.activeProcesses.push(ffmpeg);

      ffmpeg.on('error', (err) => {
        console.error('[ffmpeg error]', err.message);
      });

      ffmpeg.stderr.on('data', (data) => {
        const text = data.toString().trim();
        if (text) console.error('[ffmpeg stderr]', text);
      });

      const resource = createAudioResource(ffmpeg.stdout, {
        inputType: StreamType.Raw,
        inlineVolume: true,
      });

      this.resource = resource;
      resource.volume?.setVolume(0.8);
      this.player.play(resource);
      this.isReverbToggling = false;

      // Update presence and voice channel status AFTER playback has started,
      // with a delay to avoid the REST call's CHANNEL_UPDATE gateway event
      // disrupting the freshly established audio pipe.
      setTimeout(() => {
        const { updateBotPresenceAndVoiceStatus } = require('./presenceManager');
        updateBotPresenceAndVoiceStatus(this, song).catch(() => { });
      }, 3000);

    } catch (err) {
      console.error('[playSong error]', err);
      if (err.message) console.error('[playSong error message]', err.message);
      if (err.stack) console.error('[playSong error stack]', err.stack);

      this.isReverbToggling = false;
      this.cleanupActiveProcesses();
      this.isPlaying = false;
      this.current = null;
      await updatePanel(this).catch(() => { });
      this.advance();
    }
  }

  async advance() {
    this.isPlaying = false;
    this.current = null;

    const { updateBotPresenceAndVoiceStatus } = require('./presenceManager');
    updateBotPresenceAndVoiceStatus(this, null).catch(() => { });

    if (this.songs.length > 0) {
      const next = this.songs.shift();
      await this.playSong(next);
    } else {
      await updatePanel(this).catch(() => { });
      this.startAutoLeaveTimer();
    }
  }

  addToQueue(song) {
    this.songs.push(song);
  }

  skip() {
    this.loop = false;
    this.cleanupActiveProcesses();
    this.player.stop(true);
  }

  stop() {
    this.songs = [];
    this.loop = false;
    this.cleanupActiveProcesses();
    this.player.stop(true);
    this.isPlaying = false;
    this.current = null;

    const { updateBotPresenceAndVoiceStatus } = require('./presenceManager');
    updateBotPresenceAndVoiceStatus(this, null).catch(() => { });

    this.startAutoLeaveTimer();
  }

  pause() {
    this.player.pause();
  }

  resume() {
    this.player.unpause();
  }

  toggleLoop() {
    this.loop = !this.loop;
    return this.loop;
  }

  toggleReverb() {
    this.reverb = !this.reverb;
    // If currently playing, restart the ffmpeg process with/without reverb from the current timestamp
    if (this.isPlaying && this.current) {
      this.isReverbToggling = true;
      const elapsed = this.resource ? this.resource.playbackDuration : 0;
      const newSeekTime = (this.currentSeekTime || 0) + elapsed;
      console.log(`[MusicQueue] Toggling reverb. Cumulative seek: ${this.currentSeekTime}ms, elapsed: ${elapsed}ms. Total: ${newSeekTime}ms`);
      this.playSong(this.current, newSeekTime);
    }
    return this.reverb;
  }

  // --- Auto-leave timer (idle, no music playing) ---
  startAutoLeaveTimer() {
    this.clearAutoLeaveTimer();
    const timeout = parseInt(process.env.AUTO_LEAVE_TIMEOUT) || 300000;
    this.autoLeaveTimer = setTimeout(() => {
      this.destroy();
    }, timeout);
  }

  clearAutoLeaveTimer() {
    if (this.autoLeaveTimer) {
      clearTimeout(this.autoLeaveTimer);
      this.autoLeaveTimer = null;
    }
  }

  // --- Alone timer (bot is only member in voice channel, 60s) ---
  startAloneTimer() {
    this.clearAloneTimer();
    console.log('[MusicQueue] Bot is alone in voice channel. Leaving in 60 seconds...');
    this.aloneLeaveTimer = setTimeout(() => {
      console.log('[MusicQueue] Alone timer expired. Leaving voice channel.');
      this.destroy();
    }, 60000);
  }

  clearAloneTimer() {
    if (this.aloneLeaveTimer) {
      clearTimeout(this.aloneLeaveTimer);
      this.aloneLeaveTimer = null;
    }
  }

  destroy() {
    this.clearAutoLeaveTimer();
    this.clearAloneTimer();
    this.cleanupActiveProcesses();
    this.player.stop(true);

    const { updateBotPresenceAndVoiceStatus } = require('./presenceManager');
    updateBotPresenceAndVoiceStatus(this, null).catch(() => { });

    if (this.connection) {
      try {
        this.connection.destroy();
      } catch { }
    }
    this.client.queues.delete(this.guildId);
  }

  getVoiceChannelId() {
    return this.connection?.joinConfig?.channelId || null;
  }
}

module.exports = MusicQueue;
