// Test-only provider injection; production always uses registered real adapters.
const { app, BrowserWindow, dialog } = require('electron');
const { randomUUID } = require('node:crypto');
const { mkdirSync } = require('node:fs');
if (!process.env.ADE_TEST_USER_DATA || !process.env.ADE_TEST_REPO) throw new Error('Isolated test paths are required.');
mkdirSync(process.env.ADE_TEST_USER_DATA, { recursive: true });
app.setPath('userData', process.env.ADE_TEST_USER_DATA);
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [process.env.ADE_TEST_REPO] });
class FixtureProvider {
  providerId = 'codex';
  sessions = new Map();
  listeners = new Map();
  outputs = new Map();
  timers = new Set();
  async getCapabilities() {
    return Object.fromEntries(['terminal','streaming','mcpClient','mcpServer','fileEditing','toolCalling','sessionResume','structuredOutput','structuredEvents','sendMessage','interrupt','stop','subagents'].map(key => [key, { support: ['streaming','structuredEvents','sendMessage','interrupt','stop'].includes(key) ? 'supported' : 'unsupported' }]));
  }
  async create() { const session = {sessionId:randomUUID(),providerId:'codex',status:'ready',createdAt:new Date().toISOString()};this.sessions.set(session.sessionId,session);return {...session}; }
  async start(id) { const value=this.sessions.get(id);value.startedAt=new Date().toISOString();this.emit(id,'agent.started','running');this.reply(id,'Execução de teste pronta.');return {...value}; }
  async send(id,message) { this.emit(id,'agent.started','running');this.reply(id,`Recebido: ${message}`); }
  reply(id,text) { const timer=setTimeout(()=>{this.timers.delete(timer);this.outputs.get(id)?.({sessionId:id,sequence:1,text,receivedAt:new Date().toISOString()});this.emit(id,'agent.turn.completed','waiting');this.emit(id,'agent.waiting','waiting');},150);this.timers.add(timer); }
  emit(id,type,status) { this.sessions.get(id).status=status;this.listeners.get(id)?.({sessionId:id,sequence:1,type,occurredAt:new Date().toISOString(),data:{}}); }
  async getStatus(id) { return this.sessions.has(id)?{...this.sessions.get(id)}:undefined; }
  subscribeEvents(id,listener) {this.listeners.set(id,listener);return()=>this.listeners.delete(id);}
  subscribeOutput(id,listener) {this.outputs.set(id,listener);return()=>this.outputs.delete(id);}
  async interrupt(id) {this.emit(id,'agent.waiting','waiting');}
  async stop(id) {this.emit(id,'agent.stopped','stopped');}
  async resume() {throw new Error('Unsupported');}
  async shutdown() {for(const timer of this.timers)clearTimeout(timer);}
}
require('../../dist/main/adapters/codex/codex-provider-adapter.js').CodexProviderAdapter = FixtureProvider;
require('../../dist/main/settings-service.js').inspectProviders = async () => [{providerId:'codex',name:'Codex CLI',status:'available',executable:process.execPath,version:'test-fixture',authentication:'unknown',roles:['developer','reviewer'],detail:'Test process fixture'}];
// Keep the test window in the background; Playwright still inspects its rendering.
const OriginalWindow = BrowserWindow;
require('electron').BrowserWindow = class extends OriginalWindow { constructor(options) { super({...options,show:false}); } };
require('../../dist/main/index.js');
