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
const { getDirectStreamUrl, getUserAgentForUrl } = require('./ytResolver');


function getFfmpegPath() {
  const fs = require('fs');
  if (fs.existsSync('/usr/bin/ffmpeg')) {
    return '/usr/bin/ffmpeg';
  }
  if (fs.existsSync('/usr/local/bin/ffmpeg')) {
    return '/usr/local/bin/ffmpeg';
  }
  try {
    const staticFfmpeg = require('ffmpeg-static');
    if (staticFfmpeg && fs.existsSync(staticFfmpeg)) {
      return staticFfmpeg;
    }
  } catch {}
  return 'ffmpeg';
}


const directUrlCache = new Map();
const URL_CACHE_TTL = 5 * 60 * 1000; 

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
      
      if (existing.state.status === VoiceConnectionStatus.Ready) {
        this.connection = existing;
        this.connection.subscribe(this.player);
        return;
      }
      
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
        break; 
      } catch (err) {
        console.error(`[MusicQueue] Voice connection attempt ${attempt} failed:`, err.message);

        
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
    if (videoId) {
      const cached = getCachedUrl(videoId);
      if (cached) {
        console.log(`[MusicQueue] URL cache hit for ${videoId}`);
        return cached;
      }
    }

    if (videoId) {
      try {
        console.log(`[MusicQueue] Resolving direct stream URL via youtubei.js for ${videoId}...`);
        const directUrl = await getDirectStreamUrl(videoId);
        if (directUrl) {
          console.log(`[MusicQueue] Successfully resolved stream URL via youtubei.js`);
          directUrlCache.set(videoId, { url: directUrl, timestamp: Date.now() });
          return directUrl;
        }
      } catch (err) {
        console.warn(`[MusicQueue] youtubei.js resolution failed for ${videoId}:`, err.message);
      }
    }

    throw new Error('Failed to resolve audio URL via youtubei.js (no yt-dlp fallback configured)');
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
      '-reconnect_at_eof', '1',
      '-reconnect_delay_max', '5',
      '-user_agent', getUserAgentForUrl(directUrl),
      '-i', directUrl,
      '-vn', '-sn', '-dn'
    );

    
    const filters = [];
    if (this.reverb) {
      filters.push('aecho=0.8:0.88:60:0.4');
    }
    if (filters.length > 0) {
      args.push('-af', filters.join(','));
    }

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

      ffmpeg = spawn(getFfmpegPath(), this._buildFfmpegArgs(directUrl, seekTime), {
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

      // Create a PassThrough stream with a 2MB buffer to cache audio frames and prevent stuttering
      const { PassThrough } = require('stream');
      const bufferStream = new PassThrough({ highWaterMark: 1024 * 1024 * 2 });
      ffmpeg.stdout.pipe(bufferStream);

      // Pre-buffer: wait for the PassThrough internal buffer to fill before starting playback.
      // We check readableLength (bytes buffered but not yet consumed) to avoid consuming data.
      const PRE_BUFFER_BYTES = 256 * 1024; // 256KB ≈ ~1.3s of 48kHz 16-bit stereo audio
      const PRE_BUFFER_TIMEOUT = 4000; // max 4 seconds to wait
      
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          console.log(`[MusicQueue] Pre-buffer timeout (${bufferStream.readableLength} bytes buffered). Starting playback.`);
          resolve();
        }, PRE_BUFFER_TIMEOUT);
        
        const checkBuffer = () => {
          if (bufferStream.readableLength >= PRE_BUFFER_BYTES) {
            clearTimeout(timer);
            bufferStream.removeListener('readable', checkBuffer);
            console.log(`[MusicQueue] Pre-buffer filled (${bufferStream.readableLength} bytes). Starting playback.`);
            resolve();
          }
        };
        
        // 'readable' fires when data is available in the internal buffer without consuming it
        bufferStream.on('readable', checkBuffer);
        
        // Also resolve if the stream ends before reaching the target
        bufferStream.once('end', () => {
          clearTimeout(timer);
          resolve();
        });
        ffmpeg.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        
        // Initial check in case buffer already has data
        checkBuffer();
      });

      const resource = createAudioResource(bufferStream, {
        inputType: StreamType.Raw,
        inlineVolume: true,
      });

      this.resource = resource;
      resource.volume?.setVolume(0.8);
      this.player.play(resource);
      this.isReverbToggling = false;

      
      
      
      setTimeout(() => {
        const { updateBotPresenceAndVoiceStatus } = require('./presenceManager');
        updateBotPresenceAndVoiceStatus(this, song).catch(() => { });
      }, 3000);

      // Delayed panel refresh to pick up async metadata enrichment (duration, release date)
      setTimeout(() => {
        updatePanel(this).catch(() => { });
      }, 6000);

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
    
    if (this.isPlaying && this.current) {
      this.isReverbToggling = true;
      const elapsed = this.resource ? this.resource.playbackDuration : 0;
      const newSeekTime = (this.currentSeekTime || 0) + elapsed;
      console.log(`[MusicQueue] Toggling reverb. Cumulative seek: ${this.currentSeekTime}ms, elapsed: ${elapsed}ms. Total: ${newSeekTime}ms`);
      this.playSong(this.current, newSeekTime);
    }
    return this.reverb;
  }

  
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

