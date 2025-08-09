// utils/debounce.js
// Map theo deviceId -> timer + lastArgs
const timers = new Map();

/**
 * Tạo 1 hàm debounce cho mỗi deviceId.
 * - delay mặc định 150ms (đủ mượt cho scoreboard).
 */
function createDebounce(deviceId, fn, delay = 150) {
  return (...args) => {
    if (timers.has(deviceId)) clearTimeout(timers.get(deviceId).timer);
    const timer = setTimeout(() => {
      timers.delete(deviceId);
      try { fn(...args); } catch {}
    }, delay);
    timers.set(deviceId, { timer, args });
  };
}

function clearDebounce(deviceId) {
  const item = timers.get(deviceId);
  if (!item) return;
  try { clearTimeout(item.timer); } catch {}
  timers.delete(deviceId);
}

module.exports = { createDebounce, clearDebounce };
