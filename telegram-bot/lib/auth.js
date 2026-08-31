// Access control for the interactive bot. Only numeric Telegram user IDs listed in
// config.json -> allowedUserIds may use admin commands. Everyone else gets a polite refusal
// with no pharmacy data attached, and the attempt is logged by the caller for visibility.

function isAuthorized(cfg, userId) {
  const list = Array.isArray(cfg.allowedUserIds) ? cfg.allowedUserIds : [];
  return list.map(String).includes(String(userId));
}

module.exports = { isAuthorized };
