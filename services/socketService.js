// services/socketService.js
const ioClient = require("socket.io-client");
const fs = require("fs").promises;
const logger = require("../utils/logger");
const config = require("../config/config");
const { createDebounce, clearDebounce } = require("../utils/debounce");

// deviceId -> socket
const sockets = new Map();
// deviceId -> last JSON stringified scoreData
const scoreDataCache = new Map();

let ioInstance = null; // optional, nếu muốn set từ ngoài
const setIo = (io) => { ioInstance = io; };

/**
 * Lấy 3 từ cuối (nếu tên quá dài), để overlay gọn.
 */
function getLastThreeWords(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return "Player";
  const words = trimmed.split(/\s+/);
  return words.length > 3 ? words.slice(-3).join(" ") : trimmed;
}

/**
 * Ghi overlay theo scoreData
 */
async function writeOverlay(deviceId, scoreData) {
  console.log(`Writing overlay for [${deviceId}] with data:`, scoreData);
  const overlayFiles = config.getOverlayFiles(deviceId); // shim trong workerManager
  if (!overlayFiles) {
    logger.warn(`No overlayFiles mapping for [${deviceId}]`);
    return;
  }

  // cache tránh ghi nếu không đổi
  const cacheKey = JSON.stringify(scoreData || {});
  if (scoreDataCache.get(deviceId) === cacheKey) {
    logger.info(`No score change for [${deviceId}] — skip write`);
    return;
  }
  scoreDataCache.set(deviceId, cacheKey);

  // format + pad
  const s = (v, pad2 = true) => {
    const str = (v ?? "0").toString();
    return pad2 && str.length <= 2 ? ` ${str}` : str;
  };

  const name =
  !scoreData?.name || scoreData.name === "null"
    ? "Arena"
    : scoreData.name.toString();
  const p1Score = s(scoreData?.player1Score);
  const p2Score = s(scoreData?.player2Score);
  const nowPoint1 = s(scoreData?.nowPoint1);
  const nowPoint2 = s(scoreData?.nowPoint2);
  const player1Innings = s(scoreData?.player1Innings);

  const playerName1 = getLastThreeWords(scoreData?.player1Name);
  const playerName2 = getLastThreeWords(scoreData?.player2Name);

  await Promise.all([
    fs.writeFile(overlayFiles.playerName1, playerName1),
    fs.writeFile(overlayFiles.playerName2, playerName2),
    fs.writeFile(overlayFiles.p1Score, p1Score),
    fs.writeFile(overlayFiles.p2Score, p2Score),
    fs.writeFile(overlayFiles.nowPoint1, nowPoint1),
    fs.writeFile(overlayFiles.nowPoint2, nowPoint2),
    fs.writeFile(overlayFiles.name, name),
    fs.writeFile(overlayFiles.player1Innings, player1Innings),
  ]);

  logger.info(`Overlay updated for [${deviceId}]`);
}

/**
 * Tạo & giữ debounce writer cho từng device
 */
function getDebouncedWriter(deviceId) {
  return createDebounce(deviceId, async (scoreData) => {
    try {
      await writeOverlay(deviceId, scoreData);
    } catch (err) {
      logger.error(`Overlay write error [${deviceId}]: ${err.message}`);
    }
  });
}

function startSocket(deviceId) {
  return new Promise((resolve, reject) => {
    try {
      // nếu đã có thì trả về luôn
      if (sockets.has(deviceId)) {
        logger.info(`Socket already running for [${deviceId}]`);
        return resolve(sockets.get(deviceId));
      }

      const socket = ioClient(config.socketUrl, {
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 5000,
      });

      socket.on("connect", () => {
        logger.info(`Socket connected [${deviceId}]`);
        socket.emit("join_device", { deviceId }, () => {
          logger.info(`Joined device room [${deviceId}]`);
        });
        sockets.set(deviceId, socket);
        resolve(socket);
      });

      const debouncedWrite = getDebouncedWriter(deviceId);

      socket.on("message", async (msg) => {
        logger.info(
          `Socket message [${deviceId}]: action=${msg?.action || "unknown"}, ts=${msg?.timestamp || "unknown"}`
        );

        if (msg?.action === "MATCH_CHANGE" && msg?.scoreData) {
          debouncedWrite(msg.scoreData);
        }
      });

      socket.on("connect_error", (error) => {
        logger.error(`Socket connect error [${deviceId}]: ${error.message}`);
      });

      socket.on("disconnect", () => {
        logger.info(`Socket disconnected [${deviceId}]`);
      });
    } catch (error) {
      logger.error(`Socket start error [${deviceId}]: ${error.message}`);
      reject(error);
    }
  });
}

function stopSocket(deviceId) {
  return new Promise((resolve, reject) => {
    const socket = sockets.get(deviceId);
    if (!socket) {
      return reject(new Error(`Socket not found for [${deviceId}]`));
    }
    try {
      socket.disconnect();
    } catch {}
    sockets.delete(deviceId);
    scoreDataCache.delete(deviceId);
    clearDebounce(deviceId);
    logger.info(`Socket stopped [${deviceId}]`);
    resolve();
  });
}

module.exports = { startSocket, stopSocket, setIo };
