import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsPage } from '../../src/renderer/components/SettingsPage';
import { CreateTaskDialog } from '../../src/renderer/components/TaskDialogs';

function api() {
  const mock = { loadSettings: vi.fn().mockResolvedValue({ defaultProvider:'codex', projectProviders:{} }), inspectProviders: vi.fn().mockResolvedValue([{ providerId:'codex',name:'Codex CLI',status:'unavailable',version:null,executable:null,authentication:'unknown',roles:['developer','reviewer'],detail:'Not installed' }]), saveSettings: vi.fn().mockImplementation(async value=>value), workspace:{createTask:vi.fn()} };
  Object.defineProperty(window,'ade',{configurable:true,value:mock});return mock;
}
describe('configuration and task flows',()=>{
  it('saves settings and indicates project inheritance',async()=>{
    const mock=api();render(<SettingsPage agents={[]} projectId="p" projectName="Project" onDirtyChange={()=>{}}/>);
    await waitFor(()=>expect(screen.getByLabelText(/Provider padrão da ADE/)).toBeEnabled());
    await userEvent.selectOptions(screen.getByLabelText(/Provider padrão da ADE/),'opencode');
    await userEvent.click(screen.getByRole('button',{name:'Salvar configurações'}));
    await waitFor(()=>expect(mock.saveSettings).toHaveBeenCalledWith({defaultProvider:'opencode',projectProviders:{}}));
    expect(screen.getByText(/Origem: padrão da ADE/)).toBeInTheDocument();
  });
  it('shows provider unavailable without claiming authentication',async()=>{
    api();render(<SettingsPage agents={[]} projectId="p" projectName="Project" onDirtyChange={()=>{}}/>);
    await userEvent.click(screen.getByRole('button',{name:'Providers'}));
    expect(await screen.findByText('Não encontrado')).toBeInTheDocument();
    expect(screen.getByText(/Não verificada — utilize/)).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Iniciar agente'})).not.toBeInTheDocument();
  });
  it('keeps task draft on API failure',async()=>{
    const mock=api();mock.workspace.createTask.mockRejectedValue(new Error('Storage failed'));
    render(<CreateTaskDialog projectId="p" worktrees={[{branch:'main',path:'/repo',isMain:true}]} initialPath="/repo" onClose={()=>{}} onCreated={()=>{}}/>);
    await userEvent.type(screen.getByLabelText('Descrição'),'Implement OAuth');
    await userEvent.click(screen.getByRole('button',{name:'Criar tarefa'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Storage failed');
    expect(screen.getByLabelText('Descrição')).toHaveValue('Implement OAuth');
  });
});
