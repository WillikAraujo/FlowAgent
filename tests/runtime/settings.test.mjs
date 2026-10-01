import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsService } from '../../src/main/settings-service.ts';
import { parseIpcRequest, parseIpcResponse } from '../../src/shared/contracts/ipc.ts';

test('settings persist atomically across service restarts and serialize saves', async () => {
  const root=await mkdtemp(join(tmpdir(),'ade-settings-'));
  try {
    const path=join(root,'preferences.json');const service=new SettingsService(path);
    assert.deepEqual(await service.load(),{defaultProvider:'codex',projectProviders:{}});
    await Promise.all([service.save({defaultProvider:'opencode',projectProviders:{p:'codex'}}),service.save({defaultProvider:'codex',projectProviders:{p:'opencode'}})]);
    assert.deepEqual(await new SettingsService(path).load(),{defaultProvider:'codex',projectProviders:{p:'opencode'}});
    await writeFile(path,'broken');await assert.rejects(service.load());
  } finally { await rm(root,{recursive:true,force:true}); }
});
test('IPC supports Unicode message ceiling while keeping other operations bounded',()=>{
  assert.doesNotThrow(()=>parseIpcRequest({operation:'agentRuntime.sendMessage',payload:{projectId:'p',agentIds:['a'],message:'😀'.repeat(4000)}}));
  assert.throws(()=>parseIpcRequest({operation:'settings.save',payload:{defaultProvider:'codex',projectProviders:{},secret:'x'}}));
  assert.doesNotThrow(()=>parseIpcResponse('agentRuntime.sendMessage',{ok:true,value:{sent:1,results:[{agentId:'a',sent:true},{agentId:'b',sent:false,error:'Unavailable'}]}}));
});
