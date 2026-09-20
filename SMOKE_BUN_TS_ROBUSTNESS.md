# Robustness smoke (Bun + TypeScript)

Date: 2026-09-20T04:44:28.845Z

| Check | Result | Detail |
|-------|--------|--------|
| emptyPrompt | PASS | `{"pass":true,"code":-32602,"message":"empty prompt after flattening content blocks"}` |
| cancelThenNext | PASS | `{"pass":true,"text":"robustok\n","stopReason":"end_turn"}` |
| invalidModel | PASS | `{"pass":true,"spawnSawModel":true,"failedLoud":true,"stopReason":"end_turn","text":"invalid model selection (--model \"definitely-not-a-real-model-xyz-999\" --effort \"\"): model definitely-not-a-real` |
| setConfigBusy | PASS | `{"pass":true,"code":-32002,"message":"session is busy; wait for idle before set_config_option"}` |
| setConfigIdleRespawn | PASS | `{"pass":true,"lastSpawn":"[agy-acp] spawn agy skipPermissions=1 cwd=/workspace/agy-acp-map/smoke-workdir-robustness conversation=b85fd69b-fd48-4a66-b686-0a0e59db7271 effort=low args=[\"-p\",\"\",\"--i` |
| sessionListConversationId | PASS | `{"pass":true,"conversationId":"b85fd69b-fd48-4a66-b686-0a0e59db7271"}` |

## Overall: **PASS**

```json
{
  "emptyPrompt": {
    "pass": true,
    "code": -32602,
    "message": "empty prompt after flattening content blocks"
  },
  "cancelThenNext": {
    "pass": true,
    "text": "robustok\n",
    "stopReason": "end_turn"
  },
  "invalidModel": {
    "pass": true,
    "spawnSawModel": true,
    "failedLoud": true,
    "stopReason": "end_turn",
    "text": "invalid model selection (--model \"definitely-not-a-real-model-xyz-999\" --effort \"\"): model definitely-not-a-real-model-xyz-999 is not recognized as a known model or custom model in settings\nAvailable models:\n  Gemini 3.8 Flash (High)\n  Gemini 3.8 Flash (Medium)\n  Gemini 3.8 Flash (Low)\n  Gemini 3.7 ",
    "note": "Bridge does not validate model ids at session/new; failure surfaces at spawn/turn."
  },
  "setConfigBusy": {
    "pass": true,
    "code": -32002,
    "message": "session is busy; wait for idle before set_config_option"
  },
  "setConfigIdleRespawn": {
    "pass": true,
    "lastSpawn": "[agy-acp] spawn agy skipPermissions=1 cwd=/workspace/agy-acp-map/smoke-workdir-robustness conversation=b85fd69b-fd48-4a66-b686-0a0e59db7271 effort=low args=[\"-p\",\"\",\"--input-format\",\"stream-json\",\"--output-format\",\"stream-json\",\"--dangerously-skip-permissions\",\"--print-timeout\",\"0\",\"--add-dir\",\"/workspace/agy-acp-map/smoke-workdir-robustness\",\"--conversation\",\"b85fd69b-fd48-4a66-b686-0a0e59db7271\"",
    "text": "cfgok\n"
  },
  "sessionListConversationId": {
    "pass": true,
    "conversationId": "b85fd69b-fd48-4a66-b686-0a0e59db7271"
  }
}
```
