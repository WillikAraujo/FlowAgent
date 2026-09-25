// ADE Core Client Manager
const activeTerminals = new Map();

const gridEl = document.getElementById('terminals-grid');
const btnAddTerm = document.getElementById('btn-add-term');
const counterEl = document.getElementById('term-counter');
const promptInput = document.getElementById('global-prompt-input');
const targetSelect = document.getElementById('target-terminal-select');
const btnSendPrompt = document.getElementById('btn-send-prompt');

function updateCounter() {
  const count = activeTerminals.size;
  counterEl.textContent = `${count} terminal${count === 1 ? '' : 'is'} ativo${count === 1 ? '' : 's'}`;
  
  // Atualiza opções do select
  const currentVal = targetSelect.value;
  targetSelect.innerHTML = '<option value="all">Todos os Terminais</option>';
  for (const [id] of activeTerminals) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = `Terminal ${id}`;
    targetSelect.appendChild(opt);
  }
  if (Array.from(targetSelect.options).some(o => o.value === currentVal)) {
    targetSelect.value = currentVal;
  }
}

async function createTerminalInstance(initialData = null) {
  let termInfo = initialData;

  if (!termInfo) {
    try {
      const res = await fetch('/api/terminals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      termInfo = await res.json();
    } catch (err) {
      console.error('Falha ao criar terminal:', err);
      alert('Erro ao criar terminal no servidor.');
      return;
    }
  }

  const { id, cwd, shell } = termInfo;

  // Cria card no DOM
  const card = document.createElement('div');
  card.className = 'terminal-card';
  card.id = `card-${id}`;
  card.innerHTML = `
    <div class="terminal-header">
      <div class="terminal-title" title="${cwd}">
        <span class="id-tag">${id}</span>
        <span>${cwd}</span>
      </div>
      <div class="terminal-actions">
        <button class="btn-icon" title="Limpar Tela" id="btn-clear-${id}">🧹</button>
        <button class="btn-icon close" title="Fechar Terminal" id="btn-close-${id}">✖</button>
      </div>
    </div>
    <div class="terminal-body" id="body-${id}"></div>
  `;
  gridEl.appendChild(card);

  // Instancia xterm.js
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

  const bodyEl = card.querySelector(`#body-${id}`);
  term.open(bodyEl);
  fitAddon.fit();

  // Conecta WebSocket
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws?id=${id}`;
  const socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    // Sincroniza dimensões iniciais
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

  // Envia digitação do usuário para o backend
  term.onData((data) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'input', data }));
    }
  });

  // Ajuste automático de layout
  const resizeObserver = new ResizeObserver(() => {
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
  });
  resizeObserver.observe(bodyEl);

  // Botões do card
  card.querySelector(`#btn-clear-${id}`).addEventListener('click', () => {
    term.clear();
  });

  card.querySelector(`#btn-close-${id}`).addEventListener('click', async () => {
    try {
      await fetch(`/api/terminals/${id}`, { method: 'DELETE' });
    } catch (e) {}
    socket.close();
    resizeObserver.disconnect();
    card.remove();
    activeTerminals.delete(id);
    updateCounter();
  });

  activeTerminals.set(id, { term, fitAddon, socket, card, resizeObserver });
  updateCounter();
}

// Disparar prompt / comando rápido
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

// Inicialização: carrega existentes ou abre o primeiro
window.addEventListener('DOMContentLoaded', async () => {
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
    console.warn('Iniciando primeiro terminal...');
    await createTerminalInstance();
  }
});
