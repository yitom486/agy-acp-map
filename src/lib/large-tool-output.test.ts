import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveLargeToolOutput, recoverToolOutputMeta } from './large-tool-output.ts';

describe('large tool output', () => {
  test('restores only this conversation generated output, bounded and without following escape links', () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, '../../scratch-output-'));
    try {
      const file = path.join(root, 'conversation-1/.system_generated/steps/8/output.txt');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const envelope = JSON.stringify({ schemaVersion: 1, id: 'test', kind: 'html-artifact', title: 'diagram', html: '<svg></svg>' });
      fs.writeFileSync(file, envelope);
      const pointer = 'The output was large and was saved to: ' + pathToFileURL(file).href;
      expect(resolveLargeToolOutput(pointer, 'conversation-1', root)).toBe(envelope);
      expect(resolveLargeToolOutput('', 'conversation-1', root, 8)).toBe(envelope);
      expect(resolveLargeToolOutput('', 'conversation-1', root, 9)).toBe('');
      expect(recoverToolOutputMeta('conversation-1',{_meta:{toolOutputRecovery:{toolCallIds:['agy-t1-s8','agy-t2-s9','invalid']}}},root)).toEqual({toolOutputRecovery:{outputs:[{toolCallId:'agy-t1-s8',text:envelope}]}});
      expect(recoverToolOutputMeta('other-conversation',{_meta:{toolOutputRecovery:{toolCallIds:['agy-t1-s8']}}},root)).toEqual({});
      expect(resolveLargeToolOutput(pointer, 'other-conversation', root)).toBe(pointer);
      expect(resolveLargeToolOutput(pointer, undefined, root)).toBe(pointer);
      expect(resolveLargeToolOutput(envelope, 'conversation-1', root)).toBe(envelope);
      fs.writeFileSync(file, 'x'.repeat(1024 * 1024 + 1));
      expect(resolveLargeToolOutput(pointer, 'conversation-1', root)).toBe(pointer);
      fs.unlinkSync(file);
      expect(resolveLargeToolOutput(pointer, 'conversation-1', root)).toBe(pointer);
      const outside = path.join(root, 'secret.txt');
      fs.writeFileSync(outside, 'not tool output');
      const outsidePointer = 'The output was large and was saved to: ' + pathToFileURL(outside).href;
      expect(resolveLargeToolOutput(outsidePointer, 'conversation-1', root)).toBe(outsidePointer);
      // Junction works on Windows without symbolic-link privileges.
      const target = path.join(root, 'outside');
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'output.txt'), 'not tool output');
      fs.rmSync(path.dirname(file), { recursive: true });
      fs.symlinkSync(target, path.dirname(file), process.platform === 'win32' ? 'junction' : 'dir');
      expect(resolveLargeToolOutput(pointer, 'conversation-1', root)).toBe(pointer);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('native empty output events', () => {
  test('restores absent tool_info.output and retries when conversation ID arrives at result', async () => {
    const {createMapperState,mapAgyEvent} = await import('./map-agy-to-acp.ts');
    const root=fs.mkdtempSync(path.join(import.meta.dir,'../../scratch-empty-output-'));
    const original=process.env.AGY_ACP_BRAIN_DIR;
    process.env.AGY_ACP_BRAIN_DIR=root;
    try {
      const file=path.join(root,'native-conversation/.system_generated/steps/17/output.txt');
      fs.mkdirSync(path.dirname(file),{recursive:true});
      const envelope=JSON.stringify({schemaVersion:1,kind:'html-artifact',id:'native-17',title:'native chart',html:'<svg></svg>'});
      fs.writeFileSync(file,envelope);
      const event={event:'step_update',step_update:{step_index:17,step_type:'tool',state:'DONE',tool_name:'call_mcp_tool',tool_info:{name:'call_mcp_tool'}}};
      for(const known of [true,false]) {
        let state=createMapperState();
        if(known)state.conversationId='native-conversation';
        const done=mapAgyEvent('session',event,state);
        const updates=known?done.notifications:mapAgyEvent('session',{event:'result',result:{status:'SUCCESS',conversation_id:'native-conversation'}},done.state).notifications;
        expect(updates.some(n=>(n.params.update as any).content?.some((c:any)=>c.content?.text===envelope))).toBe(true);
      }
      const state=createMapperState();state.conversationId='native-conversation';
      const failed=mapAgyEvent('session',{...event,step_update:{...event.step_update,state:'ERROR'}},state);
      expect(failed.state.pendingToolOutputs?.size??0).toBe(0);
    } finally {
      if(original===undefined)delete process.env.AGY_ACP_BRAIN_DIR;else process.env.AGY_ACP_BRAIN_DIR=original;
      const expectedParent=path.resolve(import.meta.dir,'../..');
      if(path.dirname(root)!==expectedParent)throw Error('Unexpected temporary test root');
      fs.rmSync(root,{recursive:true,force:true});
    }
  });
});