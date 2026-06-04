

let innertubePromise = null;


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
          console.warn(`[ytResolver] Skipping cookie "${name}" due to control/invalid characters.`);
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
    innertubePromise = import('youtubei.js')
      .then(({ Innertube, Log }) => {
        if (Log && typeof Log.setLevel === 'function') {
          Log.setLevel(1);
        }
        
        const cookie = getCookieString();
        const config = {};
        if (cookie) {
          console.log(`[ytResolver] Initializing youtubei.js with cookies (length: ${cookie.length})`);
          config.cookie = cookie;
        } else {
          console.log('[ytResolver] Initializing youtubei.js WITHOUT cookies');
        }

        return withTimeout(Innertube.create(config), 15000, 'Innertube.create')
          .catch(async (err) => {
            if (config.cookie) {
              console.error('[ytResolver] Failed to initialize Innertube WITH cookies, retrying WITHOUT cookies...', err.message);
              return withTimeout(Innertube.create({}), 15000, 'Innertube.create (fallback)');
            }
            throw err;
          });
      })
      .catch((err) => {
        innertubePromise = null;
        throw err;
      });
  }

  return innertubePromise;
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

  try {
    const yt = await getInnertube();
    let info = null;

    if (preferMusic) {
      info = await withTimeout(yt.music.getInfo(videoId), 10000, 'music.getInfo').catch(() => null);

      if (info) {
        const tabs = info.tabs?.map((t) => t.title || t.type) || [];
        const playStatus = info.playability_status?.status;

        if (tabs.includes('Details')) {
          console.log(`[ytResolver] Rejected ${videoId}: has Details tab (podcast/talk)`);
          return null;
        }

        if (playStatus === 'UNPLAYABLE') {
          const basicInfo = await withTimeout(yt.getBasicInfo(videoId), 10000, 'getBasicInfo').catch(() => null);
          const category = basicInfo?.basic_info?.category;
          if (category !== 'Music') {
            console.log(`[ytResolver] Rejected ${videoId}: UNPLAYABLE on music + category="${category}"`);
            return null;
          }
          console.log(`[ytResolver] Accepted ${videoId}: UNPLAYABLE on music but category=Music`);
          info = basicInfo;
        }
      }

      if (!info || !info.basic_info || !info.basic_info.title) {
        console.log(`[ytResolver] musicInfo missing or has no title for ${videoId}, falling back to getBasicInfo`);
        info = await withTimeout(yt.getBasicInfo(videoId), 10000, 'getBasicInfo').catch(() => null);
      }
    } else {
      info = await withTimeout(yt.getBasicInfo(videoId), 10000, 'getBasicInfo').catch(() => null);
    }

    if (!info || !info.basic_info || !info.basic_info.title) {
      console.log(`[ytResolver] Rejecting ${videoId}: Missing basic_info or title`);
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
      const basicInfo = await withTimeout(yt.getBasicInfo(videoId), 8000, 'getBasicInfo').catch(() => null);
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

async function searchYouTubeMusic(query) {
  try {
    const yt = await getInnertube();
    console.log(`[ytResolver] Searching YouTube Music for: "${query}"`);
    const results = await withTimeout(
      yt.music.search(query),
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

    if (items.length === 0) {
      console.log(`[ytResolver] No matching songs/videos found on YouTube Music for "${query}"`);
      return null;
    }

    
    for (const item of items.slice(0, 3)) {
      if (!item.id) continue;
      const song = await buildSongDataFromInnertube(item.id, true);
      if (song) return song;
    }

    return null;
  } catch (err) {
    console.error('[ytResolver] search error:', err.message);
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

    const song = await buildSongDataFromInnertube(id, true);
    if (song) return song;

    console.log(`[ytResolver] URL video ID ${id} is not registered on YouTube Music. Rejecting.`);
    return null;
  }

  return await searchYouTubeMusic(input);
}

module.exports = { resolveSong, formatDuration };
