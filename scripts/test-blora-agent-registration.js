const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(require('path').join(__dirname,'../public/js/blora-agent.js'),'utf8');
let upgraded=false,resolveDefined;const defined=new Promise(r=>resolveDefined=r);let createdBeforeDefinition=false;
const element={classList:{add(){},remove(){},toggle(){}},dataset:{},appendChild(){},setAttribute(){},removeAttribute(){},hasAttribute(){return false},addEventListener(){},querySelectorAll(){return []},close(){}};
const context={window:{matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}}),addEventListener(){}},document:{addEventListener(){},getElementById:id=>id==='baHistory'||id==='bloraAgentPage'?element:null,createElement:tag=>{if(tag==='blora-drawer'&&!upgraded)createdBeforeDefinition=true;return {...element}},querySelector:()=>null},customElements:{whenDefined:()=>defined},MutationObserver:class{observe(){}disconnect(){}},location:{hash:''},Dom:{escapeHtml:x=>x},setHTML(){}};
vm.runInNewContext(source,context);const p=context.window.BloraAgentPage;
const run=p.bind();assert.equal(createdBeforeDefinition,false);assert.equal(p.bound,false);
upgraded=true;resolveDefined();run.then(()=>{assert.equal(createdBeforeDefinition,false);assert.equal(p.bound,true);console.log('Agent bind waits for official Drawer registration before creating/calling component.');}).catch(e=>{console.error(e);process.exitCode=1});
