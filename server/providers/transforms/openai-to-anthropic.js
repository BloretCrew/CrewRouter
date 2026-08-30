'use strict';

const { createBridge } = require('../../protocol');

module.exports = createBridge('openai', 'anthropic');
