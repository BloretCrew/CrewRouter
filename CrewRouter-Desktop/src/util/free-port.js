'use strict';

const net = require('node:net');

function findFreePort(host = '127.0.0.1', netModule = net) {
  return new Promise((resolve, reject) => {
    const server = netModule.createServer();
    server.once('error', reject);
    server.listen({ host, port: 0 }, () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

module.exports = { findFreePort };
