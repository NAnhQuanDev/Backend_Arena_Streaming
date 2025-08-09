const express = require('express');
const path = require('path');
const fs = require('fs');

const liveRoutes = require('./routes/live');
const { reportCount, watchdogTick, setReportUrl, setCheckConfig } = require('./services/workerManager.js');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- Load config ---
const CONFIG_PATH = path.join(__dirname, 'config', 'config.js');
if (!fs.existsSync(CONFIG_PATH)) {
  throw new Error(`Missing config file: ${CONFIG_PATH}`);
}
require(CONFIG_PATH); // chỉ cần require để các service dùng

// --- Watchdog & report config ---
const CHECK_INTERVAL_MS  = Number(process.env.CHECK_INTERVAL_MS)  || 60_000;
const STALL_THRESHOLD_MS = Number(process.env.STALL_THRESHOLD_MS) || 180_000;
const KILL_GRACE_MS      = Number(process.env.KILL_GRACE_MS)      || 10_000;

setCheckConfig({ CHECK_INTERVAL_MS, STALL_THRESHOLD_MS, KILL_GRACE_MS });

setReportUrl(
  'https://api.arenabilliard.com/api/livestream-servers/update-live/stream5.arenabilliard.com?key=RNvVyXcyyPVjcpF9QJC2RLXrsc5s2mcF'
);

// --- Routes ---
app.use('/', liveRoutes);

// --- Global watchdog loop ---
setInterval(() => {
  watchdogTick().catch(()=>{});
  reportCount().catch(()=>{});
}, CHECK_INTERVAL_MS);

app.listen(3001, () => console.log('Livestream Controller API running at 3001'));
