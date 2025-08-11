const { spawn } = require('child_process');
const fs = require('fs');
const config = require('../config/config');
const { isAlive, isZombie } = require('../utils/proc');
const socketService = require('../services/socketService'); 
require('dotenv').config()

// deviceid => { proc, output_url, overlayFiles, lastActivity }
const runningWorkers = {};
let REPORT_PUT_URL = '';
let CHECK_INTERVAL_MS = 60_000;
let STALL_THRESHOLD_MS = 180_000;
let KILL_GRACE_MS = 10_000;

function setReportUrl(url) { REPORT_PUT_URL = url; }
function setCheckConfig({ CHECK_INTERVAL_MS: c=60_000, STALL_THRESHOLD_MS: s=180_000, KILL_GRACE_MS: k=10_000 }) {
  CHECK_INTERVAL_MS = c; STALL_THRESHOLD_MS = s; KILL_GRACE_MS = k;
}

function tmpTextFile(deviceid, key) { return `/tmp/${deviceid}_${key}.txt`; }
function writeVal(filePath, val) { fs.writeFileSync(filePath, String(val ?? ''), 'utf8'); }

function createOverlayFiles(deviceid, init = {}) {
  const files = {
    name: tmpTextFile(deviceid, 'name'),
    playerName1: tmpTextFile(deviceid, 'playerName1'),
    playerName2: tmpTextFile(deviceid, 'playerName2'),
    p1Score: tmpTextFile(deviceid, 'p1Score'),
    p2Score: tmpTextFile(deviceid, 'p2Score'),
    nowPoint1: tmpTextFile(deviceid, 'nowPoint1'),
    nowPoint2: tmpTextFile(deviceid, 'nowPoint2'),
    player1Innings: tmpTextFile(deviceid, 'player1Innings'),
  };
  writeVal(files.name, init.name ?? '');
  writeVal(files.playerName1, init.playerName1 ?? '');
  writeVal(files.playerName2, init.playerName2 ?? '');
  writeVal(files.p1Score, init.p1Score ?? '0');
  writeVal(files.p2Score, init.p2Score ?? '0');
  writeVal(files.nowPoint1, init.nowPoint1 ?? '0');
  writeVal(files.nowPoint2, init.nowPoint2 ?? '0');
  writeVal(files.player1Innings, init.player1Innings ?? '0');
  return files;
}

function cleanupOverlayFiles(overlayFiles) {
  if (!overlayFiles) return;
  Object.values(overlayFiles).forEach(p => {
    try { fs.existsSync(p) && fs.unlinkSync(p); } catch {}
  });
}

function countWorkers() {
  return Object.values(runningWorkers).filter(w => isAlive(w.proc)).length;
}

async function reportCount() {
  if (!REPORT_PUT_URL) return;
  try {
    const current = countWorkers();
    const res = await fetch(REPORT_PUT_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current })
    });
    if (!res.ok) throw new Error(`API status ${res.status}`);
    console.log(`[watchdog] reportCount OK: current=${current}`);
  } catch (e) {
    console.warn('[watchdog] reportCount failed:', e?.message || e);
  }
}

function buildFfmpegArgs({ rtmpIn, output_url, overlayFiles }) {
  const fontPath = config.fontPath;
  const filterComplex = [
    `[1:v]scale=329:117[overlay];`,
    `[2:v]scale=80:80[logo1];`,
    `[3:v]scale=80:80[logo2];`,
    `[4:v]scale=80:80[logo3];`,
    `[5:v]scale=320:100[bgwhite];`,
    `[0:v][overlay]overlay=45:30[tmp1];`,
    `[tmp1][bgwhite]overlay=W-w-0:0[tmpb];`,
    `[tmpb][logo1]overlay=W-w-10:10[tmp2];`,
    `[tmp2][logo2]overlay=W-w-110:10[tmp3];`,
    `[tmp3][logo3]overlay=W-w-220:10[vbase];`,
    `[vbase]` +
    `drawtext=fontfile='${fontPath}':textfile='${overlayFiles.name}':reload=1:x=70:y=42:fontsize=20:fontcolor=white,` +
    `drawtext=fontfile='${fontPath}':textfile='${overlayFiles.playerName1}':reload=1:x=90:y=82:fontsize=18:fontcolor=white,` +
    `drawtext=fontfile='${fontPath}':textfile='${overlayFiles.playerName2}':reload=1:x=90:y=120:fontsize=18:fontcolor=white,` +
    `drawtext=fontfile='${fontPath}':textfile='${overlayFiles.p1Score}':reload=1:x=290:y=82:fontsize=18:fontcolor=white,` +
    `drawtext=fontfile='${fontPath}':textfile='${overlayFiles.p2Score}':reload=1:x=290:y=120:fontsize=18:fontcolor=white,` +
    `drawtext=fontfile='${fontPath}':textfile='${overlayFiles.nowPoint1}':reload=1:x=335:y=82:fontsize=18:fontcolor=black,` +
    `drawtext=fontfile='${fontPath}':textfile='${overlayFiles.nowPoint2}':reload=1:x=335;y=120:fontsize=18:fontcolor=black,`.replace(';',':') + // tránh nhầm dấu ; thành :
    `drawtext=fontfile='${fontPath}':textfile='${overlayFiles.player1Innings}':reload=1:x=50:y=100:fontsize=20:fontcolor=white[vout]`
  ].join('');

  return [
    '-i', rtmpIn,
    '-i', config.imagePath,
    '-i', config.logo1Path,
    '-i', config.logo2Path,
    '-i', config.logo3Path,
    '-i', config.bgWhite,
    '-filter_complex', filterComplex,
    '-map', '[vout]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-c:a', 'copy',
    '-f', 'flv',
    output_url
  ];
}

