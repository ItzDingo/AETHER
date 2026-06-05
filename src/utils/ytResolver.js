const { initOAuth, hasOAuthCredentials } = require('./ytOAuth');
const https = require('https');
const http = require('http');

/**
 * Validate a stream URL by sending a HEAD request.
 * Returns the URL if it responds with 2xx/3xx, or null if 403/etc.
 * This prevents returning URLs that look valid but get blocked by YouTube's CDN on datacenter IPs.
 */
async function validateStreamUrl(url) {
  if (!url) return null;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.warn(`[ytResolver] URL validation timed out, accepting URL optimistically.`);
      resolve(url);
    }, 5000);
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, { method: 'HEAD', timeout: 4000 }, (res) => {
      clearTimeout(timeout);
      if (res.statusCode >= 200 && res.statusCode < 400) {
        console.log(`[ytResolver] URL validation passed (HTTP ${res.statusCode}).`);
        resolve(url);
      } else {
        console.warn(`[ytResolver] URL validation failed (HTTP ${res.statusCode}). Discarding URL.`);
        resolve(null);
      }
      res.resume(); // drain response
    });
    req.on('error', (err) => {
      clearTimeout(timeout);
      console.warn(`[ytResolver] URL validation error: ${err.message}. Accepting URL optimistically.`);
      resolve(url);
    });
    req.on('timeout', () => {
      req.destroy();
      clearTimeout(timeout);
      console.warn(`[ytResolver] URL validation socket timeout. Accepting URL optimistically.`);
      resolve(url);
    });
    req.end();
  });
}

let innertubePromise = null;
let guestInnertubePromise = null;
let androidInnertubePromise = null;

// WEB client is used for YouTube Music search (music.search API)
// ANDROID client is used for metadata (getBasicInfo) and stream URLs — it bypasses datacenter IP blocks
const SEARCH_CLIENT_TYPE = 'WEB';
const STREAM_CLIENT_TYPE = 'ANDROID';
const METADATA_CLIENT_TYPE = 'ANDROID';

function setupEvalShim(Platform) {
  if (Platform && Platform.shim) {
    Platform.shim.eval = async (data) => {
      return new Function(data.output)();
    };
  }
}

const songCache = new Map();
const SONG_CACHE_TTL = 10 * 60 * 1000;

function getCachedSong(videoId) {
  const entry = songCache.get(videoId);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > SONG_CACHE_TTL) {
    songCache.delete(videoId);
    return null;
  }
  return entry.data;
}

function cacheSong(videoId, data) {
  songCache.set(videoId, { data, timestamp: Date.now() });
}

