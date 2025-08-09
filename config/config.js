const path = require('path');

module.exports = {
  // Font DejaVu phổ biến trên Debian/Ubuntu (đổi nếu server bạn khác)
  fontPath: process.env.FONT_PATH || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  socketUrl: 'https://api.arenabilliard.com', 
  socketToken: null, 
  getOverlayFiles: (deviceid) => {
    throw new Error('getOverlayFiles chưa được gán từ workerManager');
  },
  fontPath: path.join(__dirname, '..', 'assets', 'arial.ttf'),

    // Watchdog config mặc định (có thể set lại qua workerManager.setCheckConfig)
  CHECK_INTERVAL_MS: 60_000,
  STALL_THRESHOLD_MS: 180_000,
  KILL_GRACE_MS: 10_000,


  // Trỏ trực tiếp tới thư mục resources trong project
  imagePath: path.join(__dirname, '..', 'resources', 'overlay.png'),
  logo1Path: path.join(__dirname, '..', 'resources', 'logo1.png'),
  logo2Path: path.join(__dirname, '..', 'resources', 'logo2.png'),
  logo3Path: path.join(__dirname, '..', 'resources', 'logo3.png'),
  bgWhite: path.join(__dirname, '..', 'resources', 'bg_white.png'),
};
