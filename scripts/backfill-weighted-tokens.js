'use strict';
const path = require('path');
const cfg = require('../config.json');
const { Pool } = require('pg');
const { calculateCost } = require('../server/utils/billing');
const pool = new Pool({
  host: cfg.database.host, port: cfg.database.port, database: cfg.database.name,
  user: cfg.database.user, password: cfg.database.password,
  options: '-c timezone=Asia/Shanghai'
});
async function backfill(dryRun){
  const models = await pool.query('SELECT id, model_multiplier FROM models');
  const multMap = new Map(models.rows.map(r=>[r.id, parseFloat(r.model_multiplier)||1]));
  const tr = await pool.query('SELECT COUNT(*)::int as cnt FROM usage_records WHERE weighted_tokens=0 AND tokens_used>0');
  console.log('need backfill', tr.rows[0].cnt);
  if(dryRun){ await pool.end(); return; }
  let lastId=0, updated=0;
  while(true){
    const {rows} = await pool.query('SELECT id, prompt_tokens, completion_tokens, cached_tokens, model_id FROM usage_records WHERE weighted_tokens=0 AND tokens_used>0 AND id>$1 ORDER BY id LIMIT 1000', [lastId]);
    if(rows.length===0) break;
    for(const r of rows){
      const mult = multMap.get(r.model_id)||1;
      const {weightedTokens} = calculateCost({model_multiplier: mult},{promptTokens: r.prompt_tokens||0, completionTokens: r.completion_tokens||0, cachedTokens: r.cached_tokens||0});
      await pool.query('UPDATE usage_records SET weighted_tokens=$1 WHERE id=$2 AND weighted_tokens=0', [weightedTokens, r.id]);
      updated++;
      lastId = Math.max(lastId, r.id);
    }
    console.log('batch up to '+lastId+' updated='+updated);
  }
  console.log('done '+updated);
  const vr = await pool.query('SELECT COUNT(*)::int as still_zero FROM usage_records WHERE weighted_tokens=0 AND tokens_used>0');
  console.log('still zero', vr.rows[0]);
  await pool.end();
}
const dry = process.argv.includes('--dry');
backfill(dry).catch(e=>{console.error(e);process.exit(1)});
