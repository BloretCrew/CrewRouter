const crypto = require('crypto');

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

module.exports = { sha256Hex };
