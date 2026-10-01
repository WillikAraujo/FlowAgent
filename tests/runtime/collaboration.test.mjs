import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { AgentRuntime } from '../../src/main/runtime/agent-runtime.ts';
import { ProviderRegistry } from '../../src/main/runtime/provider-registry.ts';
import { CommunicationBroker } from '../../src/main/runtime/communication-broker.ts';
import { KnowledgeService } from '../../src/main/runtime/knowledge-service.ts';
import { NotesService } from '../../src/main/runtime/notes-service.ts';
import { ContextEngine } from '../../src/main/runtime/context-engine.ts';
import { ResponsibilityManager } from '../../src/main/runtime/responsibility-manager.ts';
import { AdeMcpHttpServer } from '../../src/main/mcp/ade-mcp-server.ts';
import { AgentAccessPolicy } from '../../src/main/runtime/agent-access-policy.ts';
import { migrateDatabase } from '../../src/main/persistence/migrations.ts';
import { restoreVerifiedDatabase, exportConsistentDatabase } from '../../src/main/persistence/backup.ts';
import { LocalSqliteEventStore } from '../../src/main/persistence/sqlite-store.ts';
import { parseIpcRequest, parseIpcResponse } from '../../src/shared/contracts/ipc.ts';
import { providerHarness } from '../fixtures/runtime-provider.mjs';
const require=createRequire(import.meta.url);
const {WorkspaceCatalog}=require('../../dist/main/workspace-catalog.js');
const grants=['agent.inspect','agent.communicate','note.read','note.write','memory.read','memory.write','decision.read','decision.propose','decision.accept','responsibility.read','responsibility.update','responsibility.assign'];
const user={id:'local-user',kind:'user',projectId:'project',role:'user',grants};
async function setup(t) {
  const root=mkdtempSync(join(tmpdir(),'ade-collaboration-')); const path=join(root,'db.sqlite');
  const catalog=new WorkspaceCatalog(path);catalog.saveProject({projectId:'project',rootPath:root,displayName:'Project'});
  const now=new Date().toISOString();catalog.saveTask({projectId:'project',taskId:'task',description:'login authentication',profile:'developer',status:'todo',runId:null,priority:'Média',impact:'Médio',worktreePath:root,references:[],checklist:[],createdAt:now,updatedAt:now});
  const harness=providerHarness('fixture');
  const registry=new ProviderRegistry();registry.register(harness.provider);
  const runtime=new AgentRuntime(registry,undefined,catalog);
  let clock=new Date(); const broker=new CommunicationBroker(runtime,undefined,()=>clock,catalog.collaborationStore);
  const knowledge=new KnowledgeService(catalog.collaborationStore,undefined,()=>clock);
  const notes=new NotesService(catalog);const context=new ContextEngine(knowledge,()=>clock);
  const create=async(role='reviewer',displayName=role)=>{const agent=runtime.createAgent({projectId:'project',worktreeId:'main',workingDirectory:root,role,displayName,taskId:'task',providerId:'fixture',specialties:['authentication']});const session=await runtime.createSession(agent.agentId);return {agent,session,p:{id:agent.agentId,kind:'agent',projectId:'project',role,grants}};};
  t.after(()=>{broker.close();catalog.close();rmSync(root,{recursive:true,force:true});});
  return {root,path,catalog,runtime,broker,knowledge,notes,context,create,...harness,advance:ms=>{clock=new Date(clock.getTime()+ms);}};
}

