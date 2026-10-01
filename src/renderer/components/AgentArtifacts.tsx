import React from 'react';
import { Dialog } from './TaskDialogs';
export function AgentArtifacts({ projectId, worktreeId }: { projectId: string; worktreeId: string }) {
  const [files, setFiles] = React.useState<{ path: string; status: string }[]>([]);
  const [preview, setPreview] = React.useState<{ path: string; content: string; kind: string } | null>(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  async function refresh() {
    setBusy(true); setError('');
    try { setFiles(await window.ade.workspace.listArtifacts(projectId, worktreeId)); }
    catch (error) { setError(String(error)); } finally { setBusy(false); }
  }
  React.useEffect(() => { void refresh(); }, [projectId, worktreeId]);
  async function open(path: string) {
    try { setPreview(await window.ade.workspace.readArtifact(projectId, worktreeId, path)); }
    catch (error) { setError(String(error)); }
  }
  return <div className="aux-panel-content"><header><div><strong>Alterações da worktree</strong><span>Estado Git real; pode incluir alterações anteriores à execução.</span></div><button className="secondary-button" disabled={busy} onClick={() => void refresh()}>Atualizar arquivos</button></header>{error && <p role="alert">{error}</p>}{files.map(file => <button key={file.path} className="data-row" onClick={() => void open(file.path)}><code>{file.status}</code><span><strong>{file.path}</strong></span><span>Abrir diff / arquivo →</span></button>)}{!files.length && <p>{busy ? 'Consultando Git…' : 'Nenhuma alteração encontrada.'}</p>}{files.length === 200 && <p>Exibindo os primeiros 200 arquivos.</p>}{preview && <Dialog title={preview.path} onClose={() => setPreview(null)}><p>{preview.kind === 'diff' ? 'Diff em relação a HEAD' : 'Conteúdo do arquivo'}</p><pre className="artifact-preview">{preview.content}</pre></Dialog>}</div>;
}
