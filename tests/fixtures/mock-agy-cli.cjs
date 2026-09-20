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

rl.on('line', (line) => {
  try {
    const data = JSON.parse(line);
    if (data.event === 'user') {
      turn++;
      const userText = data.message?.content?.[0]?.text || '';
      console.log(JSON.stringify({ event: 'init', conversation_id: 'mock-conv-multiturn-test' }));
      console.log(JSON.stringify({
        event: 'step_update',
        step_update: {
          step_index: turn,
          step_type: 'agent_response',
          state: 'DONE',
          text_delta: `Mock response for [${userText}] (turn ${turn})`
        }
      }));
      console.log(JSON.stringify({
        event: 'result',
        result: {
          status: 'SUCCESS',
          conversation_id: 'mock-conv-multiturn-test'
        }
      }));
    }
  } catch (e) {
    console.error('Error in mock CLI:', e);
  }
});
