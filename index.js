const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const runningWorkers = {}; // matchid => {proc, output_url, overlayFiles, lastActivity}

// ---- Load config từ module JS, KHÔNG JSON.parse ----
const CONFIG_PATH = path.join(__dirname, 'config', 'config.js');
if (!fs.existsSync(CONFIG_PATH)) {
  throw new Error(`Missing config file: ${CONFIG_PATH}`);
}
const config = require(CONFIG_PATH); // <- quan trọng

// ===== Watchdog config =====
// ===== Watchdog config (đặt sát đầu file) =====
const CHECK_INTERVAL_MS  = Number(process.env.CHECK_INTERVAL_MS) || 30_000;   // 30s
const STALL_THRESHOLD_MS = Number(process.env.STALL_THRESHOLD_MS) || 180_000; // 3 phút
const KILL_GRACE_MS      = Number(process.env.KILL_GRACE_MS) || 10_000;
const REPORT_PUT_URL = 'https://api.arenabilliard.com/api/livestream-servers/update-live/stream5.arenabilliard.com?key=RNvVyXcyyPVjcpF9QJC2RLXrsc5s2mcF';


function tmpTextFile(matchid, key) {
  return `/tmp/${matchid}_${key}.txt`;
}

function writeVal(filePath, val) {
  fs.writeFileSync(filePath, String(val ?? ''), 'utf8');
}

function createOverlayFiles(matchid, init = {}) {
  const files = {
    name: tmpTextFile(matchid, 'name'),
    playerName1: tmpTextFile(matchid, 'playerName1'),
    playerName2: tmpTextFile(matchid, 'playerName2'),
    p1Score: tmpTextFile(matchid, 'p1Score'),
    p2Score: tmpTextFile(matchid, 'p2Score'),
    nowPoint1: tmpTextFile(matchid, 'nowPoint1'),
    nowPoint2: tmpTextFile(matchid, 'nowPoint2'),
    player1Innings: tmpTextFile(matchid, 'player1Innings'),
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

// ===== Helpers cho watchdog =====
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
    // EPERM: không có quyền gửi tín hiệu nhưng process có tồn tại
    if (e && e.code === 'EPERM') return true;
    return false; // ESRCH -> không tồn tại
  }
}

function countWorkers() {
  return Object.values(runningWorkers).filter(w => isAlive(w.proc)).length;
}

async function reportCount() {
  try {
    const activeCount = countWorkers();
    const res = await fetch(REPORT_PUT_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current: activeCount })
    });
    if (!res.ok) throw new Error(`API status ${res.status}`);
    console.log(`[watchdog] reportCount OK: current=${activeCount}`);
  } catch (e) {
    console.warn('[watchdog] reportCount failed:', e?.message || e);
  }
}


async function killWorker(matchid, reason) {
  const w = runningWorkers[matchid];
  if (!w) return;
  await forceKillFFmpeg(w, matchid, reason);
  cleanupOverlayFiles(w.overlayFiles);
  delete runningWorkers[matchid];
  setTimeout(() => { reportCount(); }, KILL_GRACE_MS);
}



// ========== 1) START LIVE ==========
app.post('/startlive', (req, res) => {
  const { matchid, url, streamkey, ...overlayInit } = req.body;
  if (!matchid || !url || !streamkey) {
    return res.status(400).json({ error: 'Thiếu tham số matchid/url/streamkey' });
  }
  if (runningWorkers[matchid]) {
    return res.json({ message: 'Worker đã chạy!' });
  }

  // Tạo file text overlay trong /tmp
  const overlayFiles = createOverlayFiles(matchid, overlayInit);

  const rtmpIn = `rtmp://localhost:1935/live/${matchid}`;
  const output_url = `${url.replace(/\/$/, '')}/${streamkey}`;
  const fontPath = config.fontPath;

  // filter_complex như ffmpeg2 (scale/overlay ảnh + nhiều drawtext)
  // QUAN TRỌNG: bọc path bằng nháy đơn để tránh lỗi khi có khoảng trắng
  const filterComplex =
    [
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
      `drawtext=fontfile='${fontPath}':textfile='${overlayFiles.nowPoint2}':reload=1:x=335:y=120:fontsize=18:fontcolor=black,` +
      `drawtext=fontfile='${fontPath}':textfile='${overlayFiles.player1Innings}':reload=1:x=50:y=100:fontsize=20:fontcolor=white[vout]`
    ].join('');

  const ffmpegArgs = [
    // INPUT (1 stream + 5 ảnh)
    '-i', rtmpIn,               // [0:v][0:a]
    '-i', config.imagePath,     // [1:v]
    '-i', config.logo1Path,     // [2:v]
    '-i', config.logo2Path,     // [3:v]
    '-i', config.logo3Path,     // [4:v]
    '-i', config.bgWhite,       // [5:v]

    // FILTER
    '-filter_complex', filterComplex,

    // MAP video filter output + audio input
    '-map', '[vout]',
    '-map', '0:a?',

    // Encoder/packager
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-c:a', 'copy',
    '-f', 'flv',
    output_url
  ];

  console.log(`[${matchid}] Spawn ffmpeg: ${ffmpegArgs.join(' ')}`);
  const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });

  // === theo dõi hoạt động (để watchdog biết treo) ===
  runningWorkers[matchid] = { proc: ffmpeg, output_url, overlayFiles, lastActivity: Date.now() };

  ffmpeg.stdout.on('data', d => {
    const w = runningWorkers[matchid];
    if (w) w.lastActivity = Date.now();
    console.log(`[${matchid}] ${d}`);
  });

  ffmpeg.stderr.on('data', d => {
    const w = runningWorkers[matchid];
    if (w) w.lastActivity = Date.now();
    console.log(`[${matchid}] ${d}`);
  });

  ffmpeg.on('close', code => {
    console.log(`[${matchid}] FFmpeg exited (${code})`);
    cleanupOverlayFiles(overlayFiles);
    delete runningWorkers[matchid];
  });

  res.json({ message: 'Đã start live!', ffmpegArgs });
});

