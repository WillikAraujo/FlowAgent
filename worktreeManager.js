const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

function execGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(stderr.trim() || stdout.trim() || err.message));
      }
      resolve(stdout.trim());
    });
  });
}

class WorktreeManager {
  constructor(defaultRepoPath = process.cwd()) {
    this.defaultRepoPath = defaultRepoPath;
  }

  async isGitRepo(repoPath = this.defaultRepoPath) {
    try {
      await execGit(['rev-parse', '--is-inside-work-tree'], repoPath);
      return true;
    } catch {
      return false;
    }
  }

  async getRepoInfo(repoPath = this.defaultRepoPath) {
    const isGit = await this.isGitRepo(repoPath);
    if (!isGit) {
      return { isGit: false, path: repoPath, branch: null, branches: [] };
    }

    const currentBranch = await execGit(['branch', '--show-current'], repoPath).catch(() => 'HEAD');
    const branchesOutput = await execGit(['branch', '--format=%(refname:short)'], repoPath).catch(() => '');
    const branches = branchesOutput.split('\n').map(b => b.trim()).filter(Boolean);

    return {
      isGit: true,
      path: repoPath,
      currentBranch,
      branches
    };
  }

  async listWorktrees(repoPath = this.defaultRepoPath) {
    const isGit = await this.isGitRepo(repoPath);
    if (!isGit) return [];

    const raw = await execGit(['worktree', 'list', '--porcelain'], repoPath);
    const blocks = raw.split(/\r?\n\r?\n/).filter(Boolean);
    const worktrees = [];

    for (let i = 0; i < blocks.length; i++) {
      const lines = blocks[i].split(/\r?\n/);
      let wtPath = '';
      let head = '';
      let branch = '(detached)';
      let isBare = false;

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          wtPath = line.replace('worktree ', '').trim();
        } else if (line.startsWith('HEAD ')) {
          head = line.replace('HEAD ', '').trim().substring(0, 7);
        } else if (line.startsWith('branch ')) {
          branch = line.replace('branch refs/heads/', '').trim();
        } else if (line === 'bare') {
          isBare = true;
        }
      }

      if (wtPath && !isBare) {
        // Verifica se a worktree possui arquivos modificados (dirty)
        let dirty = false;
        let modifiedCount = 0;
        try {
          const status = await execGit(['status', '--porcelain'], wtPath);
          if (status) {
            dirty = true;
            modifiedCount = status.split('\n').filter(Boolean).length;
          }
        } catch (e) {
          // Pode falhar se a pasta foi deletada manualmente
        }

        worktrees.push({
          id: `wt-${i + 1}`,
          path: wtPath,
          head,
          branch,
          dirty,
          modifiedCount,
          isMain: i === 0 // A primeira é sempre a worktree raiz
        });
      }
    }

    return worktrees;
  }

  async createWorktree(repoPath = this.defaultRepoPath, branchName, baseBranch = 'main') {
    if (!branchName || !branchName.trim()) {
      throw new Error('Nome da branch é obrigatório.');
    }

    if (typeof branchName !== 'string' || !branchName.trim()) {
      throw new Error('Nome da branch é obrigatório.');
    }
    const cleanBranch = branchName.trim().replace(/\s+/g, '-');
    await execGit(['check-ref-format', '--branch', cleanBranch], repoPath);
    const cleanBaseBranch = typeof baseBranch === 'string' ? (baseBranch || 'main').trim() : '';
    if (!cleanBaseBranch) throw new Error('Referência base é obrigatória.');
    await execGit(['check-ref-format', '--branch', cleanBaseBranch], repoPath);
    await execGit(['rev-parse', '--verify', '--quiet', '--end-of-options', `${cleanBaseBranch}^{commit}`], repoPath);
    const folderName = cleanBranch.replace(/[\/\\]/g, '-');
    const worktreesDir = path.join(repoPath, '.worktrees');

    if (!fs.existsSync(worktreesDir)) {
      fs.mkdirSync(worktreesDir, { recursive: true });
    }

    const targetPath = path.join(worktreesDir, folderName);

    if (fs.existsSync(targetPath)) {
      throw new Error(`O diretório da worktree já existe: ${targetPath}`);
    }

    // Verifica se a branch já existe localmente
    const branchesOutput = await execGit(['branch', '--format=%(refname:short)'], repoPath);
    const existingBranches = branchesOutput.split('\n').map(b => b.trim());

    let gitArgs = [];
    if (existingBranches.includes(cleanBranch)) {
      gitArgs = ['worktree', 'add', targetPath, cleanBranch];
    } else {
      gitArgs = ['worktree', 'add', '-b', cleanBranch, targetPath, cleanBaseBranch];
    }
    await execGit(gitArgs, repoPath);

    return {
      path: targetPath,
      branch: cleanBranch,
      isMain: false
    };
  }

  async removeWorktree(repoPath = this.defaultRepoPath, worktreePath, force = false) {
    if (!worktreePath) {
      throw new Error('Caminho da worktree é obrigatório.');
    }

    const resolvedRepoPath = fs.realpathSync(path.resolve(repoPath));
    const worktreesDir = path.resolve(resolvedRepoPath, '.worktrees');
    const resolvedTargetPath = path.resolve(worktreePath);
    const within = (root, targetPath) => {
      const relative = path.relative(root, targetPath);
      return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    if (!within(worktreesDir, resolvedTargetPath)) {
      throw new Error('O caminho da worktree deve estar dentro de .worktrees do repositório.');
    }
    const realWorktreesDir = fs.existsSync(worktreesDir) ? fs.realpathSync(worktreesDir) : worktreesDir;
    const realTargetPath = fs.existsSync(resolvedTargetPath) ? fs.realpathSync(resolvedTargetPath) : resolvedTargetPath;
    if (!within(resolvedRepoPath, realWorktreesDir)) {
      throw new Error('O diretório .worktrees deve permanecer dentro do repositório.');
    }
    if (!within(realWorktreesDir, realTargetPath)) {
      throw new Error('O caminho resolvido da worktree deve permanecer dentro de .worktrees do repositório.');
    }
    const worktrees = await this.listWorktrees(repoPath);
    const target = worktrees.find(w => path.resolve(w.path).toLowerCase() === resolvedTargetPath.toLowerCase());

    if (!target) {
      throw new Error('Worktree não encontrada.');
    }

    if (target.isMain) {
      throw new Error('Não é permitido remover a worktree raiz do repositório.');
    }

    if (target.dirty && !force) {
      throw new Error(`A worktree possui ${target.modifiedCount} alterações não comitadas. Use remoção forçada se deseja descartar.`);
    }

    const removeArgs = ['worktree', 'remove'];
    if (force) removeArgs.push('--force');
    removeArgs.push(resolvedTargetPath);
    await execGit(removeArgs, repoPath);
    await execGit(['worktree', 'prune'], repoPath).catch(() => {});

    return { ok: true, path: resolvedTargetPath };
  }
}

module.exports = WorktreeManager;
