const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
require('dotenv').config(); 

const liveRoutes = require('./routes/live');
const { reportCount, watchdogTick, setReportUrl, setCheckConfig } = require('./services/workerManager.js');

// ✨ WebSocket
const { initServerSocket, sendToDevice } = require('./websocket/websocketServer.js');

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
  process.env.REPORT_URL 
)

// --- Routes ---
app.use('/api', liveRoutes);


// --- Global watchdog loop ---
setInterval(() => {
  watchdogTick().catch(()=>{});
  reportCount().catch(()=>{});
}, CHECK_INTERVAL_MS);

// 🚀 DÙNG HTTP SERVER ĐỂ GẮN WS
const PORT = Number(process.env.PORT);
const server = http.createServer(app);

// Khởi tạo WebSocket trên cùng cổng
initServerSocket(server);

server.listen(PORT, () => {
  console.log(`Livestream Controller API + WS running at ${PORT}`);
  console.log(`WebSocket endpoint: ws://<host>:${PORT}/ws/:deviceId  hoặc  /ws?deviceId=...`);
});