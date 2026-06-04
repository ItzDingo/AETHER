/**
 * One-time OAuth2 setup script for Musico.
 *
 * Run this script once to authenticate with YouTube using the TV device code flow.
 * After completing the setup, the script saves credentials locally and prints a
 * base64-encoded string that you can paste into Railway as YOUTUBE_OAUTH_CREDENTIALS.
 *
 * Usage:
 *   node setup_oauth.js
 */

const fs = require('fs');
const path = require('path');

const CREDS_PATH = path.join(__dirname, 'temp', 'oauth_credentials.json');

async function setup() {
  console.log('==============================================');
  console.log('  Musico — YouTube OAuth2 Setup');
  console.log('==============================================');
  console.log('');
  console.log('This will authenticate your bot with YouTube using OAuth2.');
  console.log('You only need to do this ONCE. The token auto-refreshes forever.');
  console.log('');

  const { Innertube } = await import('youtubei.js');
  const yt = await Innertube.create();

  // Listen for the device code prompt
  yt.session.on('auth-pending', (data) => {
    console.log('----------------------------------------------');
    console.log('');
    console.log('  👉  Go to: ' + data.verification_url);
    console.log('  👉  Enter code: ' + data.user_code);
    console.log('');
    console.log('----------------------------------------------');
    console.log('');
    console.log('Waiting for you to authorize...');
  });

  // Listen for successful auth
  yt.session.on('auth', ({ credentials }) => {
    console.log('');
    console.log('✅ Authentication successful!');
    console.log('');

    // Save locally
    const dir = path.dirname(CREDS_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CREDS_PATH, JSON.stringify(credentials, null, 2), 'utf-8');
    console.log(`Credentials saved to: ${CREDS_PATH}`);
    console.log('');

    // Generate base64 for Railway env var
    const base64 = Buffer.from(JSON.stringify(credentials)).toString('base64');
    console.log('==============================================');
    console.log('  RAILWAY SETUP');
    console.log('==============================================');
    console.log('');
    console.log('Add this as a Railway environment variable:');
    console.log('');
    console.log('  Variable name:  YOUTUBE_OAUTH_CREDENTIALS');
    console.log('  Variable value: (copy the line below)');
    console.log('');
    console.log(base64);
    console.log('');
    console.log('==============================================');
    console.log('');
    console.log('Done! Your bot will now use OAuth2 instead of cookies.');
    console.log('You can close your browser — the token will NOT expire.');
    console.log('');

    // Give time for the event to complete before exiting
    setTimeout(() => process.exit(0), 2000);
  });

  yt.session.on('auth-error', (err) => {
    console.error('');
    console.error('❌ Authentication failed:', err.message || err);
    console.error('Please try again.');
    process.exit(1);
  });

  // Start the device code flow
  try {
    await yt.session.signIn();
  } catch (err) {
    console.error('❌ Sign-in error:', err.message);
    process.exit(1);
  }
}

setup().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
