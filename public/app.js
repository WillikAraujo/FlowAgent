// ADE Core Client Manager - Multi-terminal & Git Worktrees
const activeTerminals = new Map();

// Elementos da UI
const gridEl = document.getElementById('terminals-grid');
const btnAddTerm = document.getElementById('btn-add-term');
const counterEl = document.getElementById('term-counter');
const promptInput = document.getElementById('global-prompt-input');
const targetSelect = document.getElementById('target-terminal-select');
const btnSendPrompt = document.getElementById('btn-send-prompt');

// Elementos da Sidebar
const sidebarEl = document.getElementById('sidebar');
const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
const btnOpenSidebar = document.getElementById('btn-open-sidebar');
const repoPathEl = document.getElementById('repo-path');
const worktreeListEl = document.getElementById('worktree-list');
const btnShowCreateWt = document.getElementById('btn-show-create-wt');
const createWtForm = document.getElementById('create-wt-form');
const wtBranchInput = document.getElementById('wt-branch-input');
const wtBaseSelect = document.getElementById('wt-base-select');
const btnConfirmCreateWt = document.getElementById('btn-confirm-create-wt');
const btnCancelCreateWt = document.getElementById('btn-cancel-create-wt');

// Toggle da Barra Lateral
function setSidebarOpen(open) {
  if (open) {
    sidebarEl.classList.remove('collapsed');
    btnOpenSidebar.style.display = 'none';
  } else {
    sidebarEl.classList.add('collapsed');
    btnOpenSidebar.style.display = 'inline-block';
  }
}

btnToggleSidebar.addEventListener('click', () => setSidebarOpen(false));
btnOpenSidebar.addEventListener('click', () => setSidebarOpen(true));

// FormulÃ¡rio de CriaÃ§Ã£o de Worktree
btnShowCreateWt.addEventListener('click', () => {
  createWtForm.style.display = 'block';
  wtBranchInput.focus();
});

btnCancelCreateWt.addEventListener('click', () => {
  createWtForm.style.display = 'none';
  wtBranchInput.value = '';
});

btnConfirmCreateWt.addEventListener('click', async () => {
  const branch = wtBranchInput.value.trim();
  const baseBranch = wtBaseSelect.value;
  if (!branch) {
    alert('Digite um nome para a branch!');
    return;
  }

  btnConfirmCreateWt.disabled = true;
  btnConfirmCreateWt.textContent = 'Criando...';

  try {
    const res = await fetch('/api/worktrees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch, baseBranch })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro ao criar worktree');

    createWtForm.style.display = 'none';
    wtBranchInput.value = '';
    await loadWorktrees();

    // JÃ¡ oferece para abrir um terminal direto nela
    createTerminalInstance({ cwd: data.path, branch: data.branch });
  } catch (err) {
    alert(`Falha: ${err.message}`);
  } finally {
    btnConfirmCreateWt.disabled = false;
    btnConfirmCreateWt.textContent = 'Criar';
  }
});

// Carrega informaÃ§Ãµes do RepositÃ³rio e Worktrees
async function loadWorktrees() {
  try {
    const [repoRes, wtRes] = await Promise.all([
      fetch('/api/repo/info'),
      fetch('/api/worktrees')
    ]);

    const repoInfo = await repoRes.json();
    const worktrees = await wtRes.json();

    if (repoInfo && repoInfo.path) {
      repoPathEl.textContent = repoInfo.path;
      repoPathEl.title = repoInfo.path;

      // Atualiza opÃ§Ãµes de branch base
      wtBaseSelect.innerHTML = '';
      const branches = repoInfo.branches.length ? repoInfo.branches : ['main'];
      branches.forEach(b => {
        const opt = document.createElement('option');
        opt.value = b;
        opt.textContent = b;
        wtBaseSelect.appendChild(opt);
      });
    }

    renderWorktreeList(worktrees);
  } catch (err) {
    console.error('Erro ao carregar worktrees:', err);
  }
}

