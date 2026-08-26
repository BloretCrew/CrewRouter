
const c=require('/data/CrewRouter/config.json');const {Pool}=require('pg');const d=c.database;
const p=new Pool({host:d.host,port:d.port,database:d.name,user:d.user,password:d.password,connectionTimeoutMillis:8000});
(async()=>{
 const q=await p.query("SELECT id FROM users WHERE username='__sess_test'");
 if(!q.rows[0]){console.log('no test user');process.exit(0)}
 const uid=q.rows[0].id;
 const attr=JSON.stringify({sessionId:'quality-test-001', subagent:null, parentThreadId:null, isCompaction:false, source:[]});
 await p.query("DELETE FROM usage_records WHERE user_id=$1 AND plugin_meta->'attribution'->>'sessionId'='quality-test-001'", [uid]);
 const msgs=[
  {role:'system',content:'sys'},
  {role:'user',content:'帮我修复网站登录接口的500错误'},
  {role:'assistant',content:'',tool_calls:[{id:'q1',function:{name:'Bash',arguments:'{"command":"tail -100 /var/log/app/error.log"}'}}]},
  {role:'tool',tool_call_id:'q1',name:'Bash',content:'TypeError: cannot read property id of undefined at auth.js:42'},
  {role:'assistant',content:'找到问题：auth.js 第42行在用户未携带邮箱字段时会读取 undefined 的 id 属性。'},
  {role:'user',content:'修一下'},
  {role:'assistant',content:'已加空值保护：if (!user) return res.status(401)。修复完成并部署。'}
 ];
 await p.query(
  "INSERT INTO usage_records (user_id, tokens_used, cached_tokens, latency_ms, request_source, messages, response, plugin_meta) VALUES ($1::int,$2::int,$3::int,$4::int,'claude_code',$5::jsonb,'修复完成并部署',JSONB_BUILD_OBJECT('attribution',$6::jsonb))",
  [uid, 800, 200, 500, JSON.stringify(msgs), attr]);
 console.log('seeded quality-test-001 for uid', uid);
 await p.end();
})().catch(e=>{console.error(e.message);process.exit(1)});
