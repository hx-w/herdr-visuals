# Contributor contract

- `npm run check` is the required verification command. It includes real rendering.
- Keep package.json, package-lock.json, and herdr-plugin.toml versions synchronized.
- Never commit session transcripts, exports, host paths, tokens, or test-output images.
- Read only the exact Codex session attached to the selected Herdr pane. Do not guess by cwd.
- Never follow focus to another session. Scope history/search to the bound session and clear records/pins on explicit source or session identity changes.
- Keep Mermaid strict, KaTeX trust disabled, and browser network/file access restricted.
- Only explicit user export writes conversation content to disk.
- Separate renderer cache invalidation from graphics-layer ownership and teardown.
- Export a captured item, never whichever page happened to render most recently.
- Use the installed Herdr schema when changing API calls; newer online docs may differ.
- Verify the GitHub-installed plugin's action and pane entrypoint before claiming delivery.
