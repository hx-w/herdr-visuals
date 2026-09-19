# Herdr Visuals

Preview Mermaid diagrams, LaTeX equations, and local images beside your Codex
conversation in a Herdr split pane. Open with **prefix+v**, browse or pin an item,
and keep working. Rendering runs locally, without a cloud renderer, API key, or
model call.

- Browse diagrams, equations, image links, and images displayed by Codex tools.
- Zoom, pan, inspect the original source, or jump to the containing answer.
- Search within the bound session and export the selected item as PNG and Markdown.

## Screenshots

Visuals running in Herdr: browsing a workflow image, viewing equations, and
selecting an item from the session list. The workflow and equations use
[the bundled fictional example](examples/overview.md).

**Workflow image preview**

![Visuals in Herdr displaying a fictional data-processing workflow with navigation and zoom controls](docs/screenshots/mermaid.png)

**Equation image preview**

![Visuals in Herdr displaying three aligned binomial identities](docs/screenshots/equations.png)

**Session item list**

![Visuals item list with five images and the workflow image selected](docs/screenshots/item-list.png)

Press `l` to open the list, `j` / `k` to select an item, and Enter to view it.

## Install

Requires Herdr 0.9.0+, Node.js 22+, npm, and a graphics-capable terminal such as
Ghostty, kitty, or WezTerm. Herdr's `[terminal].kitty_graphics` must be enabled.

```sh
herdr plugin install hx-w/herdr-visuals
```

Installation runs `npm ci --ignore-scripts` and downloads Playwright's pinned
Chromium runtime. Linux may require Chromium system libraries; install them
with your distribution's package manager (Playwright documents them via
`npx playwright install-deps chromium`). No daemon starts at login.

Add to your Herdr `config.toml`, then run `herdr server reload-config`:

```toml
[[keys.command]]
key = "prefix+v"
type = "plugin_action"
command = "hx-w.visuals.open"
description = "Visual previews"
```

`prefix` is your existing Herdr prefix, followed by `v`. This does not change
the prefix itself. From a local checkout, `node scripts/bind-key.mjs` adds this
binding, preserves other settings, backs up the file, and refuses conflicts.

Try the bundled diagram and three equations:

```sh
herdr plugin action invoke hx-w.visuals.example
```

Use `[` / `]` to browse, `0` to fit a wide diagram, and `s` to inspect its source.
To preview your conversation, open Visuals from the Codex pane with **prefix+v**.

## Interaction

- **prefix+v**: open beside the current pane; focus an existing preview in the
  current tab; close when pressed from the preview itself.
- The preview is bound to the session from which it was opened. Focusing
  another agent does not read that agent's history. Opening explicitly from a
  different source clears all old items and pins before reading the new session.
  Starting a new session in the same pane also clears the previous records.
- The preview starts with this session's records and the newest item selected.
  `h` switches to the latest turn's answers and images. Browsing, panning, zooming,
  or pinning holds the current item; `r` resumes live updates.
- There is no background discovery or automatic reopening while closed.

| Key | Action |
| --- | --- |
| `[` / `]` or `b` / `n` | Previous / next item |
| `l` | Show / hide the item list |
| `j` / `k`, Enter in list | Select an item and open it |
| `f` | Cycle all / diagrams / equations / images |
| `h` | Toggle this session's records / latest turn's answers and images |
| `/` | Search only this session by title, context, or source; Enter confirms |
| `p` | Pin the current item / resume following |
| `r` | Resume live updates within this session |
| `j` / `k`, arrow keys | Scroll vertically / pan horizontally in preview |
| `+` / `-` | Zoom |
| `0` | Fit the complete diagram to the pane width |
| `g` | Open the containing answer with this item highlighted |
| `s` | Toggle rendered / original source |
| `y` | Copy original source (macOS pbcopy, Linux wl-copy or xclip) |
| `e` | Export matching PNG and Markdown to `~/Downloads/herdr-visuals/` |
| `q` / Escape | Close preview |
| `?` | Show / hide keyboard help |

Press `g` on an item to open its containing answer with the item highlighted.
Use `j`/`k`, Page Up/Down, or Home/End to read it; `g` or Escape returns to the
preview. Selected text and Markdown files open their own context. Context stays
bound to the captured item and is cleared on source/session changes. No
conversation content is written to disk.

This version does not scroll the source terminal. Herdr 0.9.0 exposes pane-wide
search and scrolling, but no session-scoped terminal range or atomic
session-identity guard. A pane can contain multiple sessions, so matching terminal
text alone cannot reliably identify the item's original location. Visuals reads
only the bound transcript and uses its message identity and line number instead.

