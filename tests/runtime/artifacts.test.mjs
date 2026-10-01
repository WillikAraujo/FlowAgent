import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { listWorktreeArtifacts, readWorktreeArtifact } from '../../src/main/worktree-artifacts.ts';
test('Git artifacts expose real diffs and reject paths outside worktree',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ade-artifacts-'));
  const git=args=>execFileSync('git',['-C',root,...args],{windowsHide:true});
  try {
    git(['init']);await writeFile(join(root,'auth.ts'),'old\n');git(['add','auth.ts']);git(['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','Initial']);
    await writeFile(join(root,'auth.ts'),'new\n');await writeFile(join(root,'new.ts'),'created\n');
    const files=await listWorktreeArtifacts(root);assert.deepEqual(files.map(file=>file.path),['auth.ts','new.ts']);
    const diff=await readWorktreeArtifact(root,'auth.ts');assert.equal(diff.kind,'diff');assert.match(diff.content,/-old/);assert.match(diff.content,/\+new/);
    assert.equal((await readWorktreeArtifact(root,'new.ts')).kind,'file');
    await assert.rejects(readWorktreeArtifact(root,'../outside.txt'),/worktree/);
    await writeFile(join(root,'large.txt'),'x'.repeat(65537));await assert.rejects(readWorktreeArtifact(root,'large.txt'),/64 KB/);
  } finally {await rm(root,{recursive:true,force:true});}
});
