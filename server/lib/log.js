/** Minimal structured logger. One line per event, easy to read in host log tails. */
const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = levels[process.env.LOG_LEVEL || 'info'] || 20;

function emit(level, msg, meta) {
  if (levels[level] < threshold) return;
  const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), msg];
  if (meta && Object.keys(meta).length) {
    parts.push(
      Object.entries(meta)
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ')
    );
  }
  const line = parts.join(' ');
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

module.exports = {
  debug: (m, meta) => emit('debug', m, meta),
  info: (m, meta) => emit('info', m, meta),
  warn: (m, meta) => emit('warn', m, meta),
  error: (m, meta) => emit('error', m, meta)
};
