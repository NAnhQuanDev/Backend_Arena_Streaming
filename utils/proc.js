const fs = require('fs');

function isZombie(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); // "pid (cmd) STATE ..."
    const m = stat.match(/^\d+\s+\(.+?\)\s+([A-Z])/);
    return m && m[1] === 'Z';
  } catch {
    return false;
  }
}

function isAlive(proc) {
  if (!proc || !proc.pid) return false;
  try {
    process.kill(proc.pid, 0);
    return true;
  } catch (e) {
    if (e && e.code === 'EPERM') return true; // tồn tại nhưng không đủ quyền
    return false; // ESRCH: không tồn tại
  }
}

module.exports = { isZombie, isAlive };
