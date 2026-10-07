# ae-bridge (macOS)

Fast MCP server for After Effects. Talks to a native ExtendScript socket listener
(`host/claude-bridge.jsx`) running inside AE — no CEP panel, no file polling.

> **Status: macOS port, not yet verified on a Mac.** This is a fork of the Windows
> `ae-bridge`. The server (Node) and host script (ExtendScript `Socket`) are
> platform-neutral and expected to work unchanged; the installer, preset search,
> log-path hints and docs were adapted for macOS. Run `npm run test-bridge` (below)
> first and report anything that behaves differently.

## One-time setup

1. **Enable AE's network-scripting preference** (required, or the bridge's socket
   throws on start): After Effects > Settings > Scripting & Expressions >
   check "Allow Scripts to Write Files and Access Network".

2. **Install the bridge script** into AE's Startup folder. From Terminal, in this
   folder:
   ```bash
   ./install.sh
   ```
   This copies `host/claude-bridge.jsx` into
   `/Applications/Adobe After Effects <version>/Scripts/Startup/` for every AE
   install it finds, retrying with `sudo` if the folder isn't writable. For a
   non-standard location:
   ```bash
   AE_STARTUP_DIR="/path/to/Adobe After Effects 2026/Scripts/Startup" ./install.sh
   ```

3. **Fully quit and restart After Effects.** Confirm it loaded:
   ```bash
   tail -5 "$TMPDIR/claude-ae-bridge.log"
   ```
   You want a line like `claude-bridge initialized (PORT=41890), polling starts in 12000ms`,
   then `polling started` about 12 seconds later. (The bridge deliberately waits 12 s
   after launch so it doesn't poll while AE is still opening its project.)

4. **Install server dependencies** (Node 18+):
   ```bash
   cd server
   npm install
   ```

## Verify the transport before wiring up Claude

With After Effects running (and the bridge loaded per step 3):
```bash
cd server
npm run test-bridge
```
This sends `ping` and `listCompositions` directly over the socket and prints
round-trip latency for each — confirms the bridge itself works, independent
of MCP or Claude.

## Register with Claude Code

Add the server to your Claude Code project. Either create a `.mcp.json` in your
project directory (one level above this folder if you keep `ae-bridge-mac/` inside
it):
```json
{
  "mcpServers": {
    "ae-bridge": {
      "command": "node",
      "args": ["ae-bridge-mac/server/src/index.js"]
    }
  }
}
```
or register it with an absolute path from anywhere:
```bash
claude mcp add ae-bridge -- node /absolute/path/to/ae-bridge-mac/server/src/index.js
```
Restart your Claude Code session afterwards to pick it up.

## Sharing this / setting up on another Mac

**Send**: the whole folder minus `server/node_modules/` (regenerate with
`npm install`). `host/`, `server/src/`, `install.sh`, this README, `CLAUDE.md` and
`.claude/skills/ae-scene-craft/` travel as-is.

**Machine-specific things that may need adjusting**:
- `install.sh` looks in `/Applications/Adobe After Effects*/Scripts/Startup`. If AE is
  installed elsewhere, use `AE_STARTUP_DIR` (above).
- Port `41890` is assumed free. If something else uses it, change `PORT` in both
  `host/claude-bridge.jsx` and `server/src/bridge-client.js` (same value in both).
- Fonts and plugins differ per machine (e.g. Deep Glow's matchName is `PEDG2` only
  if it's installed). Use `ae_list_available_fonts` / `ae_list_available_effects`.
- The bridge listens on all network interfaces, not just loopback — see the
  security note in `CLAUDE.md`. macOS may show a firewall prompt the first time AE
  listens; allow it for local use.

## Tool surface

63 tools across: composition management (create/list/duplicate/settings/open),
layer creation (solid/text/null/camera/light/adjustment layer/precompose/shape
layer), layer organization (move/parent/timing/split/flags/rename/duplicate/
delete), transforms (static set/keyframe/remove keyframe/easing/expression/
time remapping/motion blur), effects (apply/remove/list/discover/presets/
reorder/enable-toggle), shapes (group/rect/ellipse/path/fill/stroke), masks
(add/list/set property), text animators (add animator/add animated property/
selector range), markers (add/bulk add/list/remove), project/asset management
(import/list items/folders/replace source), and utilities (current time/work
area/layer bounds/export frame/audio info/render).

Not yet built: true non-blocking render (not achievable — ExtendScript's
render queue is fully synchronous with no async form).

One real finding worth knowing: `ae_add_shape_primitive`'s `position` for
rect/ellipse is an offset from the shape layer's own Transform Position (which
defaults to comp-center for a new shape layer), not an absolute canvas
coordinate.

## Troubleshooting

- **Tool calls error "AE bridge not connected"** — After Effects isn't running,
  the script isn't in Scripts/Startup, or the network-scripting preference is
  off. Check `$TMPDIR/claude-ae-bridge.log`.
- **`listen() threw` in the log** — almost always the network-scripting
  preference (step 1 above).
- **`listen() returned false`** — port 41890 is already in use (e.g. a second
  AE instance, or a previous run still bound). Quit the other instance or
  change `PORT` in both `host/claude-bridge.jsx` and `server/src/bridge-client.js`.
- **Pings time out right after AE launches** — expected for the first ~12 seconds
  (the bridge delays polling on purpose). If it persists and AE shows a
  "Cannot run a script while a modal dialog is waiting for response" box, click OK
  and see `CLAUDE.md` for the startup-collision notes.
- **Can't find the log** — After Effects' temp folder is normally `$TMPDIR`, but
  it may be a subfolder of it: `find "$TMPDIR" -name claude-ae-bridge.log`.
