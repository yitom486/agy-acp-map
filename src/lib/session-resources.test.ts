import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionResources } from './session-resources.ts';
import { AgySessionCore } from '../core/session-core.ts';
import { setCachedDiscoveryForTest, clearDiscoveryCache } from './agy-discovery.ts';

test('native resources and MCP live in distinct session roots; close/resume/shutdown clean up', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-resource-test-'));
  const source = path.join(tmp, 'resources');
  const cwd = path.join(tmp, 'workspace');
  const skill = path.join(source, 'skills', 'counter');
  fs.mkdirSync(skill, {recursive:true}); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(source,'AGENTS.md'), 'Application rule marker');
  fs.writeFileSync(path.join(skill,'SKILL.md'), '---\nname: counter\ndescription: Counter skill\n---\nInstructions');
  fs.writeFileSync(path.join(skill,'schema.json'), '{"type":"object"}');
  const old = process.env.AGY_ACP_RESOURCES_DIR, warmup = process.env.AGY_ACP_WARMUP;
  process.env.AGY_ACP_RESOURCES_DIR=source; process.env.AGY_ACP_WARMUP='0';
  setCachedDiscoveryForTest({availableModels:['mock'],availableAgents:[]});
  const core = new AgySessionCore({sessionStore:path.join(tmp,'sessions.json'),mcpScope:'session'});
  const servers=[{name:'demo',command:'node',args:['server.cjs'],env:[]}];
  const rootOf=(s:any) => {const a=core.buildSpawnTarget(s).args;return a[a.lastIndexOf('--add-dir')+1]!;};
  try {
    const a=(await core.createSession({cwd,mcpServers:servers})).session;
    const b=(await core.createSession({cwd,mcpServers:servers})).session;
    const ra=rootOf(a), rb=rootOf(b);
    expect(ra).not.toBe(rb);
    expect(fs.readFileSync(path.join(ra,'AGENTS.md'),'utf8')).toBe('Application rule marker');
    expect(fs.existsSync(path.join(ra,'.agents','skills','counter','schema.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(ra,'.agents','mcp_config.json'),'utf8')).mcpServers.demo.command).toBe('node');
    expect(core.buildSpawnTarget(a).args).not.toContain('--disable-slash-commands');
    expect(fs.readdirSync(cwd)).toEqual([]);
    await core.closeSession({sessionId:a.sessionId});
    expect(fs.existsSync(ra)).toBe(false); expect(fs.existsSync(rb)).toBe(true);
    await core.resumeSession({sessionId:a.sessionId,cwd,mcpServers:servers});
    const rc=rootOf(core.sessions.get(a.sessionId));
    expect(rc).not.toBe(ra); expect(fs.existsSync(rc)).toBe(true);
    await core.shutdown();
    expect(fs.existsSync(rb)).toBe(false); expect(fs.existsSync(rc)).toBe(false);
    expect(fs.readdirSync(cwd)).toEqual([]);
  } finally {
    await core.shutdown(); clearDiscoveryCache();
    if(old===undefined) delete process.env.AGY_ACP_RESOURCES_DIR;else process.env.AGY_ACP_RESOURCES_DIR=old;
    if(warmup===undefined) delete process.env.AGY_ACP_WARMUP;else process.env.AGY_ACP_WARMUP=warmup;
    fs.rmSync(tmp,{recursive:true,force:true});
  }
});

test('resource copy never copies adjacent credentials', () => {
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'agy-copy-test-'));
 fs.writeFileSync(path.join(tmp,'AGENTS.md'),'Rule');fs.writeFileSync(path.join(tmp,'auth.json'),'not-a-real-credential');
 const r=new SessionResources(tmp);
 try {expect(fs.existsSync(path.join(r.directory,'auth.json'))).toBe(false);} finally {r.dispose();fs.rmSync(tmp,{recursive:true,force:true});}
});


test('resource copy rejects directory symlinks instead of following them', () => {
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'agy-link-test-'));
 const source=path.join(tmp,'source'), outside=path.join(tmp,'outside');
 fs.mkdirSync(source);fs.mkdirSync(outside);fs.writeFileSync(path.join(source,'AGENTS.md'),'Rule');
 fs.symlinkSync(outside,path.join(source,'skills'),process.platform==='win32'?'junction':'dir');
 try {expect(()=>new SessionResources(source)).toThrow('symlinks');}
 finally {fs.rmSync(tmp,{recursive:true,force:true});}
});
