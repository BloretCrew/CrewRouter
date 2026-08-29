'use strict';
const express = require('express');
const router = express.Router();

router.get('/overview', (req, res) => res.json({
  summary: { totalReports: 128, totalInstances: 6, totalRequests: 486200, totalTokens: 1820000000, totalCost: 628.42, updatedAt: new Date().toISOString() },
  instances: [
    { deviceId: 'demo-macbook', domain: 'router.example.com', version: '1.8.0', reportsCount: 42, requests: 182000, tokens: 690000000, cost: 238.4, lastWindowEnd: new Date().toISOString(), lastReportAt: new Date().toISOString() },
    { deviceId: 'demo-linux-ci', domain: 'ci.example.com', version: '1.7.3', reportsCount: 31, requests: 124000, tokens: 480000000, cost: 164.2, lastWindowEnd: new Date(Date.now() - 3600000).toISOString(), lastReportAt: new Date(Date.now() - 3600000).toISOString() },
    { deviceId: 'demo-team', domain: 'team.example.com', version: '1.8.0', reportsCount: 55, requests: 180200, tokens: 640000000, cost: 225.82, lastWindowEnd: new Date(Date.now() - 7200000).toISOString(), lastReportAt: new Date(Date.now() - 7200000).toISOString() },
  ],
  recent: [
    { deviceId: 'demo-macbook', domain: 'router.example.com', version: '1.8.0', generatedAt: new Date().toISOString(), windowStart: new Date(Date.now() - 3600000).toISOString(), windowEnd: new Date().toISOString(), stats: { requests: { total: 4200 }, tokens: { total: 16000000 }, cost: 5.42, activeUsers: 12, activeKeys: 6, requestTypes: { chat: 3200, responses: 700, playground: 300 } } },
    { deviceId: 'demo-linux-ci', domain: 'ci.example.com', version: '1.7.3', generatedAt: new Date(Date.now() - 3600000).toISOString(), windowStart: new Date(Date.now() - 7200000).toISOString(), windowEnd: new Date(Date.now() - 3600000).toISOString(), stats: { requests: { total: 3100 }, tokens: { total: 11200000 }, cost: 3.98, activeUsers: 5, activeKeys: 3, requestTypes: { chat: 2700, fusion: 400 } } },
  ],
}));
router.post('/', (req, res) => res.json({ success: true }));
module.exports = router;
