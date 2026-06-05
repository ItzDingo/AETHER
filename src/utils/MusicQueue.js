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
const { getDirectStreamUrl } = require('./ytResolver');


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

  async _ytdlpGetUrl(videoUrl) {
    const path = require('path');
    const fs = require('fs');
    const os = require('os');

    const args = [
      '-f',
      'bestaudio/best',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--user-agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ];

    // Try to use cookies from environment variable or local file
    const cookiesEnv = process.env.YOUTUBE_COOKIES;
    let cookiesPath = null;

    if (cookiesEnv && cookiesEnv.trim()) {
      // Write cookies from env var to a temp file
      cookiesPath = path.join(os.tmpdir(), `yt-cookies-${Date.now()}.txt`);
      try {
        fs.writeFileSync(cookiesPath, cookiesEnv, 'utf8');
        const fileSize = fs.statSync(cookiesPath).size;
        console.log(`[MusicQueue] Wrote cookies to ${cookiesPath} (${fileSize} bytes)`);
        args.push('--cookies', cookiesPath);
        console.log('[MusicQueue] Using cookies from YOUTUBE_COOKIES environment variable');
      } catch (err) {
        console.error('[MusicQueue] Failed to write cookies from env var:', err.message);
        cookiesPath = null;
      }
    } else {
      // Fallback to local cookies file
      const localCookiesPath = path.join(__dirname, '..', '..', 'temp', 'cookies.txt');
      if (fs.existsSync(localCookiesPath)) {
        args.push('--cookies', localCookiesPath);
        console.log('[MusicQueue] Using cookies from local file');
      } else {
        console.warn('[MusicQueue] No cookies found (YOUTUBE_COOKIES env var is empty or temp/cookies.txt missing)');
      }
    }

    args.push('-g', videoUrl);

    console.log(`[MusicQueue] Running yt-dlp with args: ${args.join(' ')}`);

    const ytdlp = spawn(getYtdlpBinary(), args, {
      windowsHide: true,
    });

    this.activeProcesses.push(ytdlp);

    try {
      const { stdout, stderr } = await waitForProcessOutput(ytdlp);
      
      if (stderr) {
        console.log(`[MusicQueue] yt-dlp stderr: ${stderr.substring(0, 200)}`);
      }
      
      const directUrl = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);

      if (!directUrl) {
        throw new Error('yt-dlp did not return a direct audio URL.');
      }

      return directUrl;
    } finally {
      // Clean up temp cookies file if we created one
      if (cookiesPath && fs.existsSync(cookiesPath)) {
        try {
          fs.unlinkSync(cookiesPath);
        } catch { }
      }
    }
  }

  async getDirectAudioUrl(videoUrl, videoId) {
    if (videoId) {
      const cached = getCachedUrl(videoId);
      if (cached) {
        console.log(`[MusicQueue] URL cache hit for ${videoId}`);
        return cached;
      }
    }

    // Try youtubei.js first (especially important if authenticated with OAuth2)
    if (videoId) {
      try {
        console.log(`[MusicQueue] Resolving direct stream URL via youtubei.js for ${videoId}...`);
        const directUrl = await getDirectStreamUrl(videoId);
        if (directUrl) {
          console.log(`[MusicQueue] Successfully resolved stream URL via youtubei.js`);
          directUrlCache.set(videoId, { url: directUrl, timestamp: Date.now() });
          return directUrl;
        }
        console.log(`[MusicQueue] youtubei.js returned no stream URL, falling back to yt-dlp.`);
      } catch (err) {
        console.warn(`[MusicQueue] youtubei.js resolution failed for ${videoId}:`, err.message);
      }
    }

    const maxAttempts = 3;
    const delays = [0, 2000, 4000];
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (delays[attempt] > 0) {
        console.log(`[MusicQueue] yt-dlp retry ${attempt + 1}/${maxAttempts} in ${delays[attempt] / 1000}s...`);
        await new Promise(r => setTimeout(r, delays[attempt]));
      }

      try {
        const directUrl = await this._ytdlpGetUrl(videoUrl);

        if (videoId) {
          directUrlCache.set(videoId, { url: directUrl, timestamp: Date.now() });
        }
        return directUrl;
      } catch (err) {
        lastError = err;
        const msg = err.message || '';
        const isBotBlock = msg.includes('Sign in to confirm') || msg.includes('not a bot');
        console.warn(`[MusicQueue] yt-dlp attempt ${attempt + 1}/${maxAttempts} failed: ${msg.substring(0, 120)}`);

        if (!isBotBlock) {
          break;
        }
      }
    }

    throw lastError || new Error('Failed to resolve audio URL');
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