async function forceKillFFmpeg(w, deviceid, reason = '') {
  return new Promise((resolve) => {
    if (!w || !w.proc || !w.proc.pid) return resolve('no-proc');
    const pid = w.proc.pid;
    let done = false;
    const finish = (msg) => { if (!done) { done = true; resolve(msg); } };

    console.log(`[${deviceid}] Killing FFmpeg (reason=${reason}) PID=${pid}`);

    w.proc.once('close', (code, signal) => {
      console.log(`[${deviceid}] FFmpeg closed code=${code} signal=${signal}`);
      finish('closed');
    });

    try { process.kill(-pid, 'SIGTERM'); } catch { try { w.proc.kill('SIGTERM'); } catch {} }

    setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL'); } catch { try { w.proc.kill('SIGKILL'); } catch {} }
    }, 2000);

    setTimeout(() => finish('timeout-wait-close'), 10000);
  });
}

async function killWorker(deviceid, reason) {
  const w = runningWorkers[deviceid];
  if (!w) return;
  await forceKillFFmpeg(w, deviceid, reason);
  cleanupOverlayFiles(w.overlayFiles);
  delete runningWorkers[deviceid];
  try { await socketService.stopSocket(deviceid); } catch {}
  setTimeout(() => { reportCount(); }, KILL_GRACE_MS);
}

// ========== Public APIs ==========
async function startLive({ deviceid, url, streamkey, overlayInit }) {
  if (runningWorkers[deviceid]) {
    return { message: 'Worker đã chạy!' };
  }
  const overlayFiles = createOverlayFiles(deviceid, overlayInit);

  // Cho socketService biết overlayFiles hiện tại của device
  config.getOverlayFiles = (id) => (runningWorkers[id]?.overlayFiles || overlayFiles);

  const rtmpIn = `${process.env.URL_INPUT_STREAM}${deviceid}`;
  const output_url = `${url.replace(/\/$/, '')}/${streamkey}`;
  const ffmpegArgs = buildFfmpegArgs({ rtmpIn, output_url, overlayFiles });

  console.log(`[${deviceid}] Spawn ffmpeg: ${ffmpegArgs.join(' ')}`);
  const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });

  runningWorkers[deviceid] = { proc: ffmpeg, output_url, overlayFiles, lastActivity: Date.now() };

  // Join socket để nhận điểm số và ghi overlay ngay
  try { await socketService.startSocket(deviceid); } catch (e) { console.warn(`[${deviceid}] startSocket error: ${e?.message||e}`); }

  ffmpeg.stdout.on('data', d => {
    const w = runningWorkers[deviceid];
    if (w) w.lastActivity = Date.now();
    console.log(`[${deviceid}] ${d}`);
  });
  ffmpeg.stderr.on('data', d => {
    const w = runningWorkers[deviceid];
    if (w) w.lastActivity = Date.now();
    console.log(`[${deviceid}] ${d}`);
  });
  ffmpeg.on('close', async code => {
    console.log(`[${deviceid}] FFmpeg exited (${code})`);
    cleanupOverlayFiles(overlayFiles);
    delete runningWorkers[deviceid];
    try { await socketService.stopSocket(deviceid); } catch {}
  });

  return { message: 'Đã start live!', ffmpegArgs };
}

function updateOverlay(deviceid, fields) {
  const w = runningWorkers[deviceid];
  if (!w) return false;
  const f = w.overlayFiles;
  const set = (k) => {
    if (typeof fields[k] !== 'undefined') writeVal(f[k], fields[k]);
  };
  ['name','playerName1','playerName2','p1Score','p2Score','nowPoint1','nowPoint2','player1Innings'].forEach(set);
  return true;
}

async function stopLive(deviceid) {
  const w = runningWorkers[deviceid];
  if (w) {
    try { w.proc.kill(); } catch {}
    cleanupOverlayFiles(w.overlayFiles);
    delete runningWorkers[deviceid];
    try { await socketService.stopSocket(deviceid); } catch {}
    return 'Worker stopped';
  }
  return 'Không có worker nào chạy cho deviceid này';
}

async function onDoneHook(deviceid) {
  const w = runningWorkers[deviceid];
  if (w) {
    await forceKillFFmpeg(w, deviceid, 'on_done');
    cleanupOverlayFiles(w.overlayFiles);
    delete runningWorkers[deviceid];
    try { await socketService.stopSocket(deviceid); } catch {}
  }
  else {
    console.warn(`[onDoneHook] Không có worker nào chạy cho deviceid ${deviceid}`);
  }
}

// --- Watchdog tick ---
async function watchdogTick() {
  const now = Date.now();
  for (const [deviceid, w] of Object.entries(runningWorkers)) {
    const alive   = isAlive(w.proc);
    const zombie  = alive && isZombie(w.proc.pid);
    const stalled = (now - (w.lastActivity || 0) > STALL_THRESHOLD_MS);

    console.log(`[watchdog] ${deviceid} alive=${alive} zombie=${zombie} stalled=${stalled} lastActiveAgo=${Math.round((now - (w.lastActivity||0))/1000)}s`);

    if (!alive) {
      console.log(`[watchdog] ${deviceid} not alive -> cleanup`);
      cleanupOverlayFiles(w.overlayFiles);
      delete runningWorkers[deviceid];
      try { await socketService.stopSocket(deviceid); } catch {}
      continue;
    }
    if (zombie)  { await killWorker(deviceid, 'zombie');  continue; }
    if (stalled) { await killWorker(deviceid, `stalled>${STALL_THRESHOLD_MS}ms`); continue; }
  }
}

module.exports = {
  setReportUrl,
  setCheckConfig,
  startLive,
  updateOverlay,
  stopLive,
  onDoneHook,
  reportCount,
  watchdogTick,
};