Wide diagrams start at readable size and can be panned; `0` gives an overview.
The preview uses a neutral light palette and renders at twice CSS resolution
for high-DPI terminals.

Selected text, when supplied by Herdr's invocation context, takes precedence
over transcript discovery. This also accepts bare Mermaid or raw math explicitly
selected by the user. Press `r` to return to the session.

## What gets rendered

- Complete fenced `mermaid` blocks.
- Display math delimited by `$$ ... $$` or `\[ ... \]`.
- Fenced `math`, `latex`, and `tex` blocks.
- Local image references: Markdown images, clickable image links, backtick paths,
  and bare absolute paths. PNG, JPEG, WebP, GIF, BMP, AVIF, and SVG are supported.
  Relative links resolve against the source session's working directory; `~/`
  and `file://` links also work. Angle-bracket Markdown destinations preserve spaces.

For example, `[Chart](</path/sample chart.png>)` appears as an image in Visuals.
Images displayed by Codex tools (including `Viewed Image` and images returned
through an `exec` call) also appear, even without a link in the final answer.
Visuals uses the embedded image content in the bound conversation, so these
previews keep working if the original temporary file is gone. Tool code is never
executed or searched for image paths. Embedded images can be exported with `e`;
`g` shows image context, and `y` explains how to export instead of copying Base64.
Images use the same navigation, filtering, pinning, zoom/pan and export controls.
Large images automatically fit the preview area. Complex previews are downsampled
in memory to fit Herdr's 512 KiB inline image limit and 1 MiB socket request
limit, preserving the complete viewport.
Zoom and pan still work; adaptation does not change the source file or exported
image resolution. Valid images are no longer rejected solely for exceeding
32 MiB or 40 megapixels; decoding remains subject to browser and available memory.

Animated formats are captured as a static preview. HTTP image URLs are not
downloaded automatically. Missing or unsupported files show an explicit error.

### Kitty graphics proxy

All previews, including local images, use Herdr's `pane.graphics.info/set/clear`
API and its Kitty graphics proxy to the attached terminal. The plugin sends
PNG pixels over the Herdr socket; the client handles terminal placement. It
does not write escape sequences into the source agent's pane, require `icat`,
or depend on a shared file path on the client. This also permits server-side
image paths in a remote Herdr session. Remote display has not been live-tested.
When graphics are unavailable, `s` provides a terminal source view; Visuals
does not substitute ASCII art for an image.

Inline math stays in prose and does not create separate items. Ordinary code
fences are skipped. Incomplete blocks wait for completion; rendering errors
show the source and the parser error instead of silently changing the input.
Use `aligned` inside math delimiters for multi-line derivations.

Codex is resolved using the exact `agent_session` ID reported by Herdr. The
adapter reads assistant final messages and typed images in tool results from that
session's JSONL transcript. Prompts, tool text, commentary and internal reasoning
are excluded. A shared working directory is never used to select another session.
History is bounded to the last 16 MiB and 300 answer/image records. If the JSONL
file cannot be located, the UI shows an unavailable state. It never scans terminal
scrollback, because that can contain older sessions. Explicit selected-text preview
remains available. Automatic history discovery currently supports Codex only.

Only the active source is read. Conversation text is kept in process memory;
source pane handles are stored in the plugin state directory. Files are saved
only when you press export. Mermaid uses strict mode; KaTeX disables trusted
commands; Chromium can fetch only bundled rendering assets through an intercepted
virtual origin. External network requests and arbitrary local file loads are blocked.

Optional environment variables:

| Variable | Purpose |
| --- | --- |
| `HERDR_VISUALS_CODEX_HOME` | Custom Codex home; otherwise `CODEX_HOME`, then `~/.codex` |
| `HERDR_VISUALS_EXPORT_DIR` | Export parent directory; otherwise `~/Downloads` |

## Development and verification

```sh
npm ci --ignore-scripts
npm run setup
npm run check
herdr plugin link "$PWD"
node scripts/bind-key.mjs
herdr server reload-config
```

`npm run check` exercises the supplied preview example with real Chromium,
Mermaid and KaTeX, including graph structure, fraction/aligned math layout,
raw-source errors, transcript boundaries, and pin/follow behavior. Rendered
test images go to ignored `test-output/`. CI runs the same checks on Linux.

For manual acceptance, open the example, navigate through its four items,
filter, pin, browse history, zoom/pan, toggle source, export, resize, then close
and reopen. Check that switching to an empty scope clears the old image and
that exporting immediately after changing items exports the selected item.

Uninstall with `herdr plugin uninstall hx-w.visuals` (or `plugin unlink` for a
local checkout), and remove only the `hx-w.visuals.open` keybinding. Existing
exports and the config backup remain yours. No Codex files are modified.
