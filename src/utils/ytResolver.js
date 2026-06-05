const { initOAuth, hasOAuthCredentials } = require('./ytOAuth');

let innertubePromise = null;
let guestInnertubePromise = null;

// Use 'WEB' client for metadata (song info, search, titles) — reliable and well-supported.
// Use 'ANDROID' client ONLY for stream URL extraction (returns direct unciphered URLs).
const METADATA_CLIENT_TYPE = 'WEB';
const STREAM_CLIENT_TYPE = 'ANDROID';

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

async function getInnertube() {
  if (!innertubePromise) {
    innertubePromise = (async () => {
      const { Innertube, Log } = await import('youtubei.js');
      if (Log && typeof Log.setLevel === 'function') {
        Log.setLevel(1);
      }

      // Strategy 1: Try OAuth2 (persistent, never expires)
      if (hasOAuthCredentials()) {
        console.log(`[ytResolver] Initializing youtubei.js with OAuth2 using client: ${METADATA_CLIENT_TYPE}...`);
        try {
          const yt = await withTimeout(Innertube.create({ client_type: METADATA_CLIENT_TYPE }), 15000, 'Innertube.create');
          const success = await initOAuth(yt);
          if (success) {
            console.log('[ytResolver] ✅ youtubei.js initialized with OAuth2 successfully.');
            return yt;
          }
          console.warn('[ytResolver] OAuth2 sign-in returned false. Trying fallbacks...');
        } catch (err) {
          console.error('[ytResolver] OAuth2 initialization failed:', err.message);
        }
      }

      // Strategy 2: Try cookies (legacy fallback)
      const cookie = getCookieString();
      if (cookie) {
        console.log(`[ytResolver] Initializing youtubei.js with cookies (length: ${cookie.length}) using client: ${METADATA_CLIENT_TYPE}`);
        try {
          const yt = await withTimeout(Innertube.create({ cookie, client_type: METADATA_CLIENT_TYPE }), 15000, 'Innertube.create (cookies)');
          return yt;
        } catch (err) {
          console.error('[ytResolver] Cookie-based initialization failed:', err.message);
        }
      }

      // Strategy 3: Guest mode (no auth)
      console.log(`[ytResolver] Initializing youtubei.js in guest mode (no auth) using client: ${METADATA_CLIENT_TYPE}.`);
      return withTimeout(Innertube.create({ client_type: METADATA_CLIENT_TYPE }), 15000, 'Innertube.create (guest)');
    })().catch((err) => {
      innertubePromise = null;
      throw err;
    });
  }

  return innertubePromise;
}

