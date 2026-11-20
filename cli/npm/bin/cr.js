#!/usr/bin/env node
'use strict';

const { dispatch } = require('../index');

dispatch().then(code => { process.exitCode = code || 0; }).catch(error => {
  process.stderr.write(`cr: ${error && error.message ? error.message : error}\n`);
  process.exitCode = 1;
});
