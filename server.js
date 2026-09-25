const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const pty = require('node-pty');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Gerenciador de terminais em memória
const terminals = new Map();
let terminalCounter = 1;

// Shell padrão no Windows
const defaultShell = process.platform === 'win32' ? 'powershell.exe' : 'bash';

function createTerminal(options = {}) {
  const id = `term-${terminalCounter++}`;
  const cwd = options.cwd || process.env.USERPROFILE || process.cwd();
  const shell = options.shell || defaultShell;
  const cols = options.cols || 80;
  const rows = options.rows || 24;

  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-color',
    cols,
    rows,
    cwd,
    env: process.env
  });

  const termData = {
    id,
    ptyProcess,
    cwd,
    shell,
    clients: new Set(),
    outputBuffer: '' // Mantém histórico recente para reconexão
  };

  ptyProcess.onData((data) => {
    // Guarda os últimos 100KB de saída para novos clientes renderizarem de imediato
    termData.outputBuffer = (termData.outputBuffer + data).slice(-100000);
    
    for (const ws of termData.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'output', data }));
      }
    }
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    console.log(`[Terminal ${id}] Encerrado (exitCode: ${exitCode}, signal: ${signal})`);
    for (const ws of termData.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', exitCode }));
      }
    }
    terminals.delete(id);
  });

  terminals.set(id, termData);
  console.log(`[Terminal ${id}] Criado com sucesso em "${cwd}"`);
  return termData;
}

// Rotas REST
app.get('/api/terminals', (req, res) => {
  const list = Array.from(terminals.values()).map(t => ({
    id: t.id,
    cwd: t.cwd,
    shell: t.shell,
    connectedClients: t.clients.size
  }));
  res.json(list);
});

app.post('/api/terminals', (req, res) => {
  const { cwd, shell, cols, rows } = req.body || {};
  const term = createTerminal({ cwd, shell, cols, rows });
  res.status(201).json({ id: term.id, cwd: term.cwd, shell: term.shell });
});

app.post('/api/terminals/:id/send', (req, res) => {
  const { id } = req.params;
  const { command, execute = true } = req.body;
  const term = terminals.get(id);

  if (!term) {
    return res.status(404).json({ error: 'Terminal não encontrado' });
  }

  const payload = execute ? `${command}\r` : command;
  term.ptyProcess.write(payload);
  res.json({ ok: true, id, sent: command });
});

app.post('/api/terminals/:id/resize', (req, res) => {
  const { id } = req.params;
  const { cols, rows } = req.body;
  const term = terminals.get(id);

  if (!term) {
    return res.status(404).json({ error: 'Terminal não encontrado' });
  }

  try {
    term.ptyProcess.resize(cols, rows);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/terminals/:id', (req, res) => {
  const { id } = req.params;
  const term = terminals.get(id);

  if (!term) {
    return res.status(404).json({ error: 'Terminal não encontrado' });
  }

  try {
    term.ptyProcess.kill();
    terminals.delete(id);
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// WebSocket para streaming de I/O em tempo real
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const termId = url.searchParams.get('id');

  if (!termId || !terminals.has(termId)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Terminal inválido ou inexistente' }));
    ws.close();
    return;
  }

  const term = terminals.get(termId);
  term.clients.add(ws);

  // Envia buffer acumulado para restaurar tela
  if (term.outputBuffer) {
    ws.send(JSON.stringify({ type: 'output', data: term.outputBuffer }));
  }

  ws.on('message', (message) => {
    try {
      const parsed = JSON.parse(message);
      if (parsed.type === 'input') {
        term.ptyProcess.write(parsed.data);
      } else if (parsed.type === 'resize') {
        term.ptyProcess.resize(parsed.cols, parsed.rows);
      }
    } catch {
      // Se não for JSON, trata como texto puro de stdin
      term.ptyProcess.write(message.toString());
    }
  });

  ws.on('close', () => {
    term.clients.delete(ws);
  });
});

const PORT = process.env.PORT || 3333;
server.listen(PORT, () => {
  console.log(`\n=================================================`);
  console.log(`🚀 ADE Core Server ativo em http://localhost:${PORT}`);
  console.log(`=================================================\n`);
});