function renderWorktreeList(worktrees) {
  worktreeListEl.replaceChildren();

  if (!worktrees || worktrees.length === 0) {
    const emptyState = document.createElement('div');
    emptyState.style.color = '#7c7c8a';
    emptyState.style.fontSize = '12px';
    emptyState.style.padding = '10px';
    emptyState.textContent = 'Nenhuma worktree encontrada.';
    worktreeListEl.appendChild(emptyState);
    return;
  }

  worktrees.forEach(wt => {
    const card = document.createElement('div');
    card.className = `wt-card ${wt.isMain ? 'main-repo' : ''}`;

    const header = document.createElement('div');
    header.className = 'wt-card-header';

    const branch = document.createElement('span');
    branch.className = 'wt-branch';
    branch.textContent = `\u{1F33F} ${wt.branch}`;
    header.appendChild(branch);

    const dirtyBadge = document.createElement('span');
    dirtyBadge.className = wt.dirty ? 'wt-badge dirty' : 'wt-badge clean';
    if (wt.dirty) {
      dirtyBadge.title = `${wt.modifiedCount} arquivos modificados`;
      dirtyBadge.textContent = `modificado (${wt.modifiedCount})`;
    } else {
      dirtyBadge.textContent = 'limpo';
    }
    header.appendChild(dirtyBadge);

    const worktreePath = document.createElement('div');
    worktreePath.className = 'wt-path';
    worktreePath.title = wt.path;
    worktreePath.textContent = wt.path;

    const actions = document.createElement('div');
    actions.className = 'wt-actions';

    const openTerminalButton = document.createElement('button');
    openTerminalButton.className = 'btn small primary btn-open-wt-term';
    openTerminalButton.title = 'Abrir terminal nesta pasta';
    openTerminalButton.textContent = `\u{1F4BB} Terminal`;
    actions.appendChild(openTerminalButton);

    let removeButton;
    if (!wt.isMain) {
      removeButton = document.createElement('button');
      removeButton.className = 'btn small btn-remove-wt';
      removeButton.title = 'Remover worktree';
      removeButton.textContent = '\u{1F5D1}\u{FE0F}';
      actions.appendChild(removeButton);
    }

    card.append(header, worktreePath, actions);

    openTerminalButton.addEventListener('click', () => {
      createTerminalInstance({ cwd: wt.path, branch: wt.branch });
    });

    if (removeButton) {
      removeButton.addEventListener('click', async () => {
        if (!confirm(`Deseja remover a worktree "${wt.branch}"?`)) return;
        try {
          const res = await fetch('/api/worktrees', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: wt.path, force: false })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error);
          await loadWorktrees();
        } catch (e) {
          if (confirm(`${e.message}\nDeseja forçar a remoção descartando as alterações?`)) {
            const res = await fetch('/api/worktrees', {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: wt.path, force: true })
            });
            await loadWorktrees();
          }
        }
      });
    }

    worktreeListEl.appendChild(card);
  });
}
function updateCounter() {
  const count = activeTerminals.size;
  counterEl.textContent = `${count} terminal${count === 1 ? '' : 'is'} ativo${count === 1 ? '' : 's'}`;
  
  const currentVal = targetSelect.value;
  targetSelect.innerHTML = '<option value="all">Todos os Terminais</option>';
  for (const [id, t] of activeTerminals) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = `${id} (${t.branch || 'main'})`;
    targetSelect.appendChild(opt);
  }
  if (Array.from(targetSelect.options).some(o => o.value === currentVal)) {
    targetSelect.value = currentVal;
  }
}

