import React from 'react';
import type { WorkspaceAgentEvent } from '../../shared/contracts/ipc';
import { Dialog } from './TaskDialogs';

/** References are opened through the main process, which validates the worktree boundary. */
export function AgentMessage({ event, targetName }: { event: WorkspaceAgentEvent; targetName: string }) {
  const [preview, setPreview] = React.useState<{ path: string; content: string; kind: string } | null>(null);
  const [error, setError] = React.useState('');
  const text = String(event.data.message ?? '');
  const fragments = text.split(/([A-Za-z0-9_.-]+(?:[/\\][A-Za-z0-9_.-]+)+\.[A-Za-z0-9]+)/g);
  async function open(path: string) {
    setError('');
    try { setPreview(await window.ade.workspace.readArtifact(event.projectId, event.worktreeId, path)); }
    catch (error) { setError(String(error)); }
  }
  return <article className={`agent-message role-${event.role}`}><header><strong>{event.data.fromAgentId === 'user' ? 'Você' : event.agentName}</strong><time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}</time></header><small>Para {targetName}</small><p>{fragments.map((fragment,index)=>index % 2 && fragment.length <= 1024 ? <button className="artifact-link" key={index} onClick={()=>void open(fragment)}>{fragment}</button> : fragment)}</p>{error && <p role="alert">{error}</p>}{preview && <Dialog title={preview.path} onClose={()=>setPreview(null)}><p>{preview.kind==='diff'?'Diff em relação a HEAD':'Conteúdo do arquivo'}</p><pre className="artifact-preview">{preview.content}</pre></Dialog>}</article>;
}