test('scenario A: responsibility, explicit correlated reply and result persist',async t=>{
  const s=await setup(t),front=await s.create('developer','Frontend'),review=await s.create('reviewer','Reviewer');
  const responsibilities=new ResponsibilityManager(s.catalog,s.runtime);
  const work=responsibilities.assign(user,{taskId:'task',title:'Implement login',assignedTo:front.agent.agentId});
  const asked=await s.broker.ask({principal:front.p,from:front.agent.agentId,to:review.agent.agentId,message:'Validate login',contextRefs:[{type:'file',id:'src/auth.ts',worktreeId:'main'}]});
  const waiting=s.broker.waitForReply(front.p,asked.messageId);
  s.output(review.session.sessionId,'Unrelated output');s.emit(review.session.sessionId,'agent.turn.completed');
  assert.equal(s.broker.getInteraction(front.p,asked.messageId).state,'delivered');
  s.broker.reply(review.p,asked.messageId,'Missing refresh rotation');
  assert.equal((await waiting).response,'Missing refresh rotation');
  responsibilities.setStatus(front.p,work.responsibilityId,'completed');
  const events=s.catalog.collaborationStore.readAfter('project',0,500).events;
  assert.ok(events.some(e=>e.type==='agent.reply.created' && e.payload.fromAgentId===review.agent.agentId));
  assert.ok(events.some(e=>e.type==='responsibility.status.changed' && e.payload.status==='completed'));
  assert.notEqual(s.runtime.executionId(front.agent.agentId),front.session.sessionId);
});
test('concurrent questions to one agent cannot consume each other responses',async t=>{
  const s=await setup(t),a=await s.create(),b=await s.create(),r=await s.create();
  const [one,two]=await Promise.all([s.broker.ask({principal:a.p,from:a.agent.agentId,to:r.agent.agentId,message:'Question A'}),s.broker.ask({principal:b.p,from:b.agent.agentId,to:r.agent.agentId,message:'Question B'})]);
  const first=s.broker.waitForReply(a.p,one.messageId),second=s.broker.waitForReply(b.p,two.messageId);
  s.broker.reply(r.p,two.messageId,'B only');s.broker.reply(r.p,one.messageId,'A only');
  assert.equal((await first).response,'A only');assert.equal((await second).response,'B only');
  assert.throws(()=>s.broker.reply(a.p,one.messageId,'forged'),/addressed/);
});
test('busy recipient queues delivery, deadline expires and late reply is audited',async t=>{
  const s=await setup(t),a=await s.create(),r=await s.create();
  s.capabilities.sendMessage={support:'conditional'};
  const queued=await s.broker.ask({principal:a.p,from:a.agent.agentId,to:r.agent.agentId,message:'Review',timeoutMs:1000});
  assert.equal(queued.state,'queued');assert.equal(s.calls.filter(c=>c[0]==='send').length,0);
  s.advance(1100);s.broker.expirePending();
  assert.equal(s.broker.getInteraction(a.p,queued.messageId).state,'timed_out');
  assert.throws(()=>s.broker.reply(r.p,queued.messageId,'Late'),/closed/);
  assert.ok(s.catalog.collaborationStore.readAfter('project',0,500).events.some(e=>e.type==='agent.reply.rejected'));
});
test('cycles, identity spoofing, cross-project references and duplicate operations are controlled',async t=>{
  const s=await setup(t),a=await s.create(),b=await s.create();
  const input={principal:a.p,from:a.agent.agentId,to:b.agent.agentId,message:'Review',operationId:'op-1'};
  const first=await s.broker.ask(input);assert.equal((await s.broker.ask(input)).messageId,first.messageId);
  await assert.rejects(s.broker.ask({...input,message:'Different'}),/different/);
  await assert.rejects(s.broker.ask({principal:b.p,from:b.agent.agentId,to:a.agent.agentId,message:'Loop'}),/cycle/);
  await assert.rejects(s.broker.ask({...input,principal:{...a.p,projectId:'other'}}),/project/);
  await assert.rejects(s.broker.ask({...input,from:b.agent.agentId}),/identity/);
  await assert.rejects(s.broker.ask({...input,operationId:'op-2',contextRefs:[{type:'file',id:'../secret',worktreeId:'main'}]}),/relative/);
});
test('scenario B and C: directed notes, clarification, acknowledgement and resolution',async t=>{
  const s=await setup(t),product=await s.create('planner','Product'),front=await s.create('developer','Frontend'),backend=await s.create('reviewer','Backend'),review=await s.create();
  let note=s.notes.create(product.p,'Login','Allow CPF or email',{targetAgentIds:[front.agent.agentId],tags:['login']});
  assert.equal(s.notes.read(product.p,note.noteId).authorId,product.agent.agentId);
  assert.equal(s.notes.read(front.p,note.noteId).status,'ACTIVE');
  assert.throws(()=>s.notes.read(backend.p,note.noteId),/not shared/);
  note=s.notes.transition(front.p,note.noteId,note.revision,'acknowledge');
  note=s.notes.transition(front.p,note.noteId,note.revision,'resolve');assert.equal(note.status,'RESOLVED');
  const backendNote=s.notes.create(review.p,'Error convention','Use docs/api-errors.md',{targetAgentIds:[backend.agent.agentId]});
  const q=await s.broker.ask({principal:backend.p,from:backend.agent.agentId,to:review.agent.agentId,message:'Which error code?',contextRefs:[{type:'note',id:backendNote.noteId}]});
  s.broker.reply(review.p,q.messageId,'AUTH_EXPIRED');assert.equal(s.broker.getInteraction(backend.p,q.messageId).response,'AUTH_EXPIRED');
});
test('notes have optimistic revisions, idempotent creation and per-recipient state',async t=>{
  const s=await setup(t),a=await s.create(),b=await s.create();
  const input={title:'Login',body:'CPF authentication',targetAgentIds:[a.agent.agentId,b.agent.agentId]};
  const note=s.knowledge.create(user,'note',input);assert.equal(s.knowledge.create(user,'note',input).id,note.id);
  const updated=s.knowledge.update(user,'note',note.id,note.revision,{body:'CPF and email authentication'});
  assert.throws(()=>s.knowledge.update(user,'note',note.id,note.revision,{body:'overwrite'}),/revision conflict/);
  assert.throws(()=>s.knowledge.update(a.p,'note',note.id,updated.revision,{body:'overwrite'}),/writable/);
  let acknowledged=s.knowledge.transition(a.p,'note',note.id,updated.revision,'acknowledge');assert.equal(acknowledged.status,'ACTIVE');
  acknowledged=s.knowledge.transition(b.p,'note',note.id,acknowledged.revision,'acknowledge');assert.equal(acknowledged.status,'ACKNOWLEDGED');
  let resolved=s.knowledge.transition(a.p,'note',note.id,acknowledged.revision,'resolve');assert.equal(resolved.status,'ACKNOWLEDGED');
  resolved=s.knowledge.transition(b.p,'note',note.id,resolved.revision,'resolve');assert.equal(resolved.status,'RESOLVED');
});
test('accepted decisions require authority and immutable replacement with atomic history',async t=>{
  const s=await setup(t),backend=await s.create('developer'),review=await s.create(),maestro=await s.create('maestro');
  let decision=s.knowledge.create(backend.p,'decision',{title:'Authentication',body:'JWT plus refresh'});
  assert.throws(()=>s.knowledge.transition(backend.p,'decision',decision.id,decision.revision,'accept'),/Maestro/);
  assert.throws(()=>s.knowledge.transition(maestro.p,'decision',decision.id,decision.revision,'accept'),/validation/);
  decision=s.knowledge.transition(review.p,'decision',decision.id,decision.revision,'validate');
  decision=s.knowledge.transition(maestro.p,'decision',decision.id,decision.revision,'accept');
  assert.throws(()=>s.knowledge.update(maestro.p,'decision',decision.id,decision.revision,{body:'silent replacement'}),/cannot be edited/);
  const replacement=s.knowledge.create(backend.p,'decision',{title:'Authentication rotation',body:'JWT plus rotating refresh'});
  const accepted=s.knowledge.transition(user,'decision',replacement.id,replacement.revision,'accept',{replacementId:decision.id,justification:'Reviewed rotation requirements'});
  assert.equal(accepted.supersedesId,decision.id);assert.equal(s.knowledge.read(user,'decision',decision.id).status,'superseded');
});
test('selective memory follows agentId into new task without raw conversations or obsolete context',async t=>{
  const s=await setup(t),a=await s.create('developer'),b=await s.create();
  const relevant=s.knowledge.create(a.p,'memory',{title:'Login conventions',body:'Authentication uses CPF',tags:['login']});
  s.knowledge.create(a.p,'memory',{title:'Billing',body:'Invoices use bank slips'});
  s.knowledge.create(b.p,'memory',{title:'Private login',body:'Private finding'});
  let obsolete=s.knowledge.create(a.p,'note',{title:'Login old',body:'Old authentication',targetAgentIds:[a.agent.agentId]});
  s.knowledge.transition(user,'note',obsolete.id,obsolete.revision,'archive');
  s.knowledge.create(user,'memory',{title:'Global errors',body:'Use typed errors',scope:'project',category:'rule'});
  await s.runtime.stopAgent(a.agent.agentId);
  s.catalog.saveTask({...s.catalog.getTask('project','task'),taskId:'new-task',description:'New login task',status:'todo'});
  s.runtime.reuseAgent(a.agent.agentId,{projectId:'project',worktreeId:'main',workingDirectory:s.root,providerId:'fixture',role:'developer',taskId:'new-task'});
  const session=await s.runtime.createSession(a.agent.agentId);
  const result=s.context.select(a.p,{task:'Implement login',taskId:'new-task',executionId:session.executionId});
  assert.ok(result.records.some(r=>r.id===relevant.id));assert.ok(result.records.some(r=>r.title==='Global errors'));
  assert.ok(!result.text.includes('Private finding'));assert.ok(!result.text.includes('Invoices'));assert.ok(!result.text.includes('Old authentication'));
  assert.ok(result.text.length<=12000);assert.notEqual(session.sessionId,a.session.sessionId);
  assert.throws(()=>s.context.select(a.p,{task:'Implement login',maxChars:1}),/Mandatory project rules/);
});
test('store publishes only committed batch events and rolls back all projections on conflict',async t=>{
  const s=await setup(t);const store=s.catalog.collaborationStore;const events=[];store.subscribe(e=>events.push(e));
  const note=s.knowledge.create(user,'note',{title:'Atomic',body:'Before'});const before=store.readAfter('project',0,500).latestSequence;events.length=0;
  const current=store.getEntity('project','note',note.id);
  const change={projectId:'project',entityId:note.id,entityType:'note',origin:'system',type:'note.updated',payload:{},entityData:{...current.data,body:'After'},expectedRevision:current.revision};
  assert.throws(()=>store.commitBatch([change,change]),/revision conflict/);assert.equal(events.length,0);assert.equal(store.getEntity('project','note',note.id).data.body,'Before');assert.equal(store.readAfter('project',0,500).latestSequence,before);
});
test('v1 backup restores through a validated v2 migration and collaboration survives export',async t=>{
  const root=mkdtempSync(join(tmpdir(),'ade-v1-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const old=join(root,'old.sqlite');let store=new LocalSqliteEventStore(old);
  store.commit({projectId:'p',entityId:'p',entityType:'project',origin:'main',type:'project.created',payload:{},entityData:{displayName:'P',rootPath:root}});store.close();
  const db=new DatabaseSync(old);migrateDatabase(db,1);db.close();
  const restored=join(root,'restored.sqlite');await restoreVerifiedDatabase(old,restored);store=new LocalSqliteEventStore(restored);
  store.commit({projectId:'p',entityId:'m',entityType:'memory',origin:'system',type:'memory.created',payload:{},entityData:{title:'Login',body:'CPF',scope:'agent',ownerAgentId:'a'}});
  const exported=join(root,'exported.sqlite');await exportConsistentDatabase(store,exported,[]);store.close();
  const copy=new LocalSqliteEventStore(exported);assert.equal(copy.getEntity('p','memory','m').data.body,'CPF');copy.close();
});
test('MCP explicit replies use authenticated identity and revised notes schemas',async t=>{
  const s=await setup(t),a=await s.create(),r=await s.create();
  const q=await s.broker.ask({principal:a.p,from:a.agent.agentId,to:r.agent.agentId,message:'Review'});
  let authorized=true;
  const server=new AdeMcpHttpServer({runtime:s.runtime,broker:s.broker,notes:s.notes,knowledge:s.knowledge,context:s.context,responsibilities:new ResponsibilityManager(s.catalog,s.runtime),policy:new AgentAccessPolicy(),principal:r.p,isAuthorized:()=>authorized,resolveWorktree:async()=>s.root});
  const connection=await server.start();t.after(()=>server.close());
  const call=async(name,args)=>{const response=await fetch(connection.endpoint,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:`Bearer ${connection.token}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});return response;};
  const answer=await (await call('reply_agent',{messageId:q.messageId,response:'OK'})).json();assert.notEqual(answer.result.isError,true);
  assert.equal(s.broker.getInteraction(a.p,q.messageId).response,'OK');
  authorized=false;assert.equal((await call('list_inbox',{})).status,403);
});
test('IPC validates collaboration commands and pages without trusting caller identity',()=>{
  assert.throws(()=>parseIpcRequest({operation:'collaboration.command',payload:{projectId:'p',action:'create',kind:'note',input:{title:'Login',body:'CPF'},fromAgentId:'forged'}}));
  assert.throws(()=>parseIpcRequest({operation:'collaboration.command',payload:{projectId:'p',action:'update',kind:'note',id:'n',patch:{body:'overwrite'}}}));
  assert.throws(()=>parseIpcResponse('collaboration.query',{ok:true,value:{events:[],messages:[],knowledge:[]}}));
});


test('restart audits uncertain delivery without replaying provider commands',async t=>{
  const s=await setup(t),a=await s.create(),b=await s.create();
  const question=await s.broker.ask({principal:a.p,from:a.agent.agentId,to:b.agent.agentId,message:'Review restart'});
  const calls=s.calls.filter(c=>c[0]==='send').length;
  const restarted=new CommunicationBroker(s.runtime,undefined,()=>new Date(),s.catalog.collaborationStore);
  const recovered=restarted.getInteraction(a.p,question.messageId);
  assert.equal(recovered.state,'delivery_uncertain');assert.equal(recovered.failure,'runtime-restarted');
  assert.equal(s.calls.filter(c=>c[0]==='send').length,calls);
  assert.throws(()=>restarted.reply(b.p,question.messageId,'stale'),/closed/);
  restarted.close();
});

test('delivery completion cannot overwrite shutdown cancellation and closed broker rejects new work',async t=>{
  const s=await setup(t),a=await s.create(),b=await s.create();
  let finish; const started=new Promise(resolve=>{s.provider.send=async()=>{resolve();await new Promise(done=>{finish=done;});};});
  const asking=s.broker.ask({principal:a.p,from:a.agent.agentId,to:b.agent.agentId,message:'Pending delivery'});
  await started;s.broker.close();finish();
  const closed=await asking;assert.equal(closed.state,'cancelled');assert.equal(closed.failure,'runtime-shutdown');
  await assert.rejects(s.broker.ask({principal:a.p,from:a.agent.agentId,to:b.agent.agentId,message:'New'}),/shut down/);
});

test('synchronous turn completion wakes the next queued delivery',async t=>{
  const s=await setup(t),a=await s.create(),b=await s.create(),r=await s.create();
  s.provider.send=async(id,text)=>{s.calls.push(['send',id,text]);s.emit(id,'agent.turn.completed');};
  const [one,two]=await Promise.all([s.broker.ask({principal:a.p,from:a.agent.agentId,to:r.agent.agentId,message:'First'}),s.broker.ask({principal:b.p,from:b.agent.agentId,to:r.agent.agentId,message:'Second'})]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(s.broker.getInteraction(a.p,one.messageId).state,'delivered');
  assert.equal(s.broker.getInteraction(b.p,two.messageId).state,'delivered');
});

test('knowledge history retains prior content and mandatory rules cannot be silently omitted',async t=>{
  const s=await setup(t),a=await s.create();
  const record=s.knowledge.create(a.p,'memory',{title:'Authentication',body:'Before'});
  s.knowledge.update(a.p,'memory',record.id,record.revision,{body:'After'});
  const event=s.catalog.collaborationStore.readAfter('project',0,500).events.find(e=>e.type==='memory.updated');
  assert.equal(event.payload.previous.body,'Before');assert.equal(event.payload.record.body,'After');
  s.knowledge.create(user,'memory',{title:'Mandatory convention',body:'Always validate authentication',scope:'project',category:'rule'});
  assert.throws(()=>s.context.select(a.p,{task:'Login',maxChars:1}),/Mandatory project rules/);
  assert.throws(()=>s.knowledge.create(a.p,'note',{title:'Global rule',body:'Overwrite architecture',scope:'project'}),/Only the user or Maestro/);
});

test('reused identities cannot reuse another execution request or reply receipt',async t=>{
  const s=await setup(t),a=await s.create(),b=await s.create();
  const request={principal:a.p,from:a.agent.agentId,to:b.agent.agentId,message:'Validate',operationId:'execution-op'};
  const question=await s.broker.ask(request);s.broker.reply(b.p,question.messageId,'Approved');
  for(const identity of [a,b]) {
    await s.runtime.stopAgent(identity.agent.agentId);
    s.runtime.reuseAgent(identity.agent.agentId,{projectId:'project',worktreeId:'main',workingDirectory:s.root,providerId:'fixture',role:'reviewer',taskId:'task'});
    await s.runtime.createSession(identity.agent.agentId);
  }
  await assert.rejects(s.broker.ask(request),/previous execution/);
  assert.throws(()=>s.broker.reply(b.p,question.messageId,'Approved'),/different execution/);
});