// ========== 2) UPDATE OVERLAY ==========
app.post('/updateoverlay', (req, res) => {
  const { matchid, ...fields } = req.body;
  if (!matchid) return res.status(400).json({ error: 'Thiếu matchid' });
  const w = runningWorkers[matchid];
  if (!w) return res.status(404).json({ error: 'Chưa có worker cho matchid này' });

  const f = w.overlayFiles;
  const set = (k) => {
    if (typeof fields[k] !== 'undefined') writeVal(f[k], fields[k]);
  };
  ['name','playerName1','playerName2','p1Score','p2Score','nowPoint1','nowPoint2','player1Innings'].forEach(set);

  res.json({ message: 'Overlay updated!' });
});

// ========== 3) STOP LIVE ==========
app.post('/stoplive', (req, res) => {
  const { matchid } = req.body;
  if (!matchid) return res.status(400).json({ error: 'Thiếu matchid' });
  const w = runningWorkers[matchid];
  if (w) {
    w.proc.kill();
    cleanupOverlayFiles(w.overlayFiles);
    delete runningWorkers[matchid];
    res.json({ message: 'Worker stopped' });
  } else {
    res.json({ message: 'Không có worker nào chạy cho matchid này' });
  }
});

// ========== 4) WEBHOOK on_done ==========
app.post('/hook/on_done', async (req, res) => {
  const matchid = req.body.name;
  const w = runningWorkers[matchid];
  if (w) {
    await forceKillFFmpeg(w, matchid, 'on_done');
    cleanupOverlayFiles(w.overlayFiles);
    delete runningWorkers[matchid];
  }
  res.end();
});




function forceKillFFmpeg(w, matchid, reason = '') {
  // ❗ KHÔNG return sớm nếu !isAlive — cứ gửi tín hiệu group
  return new Promise((resolve) => {
    if (!w || !w.proc || !w.proc.pid) return resolve('no-proc');
    const pid = w.proc.pid;
    let done = false;
    const finish = (msg) => { if (!done) { done = true; resolve(msg); } };

    console.log(`[${matchid}] Killing FFmpeg (reason=${reason}) PID=${pid}`);

    w.proc.once('close', (code, signal) => {
      console.log(`[${matchid}] FFmpeg closed code=${code} signal=${signal}`);
      finish('closed');
    });

    // TERM cả group (PID âm), fallback PID đơn
    try { process.kill(-pid, 'SIGTERM'); } catch { try { w.proc.kill('SIGTERM'); } catch {} }

    setTimeout(() => {
      // Nếu vẫn chưa close thì KILL cả group
      try { process.kill(-pid, 'SIGKILL'); } catch { try { w.proc.kill('SIGKILL'); } catch {} }
    }, 2000);

    // Safety timeout nếu không nhận 'close'
    setTimeout(() => finish('timeout-wait-close'), 10000);
  });
}


// ===== Global watchdog: quét mỗi 5 phút, kill nếu zombie hoặc treo > 3 phút =====
setInterval(() => {
  const now = Date.now();
  Object.entries(runningWorkers).forEach(async ([matchid, w]) => {
    const alive   = isAlive(w.proc);
    const zombie  = alive && isZombie(w.proc.pid);
    const stalled = (now - (w.lastActivity || 0) > STALL_THRESHOLD_MS);

    console.log(`[watchdog] ${matchid} alive=${alive} zombie=${zombie} stalled=${stalled} lastActiveAgo=${Math.round((now - (w.lastActivity||0))/1000)}s`);

    if (!alive) {
      // process đã chết: dọn cho sạch map để không “ảo giác”
      console.log(`[watchdog] ${matchid} not alive -> cleanup`);
      cleanupOverlayFiles(w.overlayFiles);
      delete runningWorkers[matchid];
      return;
    }
    if (zombie) { await killWorker(matchid, 'zombie'); return; }
    if (stalled){ await killWorker(matchid, `stalled>${STALL_THRESHOLD_MS}ms`); return; }
  });
  reportCount();
}, CHECK_INTERVAL_MS);


app.listen(3001, () => console.log('Livestream Controller API running at 3001'));