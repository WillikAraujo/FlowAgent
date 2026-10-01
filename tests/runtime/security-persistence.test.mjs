import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotesService } from '../../src/main/runtime/notes-service.ts';
import { ResponsibilityManager } from '../../src/main/runtime/responsibility-manager.ts';
import { AdeMcpHttpServer } from '../../src/main/mcp/ade-mcp-server.ts';
import { AgentAccessPolicy } from '../../src/main/runtime/agent-access-policy.ts';
const require=createRequire(import.meta.url);
const {WorkspaceCatalog}=require('../../dist/main/workspace-catalog.js');
const principal={id:'user',kind:'user',projectId:'project',role:'user',grants:['note.read','note.write','responsibility.assign','responsibility.read']};

test('notes, links, responsibilities and task state survive restart; access is scoped',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ade-runtime-store-'));const path=join(root,'workspace.sqlite');let catalog;
  try {
    catalog=new WorkspaceCatalog(path);catalog.saveProject({projectId:'project',displayName:'Project',rootPath:root});
    const now=new Date().toISOString();catalog.saveTask({taskId:'task',projectId:'project',runId:null,description:'OAuth',profile:'developer',status:'todo',priority:'Média',impact:'Médio',worktreePath:root,references:[],checklist:[],createdAt:now,updatedAt:now});
    const agent={agentId:'a',projectId:'project',worktreeId:'main',taskId:'task',providerId:'fixture',role:'developer',displayName:'Developer',status:'running',createdAt:now,updatedAt:now,activeSessionId:null};
    catalog.saveAgent(agent);assert.equal(catalog.getTask('project','task').status,'running');
    const notes=new NotesService(catalog);const note=notes.create(principal,'Plan','Shared context');notes.link(principal,note.noteId,'a');
    const responsibilities=new ResponsibilityManager(catalog,{getAgent:()=>agent});
    const first=responsibilities.assign(principal,{taskId:'task',title:'Implement OAuth',assignedTo:'a'});
    responsibilities.assign(principal,{taskId:'task',title:'Review OAuth',dependsOn:[first.responsibilityId]});
    catalog.close();catalog=new WorkspaceCatalog(path);
    assert.equal(catalog.listTasks('project')[0].status,'interrupted');assert.equal(catalog.loadAgents()[0].status,'unresponsive');
    const restored=new NotesService(catalog);assert.equal(restored.read({...principal,id:'a',kind:'agent',role:'developer'},note.noteId).body,'Shared context');
    assert.throws(()=>restored.read({...principal,id:'foreign',kind:'agent',role:'developer'},note.noteId),/not shared/);
    assert.equal(catalog.listResponsibilities('project').length,2);assert.deepEqual(catalog.listResponsibilities('project')[1].dependsOn,[first.responsibilityId]);
  } finally {catalog?.close();await rm(root,{recursive:true,force:true});}
});
test('MCP requires credentials and denies agent creation for a Developer',async()=>{
  let created=false;
  const server=new AdeMcpHttpServer({runtime:{createAgent:()=>{created=true;}},broker:{},notes:{},responsibilities:{},policy:new AgentAccessPolicy(),principal:{id:'developer',kind:'agent',projectId:'p',role:'developer',grants:['agent.create']},resolveWorktree:async()=>process.cwd()});
  const connection=await server.start();
  try {
    const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'create_agent',arguments:{provider:'fixture',role:'reviewer',worktreeId:'main',task:'Review'}}});
    const denied=await fetch(connection.endpoint,{method:'POST',headers:{'content-type':'application/json'},body});assert.equal(denied.status,401);
    const response=await fetch(connection.endpoint,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:`Bearer ${connection.token}`},body});
    const value=await response.json();assert.equal(value.result.isError,true);assert.match(value.result.content[0].text,/Maestro/);assert.equal(created,false);
  } finally {await server.close();}
});
