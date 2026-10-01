import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { OpenCodeProviderAdapter } from '../../src/main/adapters/opencode/opencode-provider-adapter.ts';

function acpProcess({ hang = false } = {}) {
  const requests = [];
  const child = new EventEmitter(); child.stdout = new PassThrough();child.stderr = new PassThrough();child.exitCode = null;
  child.kill=()=>{child.exitCode=0;child.stdout.end();child.emit('close',0);return true;};
  let buffer='';
  child.stdin=new Writable({write(chunk,_encoding,done){
    buffer+=chunk.toString(); let newline;
    while((newline=buffer.indexOf('\n'))>=0){
      const request=JSON.parse(buffer.slice(0,newline));buffer=buffer.slice(newline+1);requests.push(request);
      if(hang || request.id===undefined) continue;
      let result;
      if(request.method==='initialize') result={protocolVersion:1,agentCapabilities:{loadSession:false},authMethods:[]};
      else if(request.method==='session/new') result={sessionId:'test-acp-session'};
      else if(request.method==='session/prompt') {
        child.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'test-acp-session',update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'private'}}}})+'\n');
        child.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'test-acp-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Public result'}}}})+'\n');
        result={stopReason:'end_turn'};
      } else result={};
      child.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
    }done();
  }});
  return {child,requests};
}
test('ACP handshake, prompt, public output and waiting lifecycle',async()=>{
  const {child,requests}=acpProcess();
  const adapter=new OpenCodeProviderAdapter({executable:async()=>process.execPath,spawnProcess:()=>child});
  try {
    const session=await adapter.create({agentId:'a',projectId:'p',worktreeId:'main',workingDirectory:process.cwd(),role:'reviewer'});
    assert.equal(session.status,'ready');const output=[];const events=[];
    adapter.subscribeOutput(session.sessionId,chunk=>output.push(chunk.text));adapter.subscribeEvents(session.sessionId,event=>events.push(event.type));
    await adapter.start(session.sessionId,{task:'Review'});
    await new Promise(resolve=>setTimeout(resolve,50));
    assert.deepEqual(output,['Public result']);assert.equal((await adapter.getStatus(session.sessionId)).status,'waiting');
    assert.ok(events.includes('agent.turn.completed'));assert.ok(requests.some(request=>request.method==='session/prompt'));
    await adapter.send(session.sessionId,'Follow up');await new Promise(resolve=>setTimeout(resolve,50));
    child.emit('close',0);assert.equal((await adapter.getStatus(session.sessionId)).status,'failed');
  } finally { await adapter.shutdown(); }
});
test('ACP handshake timeout kills the process and removes the session',async()=>{
  const {child}=acpProcess({hang:true});let killed=false;const original=child.kill;child.kill=()=>{killed=true;return original();};
  const adapter=new OpenCodeProviderAdapter({executable:async()=>process.execPath,spawnProcess:()=>child});
  await assert.rejects(adapter.create({agentId:'a',projectId:'p',worktreeId:'main',workingDirectory:process.cwd(),role:'reviewer'},{timeoutMs:20}),error=>error.code==='timeout');
  assert.equal(killed,true);assert.equal(adapter.sessions.size,0);await adapter.shutdown();
});
test('cancelling ACP handshake performs cleanup',async()=>{
  const {child}=acpProcess({hang:true});const controller=new AbortController();
  const adapter=new OpenCodeProviderAdapter({executable:async()=>process.execPath,spawnProcess:()=>child});
  const operation=adapter.create({agentId:'a',projectId:'p',worktreeId:'main',workingDirectory:process.cwd(),role:'reviewer'},{signal:controller.signal});
  const timer=setTimeout(()=>controller.abort(),20);
  try {await assert.rejects(operation,error=>error.code==='cancelled');assert.equal(child.exitCode,0);assert.equal(adapter.sessions.size,0);}finally{clearTimeout(timer);await adapter.shutdown();}
});
