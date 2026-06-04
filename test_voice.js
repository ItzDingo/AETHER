// Test voice dependencies
const { generateDependencyReport } = require('@discordjs/voice');
console.log(generateDependencyReport());

// Test libsodium-wrappers
async function testSodium() {
  try {
    const sodium = require('libsodium-wrappers');
    await sodium.ready;
    console.log('[OK] libsodium-wrappers is ready, version:', sodium.SODIUM_VERSION_STRING);
    console.log('[OK] xchacha20poly1305 available:', typeof sodium.crypto_aead_xchacha20poly1305_ietf_encrypt === 'function');
  } catch (err) {
    console.error('[FAIL] libsodium-wrappers:', err.message);
  }
}

// Test UDP connectivity (Discord voice uses UDP)
async function testUDP() {
  const dgram = require('dgram');
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const timeout = setTimeout(() => {
      console.error('[WARN] UDP test timed out - UDP may be blocked by firewall');
      socket.close();
      resolve(false);
    }, 5000);

    socket.on('error', (err) => {
      clearTimeout(timeout);
      console.error('[FAIL] UDP socket error:', err.message);
      socket.close();
      resolve(false);
    });

    socket.bind(0, () => {
      const addr = socket.address();
      console.log('[OK] UDP socket created on port', addr.port);
      // Try sending a packet to a Discord voice server IP range
      const buf = Buffer.from('test');
      socket.send(buf, 0, buf.length, 443, '162.159.128.233', (err) => {
        clearTimeout(timeout);
        if (err) {
          console.error('[WARN] UDP send failed:', err.message);
        } else {
          console.log('[OK] UDP send succeeded (can send UDP packets)');
        }
        socket.close();
        resolve(!err);
      });
    });
  });
}

// Test Node.js version
console.log('\nNode.js version:', process.version);
console.log('Platform:', process.platform, process.arch);

testSodium().then(() => testUDP()).then(() => {
  console.log('\nDiagnostics complete.');
  process.exit(0);
});
