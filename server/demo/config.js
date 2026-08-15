const config = require('../config-loader');

const isDemo = config.demo === true;

module.exports = { isDemo };