async function getGuestInnertube() {
  if (!guestInnertubePromise) {
    guestInnertubePromise = import('youtubei.js')
      .then(({ Innertube, Log }) => {
        if (Log && typeof Log.setLevel === 'function') {
          Log.setLevel(1);
        }
        console.log(`[ytResolver] Initializing guest youtubei.js instance (no cookies) using client: ${METADATA_CLIENT_TYPE}`);
        return withTimeout(Innertube.create({ client_type: METADATA_CLIENT_TYPE }), 15000, 'Innertube.create (guest)');
      })
      .catch((err) => {
        guestInnertubePromise = null;
        throw err;
      });
  }
  return guestInnertubePromise;
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
async function getDirectStreamUrl(videoId) {
  try {
    // Use ANDROID client specifically for stream URL extraction (unciphered direct URLs)
    const { Innertube } = await import('youtubei.js');
    console.log(`[ytResolver] Creating ANDROID client for stream URL extraction of ${videoId}...`);
    const ytStream = await withTimeout(Innertube.create({ client_type: STREAM_CLIENT_TYPE }), 15000, 'Innertube.create (stream)');
    
    // If we have OAuth2, authenticate this instance too
    if (hasOAuthCredentials()) {
      try {
        const { loadCredentials } = require('./ytOAuth');
        const saved = loadCredentials();
        if (saved) {
          await ytStream.session.signIn(saved);
          console.log(`[ytResolver] ANDROID stream instance authenticated with OAuth2`);
        }
      } catch (authErr) {
        console.warn(`[ytResolver] ANDROID stream instance OAuth2 failed, continuing as guest:`, authErr.message);
      }
    }

    let info = await withTimeout(ytStream.getBasicInfo(videoId), 10000, 'getBasicInfo (stream)').catch((err) => {
      console.warn(`[ytResolver] ANDROID getBasicInfo failed for ${videoId}:`, err.message);
      return null;
    });

    // If ANDROID also fails, try WEB client for stream
    if (!info) {
      console.log(`[ytResolver] ANDROID stream failed for ${videoId}, trying WEB client...`);
      const yt = await getInnertube();
      info = await withTimeout(yt.getBasicInfo(videoId), 10000, 'getBasicInfo (WEB stream)').catch(() => null);
    }

    if (info) {
      const format = info.chooseFormat({ type: 'audio', quality: 'best' });
      if (format) {
        if (format.url) {
          return format.url;
        }
        if (format.signature_cipher || format.cipher) {
          console.log(`[ytResolver] Stream is ciphered for ${videoId}. Deciphering...`);
          const url = await format.decipher(ytStream.session.player);
          if (url) return url;
        }
      }
    }
  } catch (err) {
    console.error(`[ytResolver] Failed to get direct stream URL for ${videoId}:`, err.message);
  }
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

async function buildSongDataFromInnertube(videoId, preferMusic = false) {
  const cached = getCachedSong(videoId);
  if (cached) {
    console.log(`[ytResolver] Cache hit for ${videoId}`);
    return cached;
  }

  const fetchWithInstance = async (ytInstance) => {
    let info = null;

    if (preferMusic) {
      info = await withTimeout(ytInstance.music.getInfo(videoId), 10000, 'music.getInfo').catch((err) => {
        console.warn(`[ytResolver] music.getInfo failed for ${videoId}: ${err.message || err}`);
        return null;
      });

      if (info) {
        const tabs = info.tabs?.map((t) => t.title || t.type) || [];
        const playStatus = info.playability_status?.status;

        if (tabs.includes('Details')) {
          console.log(`[ytResolver] Rejected ${videoId}: has Details tab (podcast/talk)`);
          return { rejected: true };
        }

        if (playStatus === 'UNPLAYABLE') {
          const basicInfo = await withTimeout(ytInstance.getBasicInfo(videoId), 10000, 'getBasicInfo').catch(() => null);
          const category = basicInfo?.basic_info?.category;
          if (category !== 'Music') {
            console.log(`[ytResolver] Rejected ${videoId}: UNPLAYABLE on music + category="${category}"`);
            return { rejected: true };
          }
          console.log(`[ytResolver] Accepted ${videoId}: UNPLAYABLE on music but category=Music`);
          info = basicInfo;
        }
      }

      if (!info || !info.basic_info || !info.basic_info.title) {
        console.log(`[ytResolver] musicInfo missing or has no title for ${videoId}, falling back to getBasicInfo`);
        info = await withTimeout(ytInstance.getBasicInfo(videoId), 10000, 'getBasicInfo').catch((err) => {
          console.warn(`[ytResolver] getBasicInfo fallback failed for ${videoId}: ${err.message || err}`);
          return null;
        });
      }
    } else {
      info = await withTimeout(ytInstance.getBasicInfo(videoId), 10000, 'getBasicInfo').catch((err) => {
        console.warn(`[ytResolver] getBasicInfo failed for ${videoId}: ${err.message || err}`);
        return null;
      });
    }

    if (info && info.basic_info && info.basic_info.title) {
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

      if (!releaseDateStr && preferMusic) {
        console.log(`[ytResolver] Release date missing from musicInfo, falling back to getBasicInfo for ${videoId}`);
        const basicInfo = await withTimeout(ytInstance.getBasicInfo(videoId), 8000, 'getBasicInfo').catch(() => null);
        if (basicInfo) {
          const bPage0 = basicInfo.page?.[0];
          const bMicroformat = bPage0?.microformat;
          if (bMicroformat) {
            const pubDate = bMicroformat.publish_date || bMicroformat.upload_date;
            if (pubDate && typeof pubDate === 'string') {
              const dateMatch = pubDate.match(/^([0-9]{4}-[0-9]{2}-[0-9]{2})/);
              if (dateMatch) releaseDateStr = dateMatch[1];
            }
          }
          if (!releaseDateStr) {
            const desc = basicInfo.basic_info?.short_description || '';
            const releaseMatch = desc.match(/Released on:[ \t]*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
            if (releaseMatch) releaseDateStr = releaseMatch[1];
          }
          if (!releaseDateStr) {
            releaseDateStr = pickFirst(
              basicInfo.basic_info?.upload_date,
              basicInfo.basic_info?.publish_date,
              null
            );
          }
        }
      }
      info.resolvedReleaseDateStr = releaseDateStr;
    }

    return info;
  };

  try {
    const yt = await getInnertube();
    let info = await fetchWithInstance(yt);

    // If fetch failed, try again with the guest instance (works for both OAuth2 and cookie auth)
    if (!info || (!info.basic_info && !info.rejected)) {
      console.log(`[ytResolver] Fetch failed with authenticated instance for ${videoId}. Retrying with guest instance...`);
      const ytGuest = await getGuestInnertube();
      info = await fetchWithInstance(ytGuest);
    }

    if (info && info.rejected) {
      return null;
    }

    if (!info || !info.basic_info || !info.basic_info.title) {
      console.log(`[ytResolver] Rejecting ${videoId}: Missing basic_info or title after all attempts`);
      return null;
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
    const releaseDateStr = info.resolvedReleaseDateStr;

    const result = {
      title,
      author,
      duration: formatDuration(durationSec),
      durationSec,
      thumbnail,
      url,
      videoId,
      releaseDate: formatReleaseDate(releaseDateStr),
    };

    cacheSong(videoId, result);
    return result;
  } catch (err) {
    console.error(`[ytResolver] youtubei.js lookup failed for ${videoId}:`, err.message);
    return null;
  }
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
  cacheSong(videoId, result);
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

  try {
    const yt = await getInnertube();
    let items = [];
    try {
      items = await searchWithInstance(yt);
    } catch (err) {
      console.warn(`[ytResolver] Search with authenticated instance failed: ${err.message || err}`);
      // Always retry with guest instance (not just when cookies exist)
      console.log('[ytResolver] Retrying search with guest instance...');
      const ytGuest = await getGuestInnertube();
      items = await searchWithInstance(ytGuest);
    }

    if (items.length === 0) {
      console.log(`[ytResolver] No matching songs/videos found on YouTube Music for "${query}"`);
      return null;
    }

    // First: try to extract metadata directly from search results (fast, avoids 400 errors)
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

    // Last resort: try yt-search with the first video ID
    const firstId = items.find((i) => i.id)?.id;
    if (firstId) {
      const song = await resolveWithYtSearch(firstId);
      if (song) return song;
    }

    return null;
  } catch (err) {
    console.error('[ytResolver] search error:', err.message || err);
    // Final fallback: try yt-search text search
    try {
      const ytSearch = require('yt-search');
      console.log(`[ytResolver] Falling back to yt-search text search for: "${query}"`);
      const searchResult = await ytSearch(query);
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

    // Try youtubei.js first
    const song = await buildSongDataFromInnertube(id, true);
    if (song) return song;

    // Fallback: use yt-search to get metadata
    console.log(`[ytResolver] youtubei.js failed for ${id}, trying yt-search fallback...`);
    const ytSearchSong = await resolveWithYtSearch(id);
    if (ytSearchSong) return ytSearchSong;

    console.log(`[ytResolver] All resolution methods failed for video ID ${id}. Rejecting.`);
    return null;
  }

  return await searchYouTubeMusic(input);
}

module.exports = { resolveSong, formatDuration, getDirectStreamUrl, getInnertube, extractVideoId };
