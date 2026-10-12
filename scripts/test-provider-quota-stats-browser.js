#!/usr/bin/env node
'use strict';
// 共用统计页面分工回归，覆盖总览、多维分析与按需历史详情。
process.env.BLORA_TEST_URL ||= 'http://127.0.0.1:18681';
process.env.BLORA_CDP_URL ||= 'http://127.0.0.1:18682';
require('./test-provider-quota-layout-browser');
