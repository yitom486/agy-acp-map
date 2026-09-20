# SMOKE_IMAGE_IN

- **When**: 2026-09-20T04:43:53.345Z (box local Asia/Shanghai)
- **Outcome**: **PASS**
- **stopReason**: end_turn
- **Prompt**: text + image block (base64 fixtures/tiny.png — blue with white "HI")
- **Degrade**: richContentInput=degrade_to_files → `.agy-acp-staging/<uuid>.png` + text path ref

## Staged / user_message excerpt
```
What single word is most visible or describe the dominant color in one short English sentence.

User attached an image file at: /workspace/agy-acp-map/smoke-workdir-image-in/.agy-acp-staging/bed6a903-901f-4d2f-b24e-93da803d337d.png
Please open/view that file and answer based on what you see.
[agy-acp] staged files: /workspace/agy-acp-map/smoke-workdir-image-in/.agy-acp-staging/bed6a903-901f-4d2f-b24e-93da803d337d.png
[agy-acp] spawn agy skipPermissions=1 cwd=/workspace/agy-acp-map/smoke-workdir-image-in args=["-p","","--input-format","stream-json","--output-format","stream-json","--dangerously-skip-permissions","--print-timeout","0","--add-dir","/workspace/agy-acp-map/smoke-workdir-image-in"]
```

## Agent answer (quoted)
> The single most visible word in [bed6a903-901f-4d2f-b24e-93da803d337d.png](file:///workspace/agy-acp-map/smoke-workdir-image-in/.agy-acp-staging/bed6a903-901f-4d2f-b24e-93da803d337d.png) is **HI**. 
> 
> The dominant background color is bright blue.

## Tools seen
- view_file

## Notes
- agy stream-json stdin rejects non-text content blocks; bridge writes files and asks agent to view_file / @path.
