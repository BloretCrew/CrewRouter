const configCenter = require('../config-center');

const isDemo = configCenter.get('demo', false) === true;

module.exports = { isDemo };
