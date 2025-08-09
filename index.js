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
const CHECK_INTERVAL_MS   = 5 * 60 * 1000;  // 5 phút/lần quét
const STALL_THRESHOLD_MS  = 3 * 60 * 1000;  // treo nếu >3 phút không có activity
const KILL_GRACE_MS       = 10 * 1000;      // đợi 10s sau khi kill mới report
const REPORT_URL          = (config && config.reportUrl) || 'http://127.0.0.1:4000/ffmpeg/report'; // API mẫu

// fetch (Node 18+ có sẵn)
const hasNativeFetch = typeof fetch === 'function';
async function httpPostJson(url, payload) {
  if (hasNativeFetch) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  } else {
    // fallback nhẹ nếu Node <18
    const http = url.startsWith('https') ? require('https') : require('http');
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(payload);
      const u = new URL(url);
      const req = http.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + (u.search || ''),
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
      }, res => { res.on('data', ()=>{}); res.on('end', ()=>resolve()); });
      req.on('error', reject);
      req.write(data); req.end();
    });
  }
}

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
  try { return proc && proc.pid && process.kill(proc.pid, 0) === undefined; }
  catch { return false; }
}

function countWorkers() {
  return Object.values(runningWorkers).filter(w => isAlive(w.proc)).length;
}

async function reportCount() {
  try {
    const body = { active_count: countWorkers(), ts: new Date().toISOString() };
    await httpPostJson(REPORT_URL, body);
  } catch (e) {
    console.warn('[watchdog] reportCount failed:', e?.message || e);
  }
}

function killWorker(matchid, reason = 'unknown') {
  const w = runningWorkers[matchid];
  if (!w || !isAlive(w.proc)) return;

  console.warn(`[${matchid}] Watchdog: killing FFmpeg (reason=${reason}) pid=${w.proc.pid}`);
  try { w.proc.kill('SIGKILL'); } catch {}
  // Cleanup & xóa worker vẫn theo on('close') như logic cũ
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
  const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

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
app.post('/hook/on_done', (req, res) => {
  const matchid = req.body.name;
  const w = runningWorkers[matchid];
  if (w) {
    w.proc.kill();
    cleanupOverlayFiles(w.overlayFiles);
    delete runningWorkers[matchid];
    console.log(`[${matchid}] FFmpeg auto-killed by on_done`);
  }
  res.end();
});

// ===== Global watchdog: quét mỗi 5 phút, kill nếu zombie hoặc treo > 3 phút =====
setInterval(() => {
  const now = Date.now();

  Object.entries(runningWorkers).forEach(([matchid, w]) => {
    const proc = w.proc;
    const alive = isAlive(proc);
    const zombie = alive && isZombie(proc.pid);
    const stalled = alive && (now - (w.lastActivity || 0) > STALL_THRESHOLD_MS);

    // ✅ Log trạng thái mỗi lần quét
    console.log(`[watchdog] ${matchid} alive=${alive} zombie=${zombie} stalled=${stalled} lastActiveAgo=${Math.round((now - w.lastActivity)/1000)}s`);

    if (!alive) return;          // đã thoát, on('close') sẽ dọn
    if (zombie) { killWorker(matchid, 'zombie'); return; }
    if (stalled){ killWorker(matchid, `stalled>${STALL_THRESHOLD_MS}ms`); return; }
  });
}, CHECK_INTERVAL_MS);

app.listen(3001, () => console.log('Livestream Controller API running at 3001'));