function withTimeout(promise, ms, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

function formatReleaseDate(dateStr) {
  if (!dateStr) return 'Unknown';
  const cleaned = String(dateStr).trim();
  if (/^\d{8}$/.test(cleaned)) {
    const y = cleaned.slice(0, 4);
    const m = cleaned.slice(4, 6);
    const d = cleaned.slice(6, 8);
    return `${y},${m},${d}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
    return cleaned.replace(/-/g, ',');
  }
  return cleaned;
}

function getCookieString() {
  const fs = require('fs');
  const path = require('path');
  const cookiesPath = path.join(__dirname, '..', '..', 'temp', 'cookies.txt');
  if (!fs.existsSync(cookiesPath)) {
    return '';
  }
  try {
    const data = fs.readFileSync(cookiesPath, 'utf8');
    const lines = data.split('\n');
    const cookies = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || !trimmed) continue;
      const parts = line.split('\t');
      if (parts.length >= 7) {
        const name = parts[5].trim();
        const value = parts[6].trim();

        // Skip cookies with control/invalid characters to prevent undici/fetch crashing
        if (/[\x00-\x1F\x7F]/.test(name) || /[\x00-\x1F\x7F]/.test(value)) {
          continue;
        }

        cookies.push(`${name}=${value}`);
      }
    }
    return cookies.join('; ');
  } catch (err) {
    console.error('[ytResolver] Error reading/parsing cookies.txt:', err);
    return '';
  }
}

// getInnertube returns a WEB client — used primarily for music.search
async function getInnertube() {
  if (!innertubePromise) {
    innertubePromise = (async () => {
      const { Innertube, Log, Platform } = await import('youtubei.js');
      setupEvalShim(Platform);
      if (Log && typeof Log.setLevel === 'function') {
        Log.setLevel(1);
      }

      // Strategy 1: Try cookies (legacy fallback)
      const cookie = getCookieString();
      if (cookie) {
        console.log(`[ytResolver] Initializing youtubei.js with cookies (length: ${cookie.length}) using client: ${SEARCH_CLIENT_TYPE}`);
        try {
          const yt = await withTimeout(Innertube.create({ cookie, client_type: SEARCH_CLIENT_TYPE }), 15000, 'Innertube.create (cookies)');
          return yt;
        } catch (err) {
          console.error('[ytResolver] Cookie-based initialization failed:', err.message);
        }
      }

      // Strategy 2: Guest mode (no auth)
      console.log(`[ytResolver] Initializing youtubei.js in guest mode (no auth) using client: ${SEARCH_CLIENT_TYPE}.`);
      return withTimeout(Innertube.create({ client_type: SEARCH_CLIENT_TYPE }), 15000, 'Innertube.create (guest)');
    })().catch((err) => {
      innertubePromise = null;
      throw err;
    });
  }

  return innertubePromise;
}

// getGuestInnertube returns a guest WEB client — fallback for search
async function getGuestInnertube() {
  if (!guestInnertubePromise) {
    guestInnertubePromise = import('youtubei.js')
      .then(({ Innertube, Log, Platform }) => {
        setupEvalShim(Platform);
        if (Log && typeof Log.setLevel === 'function') {
          Log.setLevel(1);
        }
        console.log(`[ytResolver] Initializing guest youtubei.js instance (no cookies) using client: ${SEARCH_CLIENT_TYPE}`);
        return withTimeout(Innertube.create({ client_type: SEARCH_CLIENT_TYPE }), 15000, 'Innertube.create (guest)');
      })
      .catch((err) => {
        guestInnertubePromise = null;
        throw err;
      });
  }
  return guestInnertubePromise;
}

// getAndroidInnertube returns a guest ANDROID client — used for metadata (getBasicInfo)
// ANDROID client bypasses datacenter IP blocking that causes 400 errors on WEB client.
// Note: We MUST run it in guest mode because signing in with TV-scoped OAuth2 tokens
// causes all ANDROID player requests to fail with HTTP 400.
async function getAndroidInnertube() {
  if (!androidInnertubePromise) {
    androidInnertubePromise = (async () => {
      const { Innertube, Log, Platform } = await import('youtubei.js');
      setupEvalShim(Platform);
      if (Log && typeof Log.setLevel === 'function') {
        Log.setLevel(1);
      }
      console.log(`[ytResolver] Initializing guest ANDROID youtubei.js instance...`);
      return withTimeout(Innertube.create({ client_type: 'ANDROID' }), 15000, 'Innertube.create (guest ANDROID)');
    })().catch((err) => {
      androidInnertubePromise = null;
      throw err;
    });
  }
  return androidInnertubePromise;
}

let tvInnertubePromise = null;

// getTvInnertube returns a TVHTML5 client authenticated with OAuth2 if credentials exist
async function getTvInnertube() {
  if (!tvInnertubePromise) {
    tvInnertubePromise = (async () => {
      const { Innertube, Log, Platform } = await import('youtubei.js');
      setupEvalShim(Platform);
      if (Log && typeof Log.setLevel === 'function') {
        Log.setLevel(1);
      }

      if (hasOAuthCredentials()) {
        console.log(`[ytResolver] Initializing TVHTML5 youtubei.js instance with OAuth2...`);
        try {
          const yt = await withTimeout(Innertube.create({ client_type: 'TVHTML5' }), 15000, 'Innertube.create (TVHTML5 OAuth)');
          const success = await initOAuth(yt);
          if (success) {
            console.log('[ytResolver] ✅ TVHTML5 youtubei.js initialized with OAuth2 successfully.');
            return yt;
          }
          console.warn('[ytResolver] TVHTML5 OAuth2 sign-in returned false. Trying guest TVHTML5 fallback...');
        } catch (err) {
          console.error('[ytResolver] TVHTML5 OAuth2 initialization failed:', err.message);
        }
      }

      console.log(`[ytResolver] Initializing guest TVHTML5 youtubei.js instance...`);
      return withTimeout(Innertube.create({ client_type: 'TVHTML5' }), 15000, 'Innertube.create (guest TVHTML5)');
    })().catch((err) => {
      tvInnertubePromise = null;
      throw err;
    });
  }
  return tvInnertubePromise;
}

const YT_MUSIC_REGEX = /music\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/i;
const YT_REGEX = /(?:youtube\.com\/watch\?v=|youtube\.com\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/i;

function extractVideoId(input) {
  if (!input) return null;

  const trimmed = String(input).trim();
  const match = trimmed.match(YT_MUSIC_REGEX) || trimmed.match(YT_REGEX);
  if (match) {
    return { id: match[1], isYtMusic: /music\.youtube\.com/i.test(trimmed) };
  }

  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return { id: trimmed, isYtMusic: false };
  }

  return null;
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

/**
 * Helper function to retrieve the direct stream URL for a given video ID.
 * Resolves the URL using an authenticated or guest Innertube instance.
 */
async function extractUrlFromInfo(info, ytInstance) {
  if (!info) return null;

  // Early exit if there's no streaming data at all — avoids the noisy
  // "Streaming data not available" error from chooseFormat.
  if (!info.streaming_data) {
    console.log(`[ytResolver] No streaming_data in response, skipping format extraction.`);
    return null;
  }
  
  const formats = [
    ...(info.streaming_data?.formats || []),
    ...(info.streaming_data?.adaptive_formats || [])
  ];

  // Filter for formats that actually contain audio
  const audioCapableFormats = formats.filter(f => {
    const mime = f.mime_type || '';
    return mime.includes('audio') || f.has_audio;
  });

  // 1. Try to find formats that have direct, unciphered URLs (highly reliable, no 403s)
  // Check for itag 22 (720p combined with 192kbps AAC audio)
  const itag22 = audioCapableFormats.find(f => f.itag === 22 && f.url);
  if (itag22) {
    console.log(`[ytResolver] Found direct URL for high-quality combined format (itag: 22)`);
    return itag22.url;
  }

  // Check for itag 18 (360p combined with 96kbps AAC audio)
  const itag18 = audioCapableFormats.find(f => f.itag === 18 && f.url);
  if (itag18) {
    console.log(`[ytResolver] Found direct URL for medium-quality combined format (itag: 18)`);
    return itag18.url;
  }

  // Check for any other format that has a direct URL
  const anyDirect = audioCapableFormats.find(f => f.url);
  if (anyDirect) {
    console.log(`[ytResolver] Found direct URL for format (itag: ${anyDirect.itag})`);
    return anyDirect.url;
  }

  // 2. Fallback: Try audio-only formats with ciphers (needs deciphering)
  try {
    let bestAudioFormat = info.chooseFormat({ type: 'audio', quality: 'best' });
    if (bestAudioFormat) {
      if (bestAudioFormat.url) return bestAudioFormat.url;
      if (bestAudioFormat.signature_cipher || bestAudioFormat.cipher) {
        console.log(`[ytResolver] Deciphering audio-only stream (itag: ${bestAudioFormat.itag})...`);
        const url = await bestAudioFormat.decipher(ytInstance.session.player).catch(() => null);
        if (url) return url;
      }
    }
  } catch (err) {
    console.warn(`[ytResolver] chooseFormat fallback failed: ${err.message || err}`);
  }

  // 3. Last resort fallback: Try combined formats with ciphers
  const combinedWithCipher = audioCapableFormats.find(f => f.signature_cipher || f.cipher);
  if (combinedWithCipher) {
    console.log(`[ytResolver] Deciphering combined format (itag: ${combinedWithCipher.itag})...`);
    try {
      const combinedFormat = info.chooseFormat({ itag: combinedWithCipher.itag });
      if (combinedFormat) {
        const url = await combinedFormat.decipher(ytInstance.session.player).catch(() => null);
        if (url) return url;
      }
    } catch (err) {
      console.warn(`[ytResolver] Error choosing/deciphering combined format: ${err.message || err}`);
    }
  }

  return null;
}

async function getDirectStreamUrl(videoId) {
  // Strategy 1: Reuse cached Guest ANDROID instance (fastest & highly reliable)
  // ANDROID provides direct (unciphered) URLs that work from datacenter IPs.
  try {
    console.log(`[ytResolver] Trying cached Guest ANDROID client for stream URL of ${videoId}...`);
    const ytAndroid = await getAndroidInnertube();
    const info = await withTimeout(ytAndroid.getBasicInfo(videoId), 5000, 'getBasicInfo (cached ANDROID)').catch(() => null);
    const url = await extractUrlFromInfo(info, ytAndroid);
    if (url) {
      const validUrl = await validateStreamUrl(url);
      if (validUrl) {
        console.log(`[ytResolver] ✅ Stream URL resolved via cached Guest ANDROID.`);
        return validUrl;
      }
    }
  } catch (err) {
    console.warn(`[ytResolver] Cached Guest ANDROID stream extraction failed:`, err.message);
  }

  // Strategy 2: TVHTML5 client with OAuth2 (backup for age-restricted / login-required videos)
  try {
    console.log(`[ytResolver] Trying TVHTML5 client for stream URL of ${videoId}...`);
    const ytTv = await getTvInnertube();
    const info = await withTimeout(ytTv.getBasicInfo(videoId), 5000, 'getBasicInfo (TVHTML5)').catch(() => null);
    const url = await extractUrlFromInfo(info, ytTv);
    if (url) {
      const validUrl = await validateStreamUrl(url);
      if (validUrl) {
        console.log(`[ytResolver] ✅ Stream URL resolved via TVHTML5.`);
        return validUrl;
      }
    }
  } catch (err) {
    console.warn(`[ytResolver] TVHTML5 stream extraction failed:`, err.message);
  }

  // Strategy 3: Guest WEB client (deciphers URLs, but validate to catch 403s on datacenter IPs)
  try {
    const { Innertube, Platform } = await import('youtubei.js');
    setupEvalShim(Platform);
    console.log(`[ytResolver] Trying guest WEB client for stream URL of ${videoId}...`);
    const ytGuestWeb = await withTimeout(Innertube.create({ client_type: 'WEB' }), 8000, 'Innertube.create (guest WEB)');
    const info = await withTimeout(ytGuestWeb.getBasicInfo(videoId), 5000, 'getBasicInfo (guest WEB)').catch(() => null);
    const url = await extractUrlFromInfo(info, ytGuestWeb);
    if (url) {
      const validUrl = await validateStreamUrl(url);
      if (validUrl) {
        console.log(`[ytResolver] ✅ Stream URL resolved via guest WEB.`);
        return validUrl;
      }
    }
  } catch (err) {
    console.warn(`[ytResolver] Guest WEB stream extraction failed:`, err.message);
  }

  console.warn(`[ytResolver] ⚠️ All youtubei.js strategies failed for ${videoId}. Falling back to yt-dlp.`);
  return null;
}

function normalizeDuration(value) {
  if (!value && value !== 0) return 0;

  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) return Number(value);
    const parts = value.split(':').map(Number);
    if (parts.some((n) => Number.isNaN(n))) return 0;
    return parts.reduce((acc, part) => acc * 60 + part, 0);
  }

  if (typeof value === 'object') {
    return normalizeDuration(
      pickFirst(
        value.seconds,
        value.total_seconds,
        value.length_seconds,
        value.lengthSeconds,
        value.duration,
      ),
    );
  }

  return 0;
}

function normalizeThumbnail(value) {
  if (!value) return null;

  if (typeof value === 'string') return value;

  if (Array.isArray(value)) {
    const first = value.find(Boolean);
    if (!first) return null;
    return typeof first === 'string' ? first : pickFirst(first.url, first.thumbnails?.[0]?.url, null);
  }

  if (typeof value === 'object') {
    return pickFirst(
      value.url,
      value.thumbnails?.[0]?.url,
      value.best?.url,
      value.items?.[0]?.url,
      null,
    );
  }

  return null;
}

function formatDuration(seconds) {
  if (!seconds || Number.isNaN(seconds)) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Build song metadata for a video ID.
 * Strategy: ANDROID getBasicInfo first (bypasses datacenter IP blocks),
 * then WEB client as fallback, then yt-search as last resort.
 */
async function buildSongDataFromInnertube(videoId, preferMusic = false) {
  const cached = getCachedSong(videoId);
  if (cached) {
    console.log(`[ytResolver] Cache hit for ${videoId}`);
    return cached;
  }

  const extractMetadataFromInfo = (info) => {
    if (!info || !info.basic_info || !info.basic_info.title) return null;

    let releaseDateStr = null;
    const page0 = info.page?.[0];
    const microformat = page0?.microformat;
    if (microformat) {
      const pubDate = microformat.publish_date || microformat.upload_date;
      if (pubDate && typeof pubDate === 'string') {
        const dateMatch = pubDate.match(/^([0-9]{4}-[0-9]{2}-[0-9]{2})/);
        if (dateMatch) releaseDateStr = dateMatch[1];
      }
    }

    if (!releaseDateStr) {
      const desc = info.basic_info?.short_description || '';
      const releaseMatch = desc.match(/Released on:[ \t]*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
      if (releaseMatch) releaseDateStr = releaseMatch[1];
    }

    if (!releaseDateStr) {
      releaseDateStr = pickFirst(
        info.basic_info?.upload_date,
        info.basic_info?.publish_date,
        null
      );
    }

    const title = info.basic_info.title;
    const author = pickFirst(
      info.basic_info?.author,
      info.author?.name,
      info.channel?.name,
      info.artists?.[0]?.name,
      info.uploader,
      info.owner?.name,
      'Unknown Artist',
    );

    const durationSec = normalizeDuration(
      pickFirst(
        info.basic_info?.duration,
        info.basic_info?.length_seconds,
        info.basic_info?.lengthSeconds,
        info.duration,
        info.length_seconds,
        info.lengthSeconds,
      ),
    );

    const thumbnail = normalizeThumbnail(
      pickFirst(
        info.basic_info?.thumbnail,
        info.basic_info?.thumbnails,
        info.thumbnail,
        info.thumbnails,
      ),
    );

    const url = `https://www.youtube.com/watch?v=${videoId}`;

    return {
      title,
      author,
      duration: formatDuration(durationSec),
      durationSec,
      thumbnail,
      url,
      videoId,
      releaseDate: formatReleaseDate(releaseDateStr),
    };
  };

  // Strategy 1: ANDROID client getBasicInfo (most reliable on datacenter IPs)
  try {
    console.log(`[ytResolver] Trying ANDROID getBasicInfo for metadata of ${videoId}...`);
    const ytAndroid = await getAndroidInnertube();
    const info = await withTimeout(ytAndroid.getBasicInfo(videoId), 10000, 'getBasicInfo (ANDROID)').catch((err) => {
      console.warn(`[ytResolver] ANDROID getBasicInfo failed for ${videoId}: ${err.message}`);
      return null;
    });
    const result = extractMetadataFromInfo(info);
    if (result) {
      console.log(`[ytResolver] ✅ Metadata resolved via ANDROID: "${result.title}" by ${result.author}`);
      cacheSong(videoId, result);
      return result;
    }
  } catch (err) {
    console.warn(`[ytResolver] ANDROID metadata attempt failed for ${videoId}:`, err.message);
  }

  // Strategy 2: WEB client getBasicInfo (may fail on datacenter IPs but try anyway)
  try {
    console.log(`[ytResolver] Trying WEB getBasicInfo for metadata of ${videoId}...`);
    const ytWeb = await getGuestInnertube();
    const info = await withTimeout(ytWeb.getBasicInfo(videoId), 8000, 'getBasicInfo (WEB guest)').catch((err) => {
      console.warn(`[ytResolver] WEB getBasicInfo failed for ${videoId}: ${err.message}`);
      return null;
    });
    const result = extractMetadataFromInfo(info);
    if (result) {
      console.log(`[ytResolver] ✅ Metadata resolved via WEB: "${result.title}" by ${result.author}`);
      cacheSong(videoId, result);
      return result;
    }
  } catch (err) {
    console.warn(`[ytResolver] WEB metadata attempt failed for ${videoId}:`, err.message);
  }

  // Strategy 3: yt-search (independent package, doesn't use youtubei.js)
  console.log(`[ytResolver] youtubei.js metadata failed for ${videoId}, trying yt-search...`);
  const ytSearchResult = await resolveWithYtSearch(videoId);
  if (ytSearchResult) return ytSearchResult;

  console.log(`[ytResolver] All metadata resolution methods failed for ${videoId}`);
  return null;
}

/**
 * Extract song metadata directly from a YouTube Music search result item.
 * This avoids calling getInfo/getBasicInfo which may fail with 400 errors.
 */
function extractSongFromSearchItem(item) {
  if (!item || !item.id) return null;

  const videoId = item.id;

  // Extract title
  let title = null;
  if (typeof item.title === 'string') title = item.title;
  else if (item.title?.text) title = item.title.text;
  else if (item.title?.toString) title = item.title.toString();
  else if (item.name) title = item.name;

  if (!title) {
    console.log(`[ytResolver] Search item ${videoId} has no title, skipping`);
    return null;
  }

  // Extract artist
  let author = 'Unknown Artist';
  if (item.artists && item.artists.length > 0) {
    const names = item.artists.map((a) => a?.name || a?.text || '').filter(Boolean);
    if (names.length > 0) author = names.join(', ');
  } else if (item.author) {
    author = typeof item.author === 'string' ? item.author : (item.author?.name || item.author?.text || author);
  } else if (item.flex_columns) {
    // Some items store artist in flex_columns[1]
    try {
      const artistCol = item.flex_columns[1];
      const artistText = artistCol?.title?.text || artistCol?.title?.toString?.() || '';
      if (artistText) author = artistText;
    } catch {}
  }

  // Extract duration
  let durationSec = 0;
  if (item.duration) {
    if (typeof item.duration === 'number') durationSec = item.duration;
    else if (item.duration.seconds) durationSec = item.duration.seconds;
    else if (item.duration.text) durationSec = normalizeDuration(item.duration.text);
    else if (typeof item.duration === 'string') durationSec = normalizeDuration(item.duration);
  }

  // Extract thumbnail
  let thumbnail = null;
  if (item.thumbnails && item.thumbnails.length > 0) {
    thumbnail = item.thumbnails[0]?.url || null;
  } else if (item.thumbnail) {
    thumbnail = normalizeThumbnail(item.thumbnail);
  }

  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const result = {
    title,
    author,
    duration: formatDuration(durationSec),
    durationSec,
    thumbnail,
    url,
    videoId,
    releaseDate: 'Unknown',
  };

  console.log(`[ytResolver] Extracted from search: "${title}" by ${author} (${videoId})`);
  return result;
}

/**
 * Fallback: use yt-search package to get video metadata by ID.
 * Works independently of youtubei.js.
 */
async function resolveWithYtSearch(videoId) {
  try {
    const ytSearch = require('yt-search');
    console.log(`[ytResolver] Trying yt-search fallback for ${videoId}...`);
    const result = await withTimeout(
      ytSearch({ videoId }),
      10000,
      'yt-search'
    );
    if (result && result.title) {
      const song = {
        title: result.title,
        author: result.author?.name || result.author || 'Unknown Artist',
        duration: result.timestamp || formatDuration(result.seconds || 0),
        durationSec: result.seconds || 0,
        thumbnail: result.thumbnail || result.image || null,
        url: result.url || `https://www.youtube.com/watch?v=${videoId}`,
        videoId,
        releaseDate: result.ago || 'Unknown',
      };
      console.log(`[ytResolver] yt-search resolved: "${song.title}" by ${song.author}`);
      cacheSong(videoId, song);
      return song;
    }
  } catch (err) {
    console.warn(`[ytResolver] yt-search fallback failed for ${videoId}:`, err.message);
  }
  return null;
}

async function searchYouTubeMusic(query) {
  const searchWithInstance = async (ytInstance) => {
    console.log(`[ytResolver] Searching YouTube Music for: "${query}"`);
    const results = await withTimeout(
      ytInstance.music.search(query),
      12000,
      'music.search'
    );

    const items = results.contents
      ?.flatMap((c) => c.contents || [])
      ?.filter(
        (i) =>
          i.type === 'MusicResponsiveListItem' &&
          (i.item_type === 'song' || i.item_type === 'video')
      ) || [];

    return items;
  };

  // Strategy 1: YouTube Music search (WEB client)
  try {
    const yt = await getInnertube();
    let items = [];
    try {
      items = await searchWithInstance(yt);
    } catch (err) {
      console.warn(`[ytResolver] Search with authenticated instance failed: ${err.message || err}`);
      console.log('[ytResolver] Retrying search with guest instance...');
      const ytGuest = await getGuestInnertube();
      items = await searchWithInstance(ytGuest);
    }

    if (items.length > 0) {
      // Extract metadata directly from search results (fast, avoids 400 errors)
      for (const item of items.slice(0, 5)) {
        const song = extractSongFromSearchItem(item);
        if (song) return song;
      }

      // Fallback: try buildSongDataFromInnertube for each result
      console.log('[ytResolver] Could not extract from search items, trying getInfo fallback...');
      for (const item of items.slice(0, 3)) {
        if (!item.id) continue;
        const song = await buildSongDataFromInnertube(item.id, true);
        if (song) return song;
      }

      // Last resort from YTMusic results: try yt-search with the first video ID
      const firstId = items.find((i) => i.id)?.id;
      if (firstId) {
        const song = await resolveWithYtSearch(firstId);
        if (song) return song;
      }
    } else {
      console.log(`[ytResolver] No matching songs/videos found on YouTube Music for "${query}"`);
    }
  } catch (err) {
    console.error('[ytResolver] YouTube Music search error:', err.message || err);
  }

  // Strategy 2: yt-search text search (completely independent, works even when YTMusic fails)
  try {
    const ytSearch = require('yt-search');
    console.log(`[ytResolver] Falling back to yt-search text search for: "${query}"`);
    const searchResult = await withTimeout(ytSearch(query), 10000, 'yt-search text');
    if (searchResult && searchResult.videos && searchResult.videos.length > 0) {
      const v = searchResult.videos[0];
      const song = {
        title: v.title,
        author: v.author?.name || v.author || 'Unknown Artist',
        duration: v.timestamp || formatDuration(v.seconds || 0),
        durationSec: v.seconds || 0,
        thumbnail: v.thumbnail || v.image || null,
        url: v.url,
        videoId: v.videoId,
        releaseDate: v.ago || 'Unknown',
      };
      console.log(`[ytResolver] yt-search text search resolved: "${song.title}" by ${song.author}`);
      cacheSong(song.videoId, song);
      return song;
    }
  } catch (ytErr) {
    console.error('[ytResolver] yt-search text search also failed:', ytErr.message);
  }

  return null;
}

async function resolveSong(input) {
  const urlResult = extractVideoId(input);

  if (urlResult) {
    const { id } = urlResult;

    const cached = getCachedSong(id);
    if (cached) {
      console.log(`[ytResolver] Cache hit for URL ${id}`);
      return cached;
    }

    // buildSongDataFromInnertube now internally tries ANDROID → WEB → yt-search
    const song = await buildSongDataFromInnertube(id, true);
    if (song) return song;

    console.log(`[ytResolver] All resolution methods failed for video ID ${id}. Rejecting.`);
    return null;
  }

  const searchResult = await searchYouTubeMusic(input);
  if (searchResult && searchResult.videoId) {
    console.log(`[ytResolver] Search resolved video ID ${searchResult.videoId}, fetching rich metadata...`);
    const richSong = await buildSongDataFromInnertube(searchResult.videoId, true);
    if (richSong) {
      return richSong;
    }
  }

  return searchResult;
}

module.exports = { resolveSong, formatDuration, getDirectStreamUrl, getInnertube, extractVideoId };
