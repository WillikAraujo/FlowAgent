import React from 'react';
import { it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CollaborationPanel } from '../../src/renderer/components/CollaborationPanel';
import { AgentLaunchDialog } from '../../src/renderer/components/TaskDialogs';
import { taskParticipants } from '../../src/renderer/hooks/task-participants';
import type { WorkspaceAgent, WorkspaceTask, WorkspaceExecution } from '../../src/shared/contracts/ipc';
const timestamp='2026-09-30T10:00:00.000Z';
const task:WorkspaceTask={projectId:'p',taskId:'task',runId:null,description:'Login',profile:'developer',status:'running',priority:'Média',impact:'Médio',worktreePath:'/repo',references:[],checklist:[],createdAt:timestamp,updatedAt:timestamp};
const agent:WorkspaceAgent={agentId:'reviewer',projectId:'p',taskId:'task',providerId:'opencode',worktreeId:'main',displayName:'Reviewer',role:'reviewer',status:'stopped',activeSessionId:'old-session',createdAt:timestamp,updatedAt:timestamp,specialties:['security']};
function api() {
  const event={eventId:'event',projectId:'p',entityId:'question',entityType:'message',type:'agent.ask.created',occurredAt:timestamp,sequence:1,revision:1,origin:'system',payload:{authorId:'frontend',fromAgentId:'frontend',toAgentId:'reviewer'}};
  const empty={events:[],knowledge:[],messages:[],nextCursor:1,latestSequence:1,nextId:null,resync:false};
  const query=vi.fn().mockImplementation(async input => input.kind==='history'?{...empty,events:[event]}:input.kind==='interaction'?{...empty,messages:[{messageId:'question',fromAgentId:'frontend',toAgentId:'reviewer',message:'Validate login',response:'Rotate refresh tokens',state:'responded',sourceExecutionId:'execution-a',targetExecutionId:'execution-b',sentAt:timestamp,deadline:timestamp,contextRefs:[{type:'file',id:'src/auth.ts',worktreeId:'main'}]}]}:empty);
  const command=vi.fn().mockResolvedValue({});
  const mock={collaboration:{query,command},inspectProviders:vi.fn().mockResolvedValue([{providerId:'opencode',name:'OpenCode',status:'available',roles:['developer','reviewer']}]),loadSettings:vi.fn().mockResolvedValue({defaultProvider:'opencode',projectProviders:{}}),workspace:{listAgents:vi.fn().mockResolvedValue([agent])},agentRuntime:{launchAgent:vi.fn().mockResolvedValue(agent)}};
  Object.defineProperty(window,'ade',{configurable:true,value:mock});return mock;
}
it('opens a structured interaction with explicit response, executions and related files',async()=>{
  api();render(<CollaborationPanel task={task} agents={[agent]}/>);
  await userEvent.click(await screen.findByRole('button',{name:'Abrir interação'}));
  expect(await screen.findByText('Rotate refresh tokens')).toBeInTheDocument();
  expect(screen.getByText('execution-a')).toBeInTheDocument();expect(screen.getByText(/src\/auth.ts/)).toBeInTheDocument();
  expect(screen.getByRole('region',{name:'Fluxo de colaboração'})).toHaveTextContent('ASK → Reviewer');
});
it('creates directed notes and preserves the draft on a revision/storage failure',async()=>{
  const mock=api();render(<CollaborationPanel task={task} agents={[agent]}/>);
  await userEvent.click(screen.getByText('Registrar conhecimento'));
  await userEvent.selectOptions(screen.getByLabelText('Destinatário'),'reviewer');
  await userEvent.type(screen.getByLabelText('Título'),'Refresh token');await userEvent.type(screen.getByLabelText('Conteúdo'),'Rotate tokens');
  mock.collaboration.command.mockRejectedValueOnce(new Error('Revision conflict'));
  await userEvent.click(screen.getByRole('button',{name:'Registrar',exact:true}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Revision conflict');expect(screen.getByLabelText('Conteúdo')).toHaveValue('Rotate tokens');
  await userEvent.click(screen.getByRole('button',{name:'Registrar',exact:true}));
  await waitFor(()=>expect(mock.collaboration.command).toHaveBeenLastCalledWith({projectId:'p',action:'create',kind:'note',input:{title:'Refresh token',body:'Rotate tokens',scope:'agent',targetAgentIds:['reviewer'],relations:[{type:'task',id:'task'}]}}));
});
it('launch dialog explicitly reuses a persistent identity',async()=>{
  const mock=api();render(<AgentLaunchDialog task={task} worktree={{branch:'main',path:'/repo',isMain:true}} onClose={()=>{}} onLaunched={()=>{}}/>);
  await waitFor(()=>expect(screen.getByLabelText('Identidade')).toBeEnabled());
  await userEvent.selectOptions(screen.getByLabelText('Identidade'),'reviewer');await userEvent.click(screen.getByRole('button',{name:'Iniciar agentes'}));
  await waitFor(()=>expect(mock.agentRuntime.launchAgent).toHaveBeenCalledWith(expect.objectContaining({agentId:'reviewer',role:'reviewer',taskId:'task'})));
});
it('historical task participation never controls the new session of a reused agent',()=>{
  const current={...agent,taskId:'new-task',activeSessionId:'new-session',status:'running' as const,capabilities:{sendMessage:{support:'supported'}} as WorkspaceAgent['capabilities']};
  const execution:WorkspaceExecution={executionId:'old',projectId:'p',taskId:'task',agentId:'reviewer',sessionId:'old-session',status:'stopped',startedAt:timestamp,finishedAt:timestamp,exitCode:null,summary:null,worktreeId:'main'};
  const members=taskParticipants([current],[execution],'task');expect(members).toHaveLength(1);expect(members[0].status).toBe('stopped');expect(members[0].capabilities?.sendMessage.support).toBe('unsupported');
});
