'use strict';
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const crypto = require('node:crypto');
process.env.CRW_MASTER_KEY='quota-cycle-integration-test-only';
const history=require('../utils/provider-quota-history');
const capture=require('../utils/request-quota-capture');
const cycle=require('../utils/quota-cycle-analysis');
async function main(){
  const raw=process.env.QUOTA_TEST_DATABASE_URL;assert(raw,'需要隔离数据库连接');
  const url=new URL(raw);assert(['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname.startsWith('/crewrouter_quota_test'));
  const schema=`request_cycle_integration_${process.pid}`, admin=new Pool({connectionString:raw});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db=new Pool({connectionString:raw,options:`-c search_path=${schema} -c timezone=Asia/Shanghai`});
  try{
    await db.query(`CREATE TABLE providers(id TEXT PRIMARY KEY,name TEXT,quota_mode TEXT,quota_enabled BOOLEAN,enabled BOOLEAN,
      base_url TEXT,api_key TEXT,api_keys JSONB,quota_script TEXT,quota_last_result JSONB,quota_last_checked_at TIMESTAMPTZ,quota_last_ok BOOLEAN,quota_last_error TEXT);
      CREATE TABLE settings(key TEXT PRIMARY KEY,value JSONB);
      CREATE TABLE users(id INT PRIMARY KEY,username TEXT,team_id INT);
      CREATE TABLE teams(id INT PRIMARY KEY,name TEXT,hide_provider_quota BOOLEAN);
      CREATE TABLE models(id TEXT PRIMARY KEY,name TEXT,provider TEXT,enabled BOOLEAN);
      CREATE TABLE team_models(team_id INT,model_id TEXT); CREATE TABLE user_teams(user_id INT,team_id INT);`);
    await history.ensureQuotaHistorySchema(db);await capture.ensureRequestQuotaSchema(db);await cycle.ensureQuotaCycleSchema(db);
    const provider={id:'p',name:'周期供应商',quota_mode:'script',quota_enabled:true,enabled:true,base_url:'https://example.invalid',api_key:'integration-key-private',quota_script:''};
    await db.query('INSERT INTO providers(id,name,quota_mode,quota_enabled,enabled,base_url,api_key,quota_script) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',Object.values(provider));
    await db.query(`INSERT INTO users VALUES(1,'用户一',1),(2,'用户二',1);INSERT INTO teams VALUES(1,'测试Team',FALSE);
      INSERT INTO models VALUES('m','测试模型','p',TRUE);INSERT INTO team_models VALUES(1,'m');INSERT INTO user_teams VALUES(1,1),(2,1);`);
    const initial=new Date(Date.now()-120000);const t=seconds=>new Date(initial.getTime()+seconds*1000).toISOString();
    const observe=async(percent,time)=>{
      const result=history.attachQuotaBatch({ok:true,quota:{unit:'percent',periods:[{key:'weekly',percent,resetsAt:new Date(initial.getTime()+86400000).toISOString()}]}},provider,{batchId:crypto.randomUUID(),checkedAt:time,completedAt:time});
      return history.recordQuotaHistory(db,provider,result,{partialAccounts:true,updateSnapshot:false});
    };
    await observe(0,t(0));
    const logical=crypto.randomUUID();
    const a=await capture.beginAttempt({logical_request_id:logical,user_id:1,team_id:1,model:'m',source:'codex',project_id:'/repo',session_id:'s',started_at:t(1)},provider,provider.api_key,{pool:db});
    const b=await capture.beginAttempt({user_id:2,team_id:1,model:'m',source:'claude_code',started_at:t(2)},provider,provider.api_key,{pool:db});
    await capture.endAttempt(a,{status:'success',ended_at:t(9),input_tokens:80,output_tokens:20,total_tokens:100,weighted_tokens:100,points:'0.1',usage_quality:'actual'},{pool:db});
    await capture.endAttempt(b,{status:'failed',ended_at:t(12),total_tokens:20,usage_quality:'estimated'},{pool:db});
    await observe(0,t(5));await observe(50,t(15));await observe(100,t(20));
    await cycle.reconcileCycles(db,{now:t(100),reconciliationSeconds:60});
    const range={start:initial.toISOString().slice(0,10),end:new Date().toISOString().slice(0,10)};
    const list=await cycle.queryQuotaCycles(db,range);assert.equal(list.total,1);
    const id=list.rows[0].id;
    const report=await cycle.queryQuotaCycle(db,id,range);
    assert.equal(report.summary.attempts,2);assert.equal(report.summary.total_tokens,120);
    assert.equal(report.summary.input_tokens,80);assert.equal(Number(report.summary.points),0.1);
    assert.equal(report.dimensions.user.length,2);
    assert.equal((await cycle.queryQuotaCycle(db,id,range,'user',1)).summary.total_tokens,100);
    const requests=await cycle.queryQuotaRequests(db,id,{...range,limit:1},'user',1);assert.equal(requests.total,1);
    assert(!JSON.stringify(requests).includes(provider.api_key));
    assert.equal(requests.rows[0].snapshot.user_id,1);
    const express=require('express');
    const app=express();const router=express.Router();
    cycle.registerQuotaCycleRoutes(router,db,[(req,res,next)=>{req.session={user:{id:1}};next();}],'user');app.use('/api/user',router);
    const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
    try {
      const base=`http://127.0.0.1:${server.address().port}/api/user/stats/provider-quota/cycles`;
      const suffix=`?start=${range.start}&end=${range.end}`;
      const response=await fetch(`${base}/${id}${suffix}`);assert.equal(response.status,200);
      const payload=await response.json();assert.equal(payload.summary.total_tokens,100);
      assert.equal(payload.dimensions.user.length,1);
      const requestResponse=await fetch(`${base}/${id}/requests${suffix}&limit=1`);assert.equal(requestResponse.status,200);
      assert.equal((await requestResponse.json()).rows[0].snapshot.user_id,1);
      const exportResponse=await fetch(`${base}/${id}/export${suffix}`);assert.equal(exportResponse.status,200);
      assert(!JSON.stringify(await exportResponse.json()).includes(provider.api_key));
      assert.equal((await fetch(`${base}/${crypto.randomUUID()}${suffix}`)).status,404);
      assert.equal((await fetch(`${base}/${id}${suffix}&user_id=2`)).status,400);
      await db.query('UPDATE teams SET hide_provider_quota=TRUE');
      assert.equal((await fetch(`${base}/${id}${suffix}`)).status,404);
      await db.query('UPDATE teams SET hide_provider_quota=FALSE');
    } finally { await new Promise(resolve=>server.close(resolve)); }

    const before=(await db.query('SELECT COUNT(*)::int AS n FROM quota_cycle_reports')).rows[0].n;
    await cycle.reconcileCycles(db,{now:t(101),reconciliationSeconds:60});
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM quota_cycle_reports')).rows[0].n,before,'无变化对账不生成版本');
    await capture.endAttempt(a,{status:'success',points:'0.2',usage_quality:'actual'},{pool:db});
    await cycle.reconcileCycles(db,{now:t(102),reconciliationSeconds:60});
    assert.equal(Number((await cycle.queryQuotaCycle(db,id,range)).summary.points),0.2,'计费更正同步报告');
    await db.query('UPDATE teams SET hide_provider_quota=TRUE');
    await assert.rejects(cycle.queryQuotaCycle(db,id,range,'user',1),/无权限|范围/);
    await db.query('UPDATE teams SET hide_provider_quota=FALSE');
    await db.query("UPDATE quota_capture_jobs SET status='unsupported',error='test_no_live_query'");
    await db.query("UPDATE provider_quota_observations SET checked_at=NOW()-INTERVAL '200 days'");
    await history.cleanupQuotaHistory(db,90);
    assert.equal((await cycle.queryQuotaCycle(db,id,range)).summary.total_tokens,120);
    assert.equal((await cycle.queryQuotaRequests(db,id,range,'user',1)).total,1);
    console.log('PASS request → normalized observations → intervals → user reports → cost correction → permissions → retention integration');
  }finally{await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
