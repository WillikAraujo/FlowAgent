import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexProviderAdapter } from '../../src/main/adapters/codex/codex-provider-adapter.ts';
async function setup() {
  const adapter=new CodexProviderAdapter();
  const value=await adapter.create({agentId:'a',projectId:'p',worktreeId:'w',workingDirectory:process.cwd(),role:'reviewer'});
  const session=adapter.sessions.get(value.sessionId);const output=[];const events=[];
  adapter.subscribeOutput(value.sessionId,chunk=>output.push(chunk.text));adapter.subscribeEvents(value.sessionId,event=>events.push(event));
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.kill=()=>true;
  adapter.killTree=async()=>{};adapter.attach(session,child);
  return {adapter,session,child,output,events};
}
test('JSONL accepts multiple bounded lines in one larger chunk',async()=>{
  const {adapter,session}=await setup();const line=JSON.stringify({type:'future.event',detail:'x'.repeat(70000)});
  adapter.consumeBytes(session,Buffer.from(`${line}\n${line}\n`));assert.equal(session.protocolError,undefined);assert.equal(session.lineBuffer,'');
});
test('streamed deltas are not duplicated by completed messages',async()=>{
  const {adapter,session,output}=await setup();adapter.consumeEvent(session,{type:'item.delta',item_id:'i',item:{type:'agent_message'},delta:'Hello'});
  adapter.consumeEvent(session,{type:'item.completed',item:{id:'i',type:'agent_message',text:'Hello'}});assert.deepEqual(output,['Hello']);
});
test('final JSONL without newline is consumed before process completion',async()=>{
  const {session,child}=await setup();child.stdout.write(JSON.stringify({type:'turn.completed'}));child.emit('close',0);
  assert.equal(session.value.status,'completed');assert.equal(session.protocolError,undefined);
});
test('stderr overflow is process failure and is bounded',async()=>{
  const {session,child,events}=await setup();child.stderr.write(Buffer.alloc(65537));child.emit('close',1);
  assert.equal(session.value.status,'failed');assert.equal(events.at(-1).data.reason,'process-error');
});
test('clean process exit without explicit completion is a failure',async()=>{
  const {session,child,events}=await setup();child.emit('close',0);
  assert.equal(session.value.status,'failed');assert.equal(events.at(-1).data.reason,'missing-completion');
});
test('malformed or truncated protocol fails without exposing private reasoning',async()=>{
  const {adapter,session,child,output}=await setup();adapter.consumeEvent(session,{type:'item.completed',item:{type:'reasoning',text:'private'}});
  child.stdout.write('{broken');child.emit('close',0);assert.equal(session.protocolError,'truncated-jsonl');assert.deepEqual(output,[]);
});
