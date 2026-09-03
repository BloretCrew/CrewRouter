'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

const EXPECTED_VERSION = '2.0.8';
const packageJsonPath = require.resolve('@bloret-crew/blora-design/package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
if (packageJson.version !== EXPECTED_VERSION) {
  throw new Error(`Unsupported @bloret-crew/blora-design version: ${packageJson.version}`);
}
if (packageJson.exports?.['./auto']?.import !== './dist/auto.js') {
  throw new Error('Blora ./auto export does not point to ./dist/auto.js');
}
const distDir = path.join(path.dirname(packageJsonPath), 'dist');

function createBloraResourceRouter() {
  const router = express.Router();
  router.use((req, res, next) => {
    const requestPath = decodeURIComponent(req.path || '/');
    if (requestPath.includes('\0') || requestPath.includes('..') || requestPath.startsWith('/.')) {
      return res.status(404).type('text/plain').send('Not Found');
    }
    const file = path.resolve(distDir, `.${requestPath}`);
    if (file !== distDir && !file.startsWith(`${distDir}${path.sep}`)) return res.status(404).type('text/plain').send('Not Found');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return res.status(404).type('text/plain').send('Not Found');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    return res.sendFile(path.basename(file), { root: distDir, dotfiles: 'deny' }, (error) => {
      if (error && !res.headersSent) res.status(error.statusCode || 404).type('text/plain').send('Not Found');
    });
  });
  return router;
}

module.exports = { EXPECTED_VERSION, packageJson, distDir, createBloraResourceRouter };
