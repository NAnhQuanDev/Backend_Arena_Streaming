const path = require('path');

module.exports = {
  fontPath: process.env.FONT_PATH || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  imagePath: path.join(__dirname, '..', 'resources', 'overlay.png'),
  logo1Path: path.join(__dirname, '..', 'resources', 'logo1.png'),
  logo2Path: path.join(__dirname, '..', 'resources', 'logo2.png'),
  logo3Path: path.join(__dirname, '..', 'resources', 'logo3.png'),
  bgWhite: path.join(__dirname, '..', 'resources', 'bg_white.png'),
};
