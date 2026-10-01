import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

test('collaboration history and directed knowledge are visible and survive desktop restart',async({},info)=>{
  const root=await mkdtemp(join(tmpdir(),'ade-collaboration-ui-'));const repo=join(root,'repo');const userData=join(root,'userData');await mkdir(repo);await mkdir(userData);
  execFileSync('git',['init',repo],{windowsHide:true});
  const env={...process.env,ADE_TEST_REPO:repo,ADE_TEST_USER_DATA:userData};delete env.ADE_RENDERER_URL;
  let app:Awaited<ReturnType<typeof electron.launch>>|undefined;
  const launch=async()=>{app=await electron.launch({args:[resolve('tests/e2e/desktop-fixture.cjs')],env});return app.firstWindow();};
  try {
    let page=await launch();await page.getByRole('button',{name:'Selecione um projeto'}).click();
    await expect(page.locator('.workspace-switcher')).toContainText('repo');
    const ids=await page.evaluate(async()=>{
      const api=(window as any).ade;const [project]=await api.workspace.listProjects();const [tree]=await api.workspace.listWorktrees(project.projectId);
      const task=await api.workspace.createTask({projectId:project.projectId,worktreePath:tree.path,description:'Collaboration authentication',profile:'developer'});
      const agent=await api.agentRuntime.launchAgent({projectId:project.projectId,worktreeId:tree.branch,taskId:task.taskId,task:task.description,providerId:'codex',role:'reviewer',displayName:'Reviewer',specialties:['security']});
      await api.collaboration.command({projectId:project.projectId,action:'create',kind:'note',input:{title:'Refresh rotation',body:'Rotate refresh tokens',targetAgentIds:[agent.agentId],relations:[{type:'task',id:task.taskId}]}});
      await api.collaboration.command({projectId:project.projectId,action:'ask',to:agent.agentId,message:'Validate authentication'});
      return {projectId:project.projectId,taskId:task.taskId};
    });
    const open=async()=>{
      await page.getByRole('navigation',{name:'Navegação principal'}).getByRole('button',{name:/^Execuções/}).click();
      await page.getByRole('button',{name:/Ver event stream/}).first().click();
      await page.getByRole('button',{name:'Colaboração',exact:true}).click();
    };
    await open();await expect(page.locator('.collaboration-knowledge').getByText('Refresh rotation',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Abrir interação'}).first().click();
    await expect(page.getByText('Validate authentication',{exact:true})).toBeVisible();
    await expect(page.getByText('Aguardando resposta explícita.')).toBeVisible();
    await page.screenshot({path:info.outputPath('collaboration.png')});
    await app!.close();app=undefined;page=await launch();await open();
    await expect(page.locator('.collaboration-knowledge').getByText('Refresh rotation',{exact:true})).toBeVisible();
    const history=await page.evaluate(async({projectId})=>(window as any).ade.collaboration.query({projectId,kind:'history',limit:100}),ids);
    expect(history.events.some((e:any)=>e.type==='note.created')).toBeTruthy();
    expect(history.events.some((e:any)=>e.type==='agent.ask.created')).toBeTruthy();
  } finally {await app?.close();await rm(root,{recursive:true,force:true});}
});
