const express = require('express');
const router = express.Router();
const {
  startLive,
  updateOverlay,
  stopLive,
  onDoneHook
} = require('../services/workerManager.js');

// 1) START LIVE
router.post('/startlive', async (req, res) => {
  try {
    const { deviceid, url, streamkey, ...overlayInit } = req.body;
    if (!deviceid || !url || !streamkey) {
      return res.status(400).json({ error: 'Thiếu tham số deviceid/url/streamkey' });
    }
    const out = await startLive({ deviceid, url, streamkey, overlayInit });
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// 2) UPDATE OVERLAY
router.post('/updateoverlay', (req, res) => {
  const { deviceid, ...fields } = req.body;
  if (!deviceid) return res.status(400).json({ error: 'Thiếu deviceid' });
  const ok = updateOverlay(deviceid, fields);
  if (!ok) return res.status(404).json({ error: 'Chưa có worker cho deviceid này' });
  return res.json({ message: 'Overlay updated!' });
});

// 3) STOP LIVE
router.post('/stoplive', (req, res) => {
  const { deviceid } = req.body;
  if (!deviceid) return res.status(400).json({ error: 'Thiếu deviceid' });
  const msg = stopLive(deviceid);
  return res.json({ message: msg });
});

// 4) WEBHOOK on_done
router.post('/hook/on_done', async (req, res) => {
  const deviceid = req.body.name;
  await onDoneHook(deviceid);
  res.end();
});

module.exports = router;
