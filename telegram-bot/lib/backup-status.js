// Health check for backup/cloud sync, based on how fresh the POS app's own auto-backup file
// is. The POS app rewrites this file roughly every ~35 seconds while it is open and syncing,
// so its mtime is a reasonable, zero-extra-infrastructure proxy for "is the app running and
// actively syncing right now." This does NOT talk to Supabase or Google Drive directly —
// it's a local, best-effort signal, and is described as such in the report text.

const fs = require('fs');

const STALE_MINUTES = 30;

function checkBackupStatus(cfg) {
  if (!fs.existsSync(cfg.dataFile)) {
    return {
      ok: false,
      message: `No auto-backup file found at ${cfg.dataFile}. The POS app may never have run on this machine, or the path has changed.`,
      lastWrite: null,
      ageMinutes: null,
    };
  }
  const stat = fs.statSync(cfg.dataFile);
  const ageMs = Date.now() - stat.mtime.getTime();
  const ageMinutes = Math.round(ageMs / 60000);
  const ok = ageMinutes <= STALE_MINUTES;
  return {
    ok,
    message: ok
      ? `Auto-backup last written ${ageMinutes} minute${ageMinutes === 1 ? '' : 's'} ago — looks healthy.`
      : `Auto-backup is ${ageMinutes} minutes old (stale beyond ${STALE_MINUTES}m). The POS app may be closed, or sync may have stopped — this is expected if the shop/PC is simply off right now.`,
    lastWrite: stat.mtime.toISOString(),
    ageMinutes,
  };
}

module.exports = { checkBackupStatus, STALE_MINUTES };
