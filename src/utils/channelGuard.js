function isAllowedChannel(channelId) {
  const allowed = (process.env.ALLOWED_CHANNEL_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
  if (allowed.length === 0) return true;
  return allowed.includes(channelId);
}

module.exports = { isAllowedChannel };
