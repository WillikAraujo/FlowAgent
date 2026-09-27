const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const WorktreeManager = require('./worktreeManager');

const PORT = process.env.PORT || 3333;
const MAX_TERMINALS = 8;
const MAX_CONNECTIONS_PER_TERMINAL = 4;
const MAX_WS_MESSAGE_BYTES = 16 * 1024;
const MAX_OUTPUT_BUFFER_BYTES = 100 * 1024;
const MAX_WS_BUFFERED_BYTES = 256 * 1024;
const MAX_TERMINAL_COLS = 500;
const MAX_TERMINAL_ROWS = 500;
const startupRepoRoot = fs.realpathSync(__dirname);

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: MAX_WS_MESSAGE_BYTES, perMessageDeflate: false });

function isAllowedOrigin(origin) {
  if (typeof origin !== 'string') return false;
  try {
    const parsed = new URL(origin);
    const allowed = new Set([
      new URL('http://localhost:' + PORT).origin,
      new URL('http://127.0.0.1:' + PORT).origin
    ]);
    return allowed.has(parsed.origin);
  } catch {
    return false;
  }
}

app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (origin && !isAllowedOrigin(origin)) return res.status(403).json({ error: 'Invalid Origin' });
  next();
});
app.use(express.json({ limit: MAX_WS_MESSAGE_BYTES }));
app.use(express.static(path.join(__dirname, 'public')));

// Gerenciador de repositório e worktrees
let currentRepoPath = __dirname;
let worktreeManager = new WorktreeManager(currentRepoPath);

// Gerenciador de terminais em memória
const terminals = new Map();
let terminalCounter = 1;

// Shell padrão no Windows
const defaultShell = process.platform === 'win32' ? 'powershell.exe' : 'bash';