async function createTerminalInstance(initialData = null) {
  let termInfo = initialData;

  if (!termInfo || !termInfo.id) {
    try {
      const res = await fetch('/api/terminals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd: initialData?.cwd,
          branch: initialData?.branch
        })
      });
      termInfo = await res.json();
    } catch (err) {
      console.error('Falha ao criar terminal:', err);
      alert('Erro ao criar terminal no servidor.');
      return;
    }
  }

  const { id, cwd, shell, branch } = termInfo;

  const card = document.createElement('div');
  card.className = 'terminal-card';
  card.id = `card-${id}`;

  const header = document.createElement('div');
  header.className = 'terminal-header';

  const title = document.createElement('div');
  title.className = 'terminal-title';
  title.title = cwd;

  const idTag = document.createElement('span');
  idTag.className = 'id-tag';
  idTag.textContent = id;

  const branchTag = document.createElement('span');
  branchTag.className = 'branch-tag';
  branchTag.textContent = `\u{1F33F} ${branch || 'main'}`;

  const cwdLabel = document.createElement('span');
  cwdLabel.textContent = cwd;
  title.append(idTag, branchTag, cwdLabel);

  const actions = document.createElement('div');
  actions.className = 'terminal-actions';

  const clearButton = document.createElement('button');
  clearButton.className = 'btn-icon';
  clearButton.title = 'Limpar Tela';
  clearButton.textContent = '\u{1F9F9}';

  const closeButton = document.createElement('button');
  closeButton.className = 'btn-icon close';
  closeButton.title = 'Fechar Terminal';
  closeButton.textContent = '\u{2716}';
  actions.append(clearButton, closeButton);
  header.append(title, actions);

  const body = document.createElement('div');
  body.className = 'terminal-body';

  card.append(header, body);
  gridEl.appendChild(card);

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'Consolas, "Fira Code", monospace',
    theme: {
      background: '#09090a',
      foreground: '#e1e1e6',
      cursor: '#04d361',
      selectionBackground: '#323238'
    }
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  const bodyEl = body;
  term.open(bodyEl);
  fitAddon.fit();

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws?id=${id}`;
  const socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    fitAddon.fit();
    socket.send(JSON.stringify({
      type: 'resize',
      cols: term.cols,
      rows: term.rows
    }));
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'output') {
        term.write(msg.data);
      } else if (msg.type === 'exit') {
        term.write('\r\n\x1b[33m[Processo finalizado]\x1b[0m\r\n');
      }
    } catch {
      term.write(event.data);
    }
  };

  term.onData((data) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'input', data }));
    }
  });

  // OtimizaÃ§Ã£o recomendada pelo Vektor: debouncing com requestAnimationFrame e guarda de dimensÃµes > 0
  let resizeFrame;
  const resizeObserver = new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      if (bodyEl.clientWidth > 0 && bodyEl.clientHeight > 0) {
        try {
          fitAddon.fit();
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
              type: 'resize',
              cols: term.cols,
              rows: term.rows
            }));
          }
        } catch (e) {}
      }
    });
  });
  resizeObserver.observe(bodyEl);

  clearButton.addEventListener('click', () => {
    term.clear();
  });

  closeButton.addEventListener('click', async () => {
    try {
      await fetch(`/api/terminals/${id}`, { method: 'DELETE' });
    } catch (e) {}
    socket.close();
    resizeObserver.disconnect();
    card.remove();
    activeTerminals.delete(id);
    updateCounter();
  });

  activeTerminals.set(id, { term, fitAddon, socket, card, resizeObserver, branch, cwd });
  updateCounter();
}

btnSendPrompt.addEventListener('click', async () => {
  const command = promptInput.value.trim();
  if (!command) return;

  const target = targetSelect.value;
  const targets = target === 'all' 
    ? Array.from(activeTerminals.keys()) 
    : [target];

  for (const termId of targets) {
    try {
      await fetch(`/api/terminals/${termId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, execute: true })
      });
    } catch (err) {
      console.error(`Erro ao enviar comando para ${termId}:`, err);
    }
  }

  promptInput.value = '';
});

promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    btnSendPrompt.click();
  }
});

btnAddTerm.addEventListener('click', () => createTerminalInstance());

// InicializaÃ§Ã£o Geral
window.addEventListener('DOMContentLoaded', async () => {
  await loadWorktrees();

  try {
    const res = await fetch('/api/terminals');
    const existing = await res.json();
    if (existing && existing.length > 0) {
      for (const t of existing) {
        await createTerminalInstance(t);
      }
    } else {
      await createTerminalInstance();
    }
  } catch (err) {
    await createTerminalInstance();
  }
});
