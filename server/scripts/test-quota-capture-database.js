'use strict';
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require.resolve('../utils/quota-capture-database'),'utf8');
const configs=[];
class Pool { constructor(options){configs.push(options);}on(){}async end(){this.closed=true;} }
const moduleMock={exports:{}};
vm.runInNewContext(source,{module:moduleMock,require:name=>name==='../config-loader'?{database:{host:'local',port:1,name:'test',user:'test',password:'not-real'}}:name==='pg'?{Pool}:{warn(){}}});
const {getQuotaCapturePool,closeQuotaCapturePool}=moduleMock.exports;
const pool=getQuotaCapturePool();assert.equal(pool,getQuotaCapturePool());assert.equal(configs.length,1);
assert.equal(configs[0].max,4);assert.equal(configs[0].connectionTimeoutMillis,1000);assert.equal(configs[0].query_timeout,5000);
assert.match(configs[0].options,/statement_timeout=5000/);assert.match(configs[0].options,/lock_timeout=2000/);
closeQuotaCapturePool().then(()=>{assert(pool.closed);console.log('PASS isolated capture pool: lazy, max4, bounded connection/statement/lock waits, close');});