function isWithinDirectory(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

async function validateTerminalCwd(requestedCwd) {
  const candidatePath = await fs.promises.realpath(requestedCwd || currentRepoPath);
  if (!(await fs.promises.stat(candidatePath)).isDirectory()) throw new Error('cwd must be a directory');
  const knownPaths = [currentRepoPath];
  const worktrees = await worktreeManager.listWorktrees().catch(() => []);
  for (const worktree of worktrees) knownPaths.push(worktree.path);
  const roots = await Promise.all(knownPaths.map((item) => fs.promises.realpath(item).catch(() => null)));
  if (!roots.some((root) => root && isWithinDirectory(root, candidatePath))) {
    throw new Error('cwd must be inside the current repository or a known worktree');
  }
  return candidatePath;
}

function isValidDimension(value, maximum) {
  return Number.isInteger(value) && value >= 1 && value <= maximum;
}

function createTerminal(options = {}) {
  const id = 'term-' + terminalCounter++;
  const cwd = options.cwd || currentRepoPath;
  const shell = defaultShell;
  const cols = options.cols || 80;
  const rows = options.rows || 24;
  const branch = options.branch || 'main';
  const label = options.label || id;

  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-color',
    cols,
    rows,
    cwd,
    env: process.env
  });

  const termData = {
    id,
    label,
    branch,
    cwd,
    shell,
    ptyProcess,
    clients: new Set(),
    outputBuffer: ''
  };

  ptyProcess.onData((data) => {
    const combined = termData.outputBuffer + data;
    const bytes = Buffer.from(combined, 'utf8');
    termData.outputBuffer = bytes.length > MAX_OUTPUT_BUFFER_BYTES
      ? bytes.subarray(bytes.length - MAX_OUTPUT_BUFFER_BYTES).toString('utf8')
      : combined;
    const frame = JSON.stringify({ type: 'output', data });
    const frameBytes = Buffer.byteLength(frame, 'utf8');
    for (const ws of termData.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ws.bufferedAmount + frameBytes > MAX_WS_BUFFERED_BYTES) {
        termData.clients.delete(ws);
        ws.close(1013, 'Slow client; reconnect to resume recent output');
        continue;
      }
      ws.send(frame);
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
  console.log(`[Terminal ${id}] Criado com sucesso em "${cwd}" (Branch: ${branch})`);
  return termData;
}

// Rotas de Worktree & Repositório
app.get('/api/repo/info', async (req, res) => {
  try {
    const info = await worktreeManager.getRepoInfo();
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/repo/set', async (req, res) => {
  const { repoPath } = req.body || {};
  if (typeof repoPath !== 'string' || !repoPath.trim()) {
    return res.status(400).json({ error: 'repoPath is required' });
  }

  try {
    const resolvedPath = await fs.promises.realpath(repoPath);
    if (!isWithinDirectory(startupRepoRoot, resolvedPath)) {
      return res.status(403).json({ error: 'Repository path is outside the allowed root' });
    }

    const nextManager = new WorktreeManager(resolvedPath);
    if (!(await nextManager.isGitRepo(resolvedPath))) {
      return res.status(400).json({ error: 'Repository path must be a Git repository' });
    }

    currentRepoPath = resolvedPath;
    worktreeManager = nextManager;
    const info = await worktreeManager.getRepoInfo();
    res.json(info);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/worktrees', async (req, res) => {
  try {
    const list = await worktreeManager.listWorktrees();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/worktrees', async (req, res) => {
  const { branch, baseBranch } = req.body;
  try {
    const result = await worktreeManager.createWorktree(undefined, branch, baseBranch);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/worktrees', async (req, res) => {
  const { path: wtPath, force } = req.body;
  try {
    const result = await worktreeManager.removeWorktree(undefined, wtPath, force);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Rotas de Terminais
app.get('/api/terminals', (req, res) => {
  const list = Array.from(terminals.values()).map(t => ({
    id: t.id,
    label: t.label,
    branch: t.branch,
    cwd: t.cwd,
    shell: t.shell,
    connectedClients: t.clients.size
  }));
  res.json(list);
});

app.post('/api/terminals', async (req, res) => {
  const { cwd, shell, cols, rows, branch, label } = req.body || {};
  if (shell && shell !== defaultShell) return res.status(400).json({ error: 'Shell not allowed' });
  if (terminals.size >= MAX_TERMINALS) return res.status(429).json({ error: 'Terminal limit reached' });
  if ((cols !== undefined && !isValidDimension(cols, MAX_TERMINAL_COLS)) ||
      (rows !== undefined && !isValidDimension(rows, MAX_TERMINAL_ROWS))) {
    return res.status(400).json({ error: 'Invalid terminal dimensions' });
  }
  try {
    const validatedCwd = await validateTerminalCwd(cwd);
    const term = createTerminal({ cwd: validatedCwd, shell, cols, rows, branch, label });
    res.status(201).json({ id: term.id, label: term.label, branch: term.branch, cwd: term.cwd, shell: term.shell });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/terminals/:id/send', (req, res) => {
  const { id } = req.params;
  const { command, execute = true } = req.body;
  const term = terminals.get(id);

  if (!term) {
    return res.status(404).json({ error: 'Terminal não encontrado' });
  }

  if (typeof command !== 'string') return res.status(400).json({ error: 'Invalid input' });
  if (Buffer.byteLength(command, 'utf8') > MAX_WS_MESSAGE_BYTES) return res.status(413).json({ error: 'Input exceeds the allowed limit' });

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

  if (!isValidDimension(cols, MAX_TERMINAL_COLS) || !isValidDimension(rows, MAX_TERMINAL_ROWS)) {
    return res.status(400).json({ error: 'Invalid terminal dimensions' });
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

// WebSocket para streaming
wss.on('connection', (ws, req) => {
  ws.on('error', () => console.warn('[WebSocket] Connection error'));
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) { ws.close(1008, 'Invalid Origin'); return; }
  const url = new URL(req.url, 'http://127.0.0.1');
  const termId = url.searchParams.get('id');

  if (!termId || !terminals.has(termId)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Terminal inválido ou inexistente' }));
    ws.close();
    return;
  }

  const term = terminals.get(termId);
  if (term.clients.size >= MAX_CONNECTIONS_PER_TERMINAL) {
    ws.close(1013, 'Terminal connection limit reached');
    return;
  }
  term.clients.add(ws);

  if (term.outputBuffer) {
    ws.send(JSON.stringify({ type: 'output', data: term.outputBuffer }));
  }

  ws.on('message', (message) => {
    try {
      const parsed = JSON.parse(message.toString());
      if (parsed.type === 'input' && typeof parsed.data === 'string') {
        term.ptyProcess.write(parsed.data);
      } else if (parsed.type === 'resize' && isValidDimension(parsed.cols, MAX_TERMINAL_COLS) &&
          isValidDimension(parsed.rows, MAX_TERMINAL_ROWS)) {
        term.ptyProcess.resize(parsed.cols, parsed.rows);
      }
    } catch {
      term.ptyProcess.write(message.toString());
    }
  });

  ws.on('close', () => {
    term.clients.delete(ws);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n=================================================`);
  console.log(`🚀 ADE Core Server ativo em http://localhost:${PORT}`);
  console.log(`=================================================\n`);
});
