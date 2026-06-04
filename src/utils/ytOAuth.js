const fs = require('fs');
const path = require('path');

const CREDS_PATH = path.join(__dirname, '..', '..', 'temp', 'oauth_credentials.json');

let currentCredentials = null;

/**
 * Load saved OAuth2 credentials from file (written by index.js from env var,
 * or by setup_oauth.js during first-time setup).
 */
function loadCredentials() {
  try {
    if (fs.existsSync(CREDS_PATH)) {
      const data = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf-8'));
      if (data && data.access_token) {
        console.log('[ytOAuth] Loaded OAuth2 credentials from file.');
        currentCredentials = data;
        return data;
      }
    }
  } catch (err) {
    console.error('[ytOAuth] Error loading OAuth2 credentials:', err.message);
  }
  return null;
}

/**
 * Save OAuth2 credentials to file (so they persist across restarts).
 */
function saveCredentials(credentials) {
  try {
    const dir = path.dirname(CREDS_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CREDS_PATH, JSON.stringify(credentials, null, 2), 'utf-8');
    currentCredentials = credentials;
    console.log('[ytOAuth] OAuth2 credentials saved to file.');
  } catch (err) {
    console.error('[ytOAuth] Error saving OAuth2 credentials:', err.message);
  }
}

/**
 * Initialize OAuth2 on an Innertube instance.
 * - If saved credentials exist, signs in with them (no user interaction needed).
 * - Listens for credential updates (token refresh) and saves them automatically.
 * - If no credentials exist, the instance runs unauthenticated (guest mode).
 *
 * @param {object} yt - An Innertube instance
 * @returns {Promise<boolean>} - true if OAuth2 sign-in succeeded
 */
async function initOAuth(yt) {
  const saved = loadCredentials();

  // Listen for credential updates (token refresh) and persist them
  yt.session.on('update-credentials', ({ credentials }) => {
    console.log('[ytOAuth] OAuth2 credentials refreshed automatically.');
    saveCredentials(credentials);
  });

  yt.session.on('auth', ({ credentials }) => {
    console.log('[ytOAuth] OAuth2 auth event received.');
    saveCredentials(credentials);
  });

  yt.session.on('auth-error', (err) => {
    console.error('[ytOAuth] OAuth2 auth error:', err.message || err);
  });

  if (!saved) {
    console.log('[ytOAuth] No OAuth2 credentials found. Running in guest mode.');
    console.log('[ytOAuth] Run "node setup_oauth.js" to set up persistent authentication.');
    return false;
  }

  try {
    await yt.session.signIn(saved);
    console.log('[ytOAuth] OAuth2 sign-in successful.');
    return true;
  } catch (err) {
    console.error('[ytOAuth] OAuth2 sign-in failed:', err.message);
    console.log('[ytOAuth] Falling back to guest mode. Run "node setup_oauth.js" to re-authenticate.');
    return false;
  }
}

/**
 * Get the current OAuth2 access token (for use by yt-dlp).
 * Returns null if OAuth2 is not configured.
 */
function getOAuthToken() {
  if (currentCredentials && currentCredentials.access_token) {
    return currentCredentials.access_token;
  }
  // Try loading from file in case it was updated externally
  const loaded = loadCredentials();
  return loaded ? loaded.access_token : null;
}

/**
 * Check if OAuth2 credentials are available.
 */
function hasOAuthCredentials() {
  return !!(currentCredentials && currentCredentials.access_token) || fs.existsSync(CREDS_PATH);
}

module.exports = { initOAuth, getOAuthToken, hasOAuthCredentials, saveCredentials, loadCredentials, CREDS_PATH };
