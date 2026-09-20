const readline = require('readline');

// Check CLI subcommands (models, agents, --version, etc.)
const args = process.argv.slice(2);
if (args.includes('models')) {
  console.log('gemini-3.8-flash-high\tGemini 3.8 Flash High (Fast)');
  console.log('gemini-3.8-pro\tGemini 3.8 Pro (Reasoning)');
  process.exit(0);
}

if (args.includes('agents')) {
  console.log('coder\tCoder Agent');
  console.log('architect\tArchitect Agent');
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  console.log('agy 2.0.0-mock');
  process.exit(0);
}

// Long-running stream-json mode for promptSession
const rl = readline.createInterface({ input: process.stdin });
let turn = 0;
let cancelTimer = null;

// Graceful SIGINT / SIGTERM handling for cancellation tests
process.on('SIGINT', () => {
  if (cancelTimer) clearTimeout(cancelTimer);
  console.log(JSON.stringify({
    event: 'result',
    result: {
      status: 'CANCELLED',
      conversation_id: 'mock-conv-blackbox',
    },
  }));
  process.exit(0);
});

rl.on('line', (line) => {
  try {
    const data = JSON.parse(line);
    if (data.event === 'user') {
      turn++;
      const userText = data.message?.content?.[0]?.text || '';
      const convId = 'mock-conv-blackbox';

      // 1. Scenario: Bad / Junk lines resilience
      if (userText.includes('[test:bad_lines]')) {
        console.log('Fetching remote model catalog...');
        console.log('[DEBUG-INTERNAL] Starting sandbox container...');
        console.log('{invalid_json_line_that_should_be_ignored');
        console.log('');
        console.log(JSON.stringify({ event: 'init', conversation_id: convId }));
        console.log(JSON.stringify({
          event: 'step_update',
          step_update: {
            step_index: turn,
            step_type: 'agent_response',
            state: 'DONE',
            text_delta: 'Recovered cleanly from bad lines.',
          },
        }));
        console.log(JSON.stringify({
          event: 'result',
          result: { status: 'SUCCESS', conversation_id: convId },
        }));
        return;
      }

      // 2. Scenario: Thought / Reasoning stream
      if (userText.includes('[test:thought]')) {
        console.log(JSON.stringify({ event: 'init', conversation_id: convId }));
        console.log(JSON.stringify({
          event: 'step_update',
          step_update: {
            step_index: 1,
            step_type: 'agent_response',
            state: 'ACTIVE',
            thought_delta: 'Analyzing the architecture of the application...',
          },
        }));
        console.log(JSON.stringify({
          event: 'step_update',
          step_update: {
            step_index: 1,
            step_type: 'agent_response',
            state: 'ACTIVE',
            thought_delta: ' Formulating optimal recommendation.',
          },
        }));
        console.log(JSON.stringify({
          event: 'step_update',
          step_update: {
            step_index: 2,
            step_type: 'agent_response',
            state: 'DONE',
            text_delta: 'Here is the definitive architectural response.',
          },
        }));
        console.log(JSON.stringify({
          event: 'result',
          result: { status: 'SUCCESS', conversation_id: convId },
        }));
        return;
      }

      // 3. Scenario: Tool call lifecycle (ACTIVE -> DONE)
      if (userText.includes('[test:tool]')) {
        console.log(JSON.stringify({ event: 'init', conversation_id: convId }));
        console.log(JSON.stringify({
          event: 'step_update',
          step_update: {
            step_index: 1,
            step_type: 'tool',
            state: 'ACTIVE',
            tool_name: 'read_file',
            tool_info: {
              name: 'read_file',
              parameters: { path: 'package.json' },
            },
          },
        }));
        console.log(JSON.stringify({
          event: 'step_update',
          step_update: {
            step_index: 1,
            step_type: 'tool',
            state: 'DONE',
            tool_name: 'read_file',
            tool_info: {
              name: 'read_file',
              parameters: { path: 'package.json' },
              output: '{"name": "test-project", "version": "1.0.0"}',
            },
          },
        }));
        console.log(JSON.stringify({
          event: 'step_update',
          step_update: {
            step_index: 2,
            step_type: 'agent_response',
            state: 'DONE',
            text_delta: 'File read complete with success.',
          },
        }));
        console.log(JSON.stringify({
          event: 'result',
          result: { status: 'SUCCESS', conversation_id: convId },
        }));
        return;
      }

      // 4. Scenario: Soft deny permission handling
      if (userText.includes('[test:soft_deny]')) {
        console.log(JSON.stringify({ event: 'init', conversation_id: convId }));
        console.log(JSON.stringify({
          event: 'step_update',
          step_update: {
            step_index: 1,
            step_type: 'tool',
            state: 'ERROR',
            tool_name: 'run_command',
            tool_info: {
              name: 'run_command',
              parameters: { command: 'rm -rf /' },
              error: 'Permission denied: execution not permitted by security policy',
            },
          },
        }));
        console.log(JSON.stringify({
          event: 'result',
          result: {
            status: 'SUCCESS',
            conversation_id: convId,
            denied_actions: [
              { tool: 'run_command', command: 'rm -rf /', reason: 'Security restriction' },
            ],
          },
        }));
        return;
      }

      // 5. Scenario: Delayed emission for cancellation tests
      if (userText.includes('[test:cancel_delay]')) {
        console.log(JSON.stringify({ event: 'init', conversation_id: convId }));
        console.log(JSON.stringify({
          event: 'step_update',
          step_update: {
            step_index: 1,
            step_type: 'agent_response',
            state: 'ACTIVE',
            text_delta: 'Starting long process...',
          },
        }));
        cancelTimer = setTimeout(() => {
          console.log(JSON.stringify({
            event: 'step_update',
            step_update: {
              step_index: 2,
              step_type: 'agent_response',
              state: 'DONE',
              text_delta: 'Completed long process.',
            },
          }));
          console.log(JSON.stringify({
            event: 'result',
            result: { status: 'SUCCESS', conversation_id: convId },
          }));
        }, 5000);
        return;
      }

      // Default: Standard Turn Response
      console.log(JSON.stringify({ event: 'init', conversation_id: convId }));
      console.log(JSON.stringify({
        event: 'step_update',
        step_update: {
          step_index: turn,
          step_type: 'agent_response',
          state: 'DONE',
          text_delta: `Mock response for [${userText}] (turn ${turn})`,
        },
      }));
      console.log(JSON.stringify({
        event: 'result',
        result: {
          status: 'SUCCESS',
          conversation_id: convId,
        },
      }));
    }
  } catch (e) {
    console.error('Error in mock CLI:', e);
  }
});
