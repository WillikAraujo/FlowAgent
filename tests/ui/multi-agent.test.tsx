import React from 'react';
import { it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MultiAgentPanel } from '../../src/renderer/components/MultiAgentPanel';
import type { WorkspaceAgent, WorkspaceTask } from '../../src/shared/contracts/ipc';
const task: WorkspaceTask={taskId:'task',projectId:'p',runId:null,description:'OAuth',profile:'developer',status:'running',priority:'Média',impact:'Médio',worktreePath:'/repo',references:[],checklist:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
function agent(id:string, taskId='task'):WorkspaceAgent {return {agentId:id,projectId:'p',taskId,worktreeId:'main',providerId:'opencode',role:'reviewer',displayName:id,status:'waiting',activeSessionId:id,createdAt:task.createdAt,updatedAt:task.createdAt,capabilities:{sendMessage:{support:'supported'}} as WorkspaceAgent['capabilities']};}
function props(agents:WorkspaceAgent[],send=vi.fn().mockResolvedValue({sent:1,results:[{agentId:'a',sent:true}]})) {
  Object.defineProperty(window,'ade',{configurable:true,value:{workspace:{listResponsibilities:vi.fn().mockResolvedValue([])}}});
  return {task,worktree:{branch:'main',path:'/repo',isMain:true},run:null,events:[],output:'',agents,agentEvents:[],onSendMessage:send,onCancel:()=>{},onControlAgent:vi.fn(),expanded:false,onToggleExpanded:()=>{},collapsed:false,onToggleCollapsed:()=>{}};
}
it('isolates participants by task and supports ten visible agents',async()=>{
  render(<MultiAgentPanel {...props([...Array.from({length:10},(_,i)=>agent(String(i))),agent('foreign','other')])}/>);
  await userEvent.click(screen.getByRole('button',{name:'Agentes',exact:true}));
  expect(document.querySelectorAll('.runtime-participant')).toHaveLength(10);
  expect(screen.queryByRole('option',{name:/foreign/})).not.toBeInTheDocument();
});
it('partial delivery retries only recipients who failed',async()=>{
  const send=vi.fn().mockResolvedValueOnce({sent:1,results:[{agentId:'a',sent:true},{agentId:'b',sent:false,error:'Unavailable'}]}).mockResolvedValueOnce({sent:1,results:[{agentId:'b',sent:true}]});
  render(<MultiAgentPanel {...props([agent('a'),agent('b')],send)}/>);
  await userEvent.click(screen.getByRole('button',{name:'Agentes',exact:true}));
  await userEvent.click(screen.getByText(/Mensagens dos agentes/));
  await userEvent.type(screen.getByLabelText('Mensagem para os agentes'),'Review security');
  await userEvent.click(screen.getByRole('button',{name:'Enviar',exact:true}));
  expect(await screen.findByRole('alert')).toHaveTextContent('apenas aos destinatários que falharam');
  await userEvent.click(screen.getByRole('button',{name:'Enviar',exact:true}));
  await waitFor(()=>expect(send).toHaveBeenNthCalledWith(2,['b'],'Review security'));
  expect(screen.getByLabelText('Mensagem para os agentes')).toHaveValue('');
});
it('does not send to unsupported selected recipient via Ctrl+Enter',async()=>{
  const unsupported=agent('b');unsupported.capabilities={sendMessage:{support:'unsupported'}} as WorkspaceAgent['capabilities'];
  const send=vi.fn();render(<MultiAgentPanel {...props([agent('a'),unsupported],send)}/>);
  await userEvent.click(screen.getByRole('button',{name:'Agentes',exact:true}));
  await userEvent.click(screen.getByText(/Mensagens dos agentes/));
  await userEvent.selectOptions(screen.getByLabelText('Destinatario'),'b');
  await userEvent.type(screen.getByLabelText('Mensagem para os agentes'),'Review');
  await userEvent.keyboard('{Control>}{Enter}{/Control}');
  expect(send).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:'Enviar',exact:true})).toBeDisabled();
});
