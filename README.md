# Blender Product Studio Agent

A local, editable Blender product modeling and advertising photography workspace. The Blender tool layer is exposed through **stdio MCP**, so Claude Code, Codex, and other local MCP hosts can operate the same project. The included web UI is optional; its built-in chat uses Codex separately.

[中文说明](README.zh-CN.md) · [License](LICENSE) · [Security](SECURITY.md)

## What it does

- Keeps supplied photos, dimensions, SVGs, and references with the project.
- Makes a new `.blend` revision for every edit; records working and approved versions separately.
- Queues Blender work, keeps logs, and renders real PNGs from a frozen scene snapshot.
- Provides project, image inspection, editing, render, and asset publishing tools over MCP.
- Can publish a model collection at a stable library path for linked scene files.

It does **not** supply a hosted AI model, a cloud renderer, or an image generator. Blender runs locally. The bundled [product studio skill](skills/blender-product-studio/SKILL.md) contains the modeling and photography workflow.

## Install and start

Requirements: Node.js 22+, Blender installed locally, and enough disk space for `.blend` snapshots and renders. Development was done with Blender 5.2.1; check compatibility before relying on another version. A Codex login is needed **only** for the optional chat in the web UI.

```bash
git clone https://github.com/SanJoeng/blender-product-studio-agent.git
cd blender-product-studio-agent
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:4318`. On macOS, `Start.command` also installs dependencies if needed, builds, and opens the local page. If Blender is not found, set `BLENDER_PATH` in `.env` using [.env.example](.env.example). The data directory is `.studio/` by default and is excluded from Git. Back it up separately.

## Use from Claude Code

Keep `npm start` running. In another terminal, register the local MCP adapter using the **absolute path** to your clone:

```bash
claude mcp add --transport stdio product-studio -- node /ABSOLUTE/PATH/blender-product-studio-agent/dist/mcp-external.js
```

Start Claude Code and ask it to call `list_projects`, then `select_project` or `create_project`. It should read `SKILL.md` through `read_skill` before modeling. For example:

> Use product-studio MCP. Create a project for this 100 mm amber bottle, read the bundled skill, then model an editable bottle and make a small preview. Wait for the Blender jobs and inspect the preview image.

Claude Code's [official MCP setup guide](https://code.claude.com/docs/en/mcp) describes `claude mcp add` and project configuration. No Codex account is needed for this path. The Claude Code process and the studio server must run on the **same computer**.

## Use from another AI harness

Configure a **local stdio MCP server** with:

```json
{
  "command": "node",
  "args": ["/ABSOLUTE/PATH/blender-product-studio-agent/dist/mcp-external.js"]
}
```

Use the host's own MCP configuration format. Run the studio server first. The client controls its own model and login; this repository provides tools and workflow guidance. Typical sequence:

1. `list_projects` → `select_project` or `create_project` → `get_project`.
2. `read_skill({"path":"SKILL.md"})` and the relevant reference guide. Use `import_local_input` for explicitly supplied photo/SVG paths, then `view_image` on their project previews. Use `import_blend_path` for an existing `.blend`.
3. `edit_scene` with Blender Python. It returns a **job ID**. Call `get_job` until completed.
4. `render_scene` from the exact revision ID, then `get_job`, then `view_image` on the returned preview path.
5. Use `select_revision` for rollback; use `publish_asset` when the reusable model should be updated for linked scenes. Long-running jobs can be stopped with `cancel_job`.

The MCP adapter selects one active project **per client connection**. Set `STUDIO_PROJECT_ID` in the adapter environment to preselect a known project; otherwise use the project tools. If the studio uses a custom data directory or port, pass the same `STUDIO_DATA_DIR` and `STUDIO_URL=http://127.0.0.1:PORT` to the adapter. Its local connection secret is generated in the data directory; do not copy it into public configuration files.

## Architecture

```text
Claude Code / another local MCP host ── stdio MCP ──┐
                                                      ├─ local studio server ── Blender CLI ── .blend / PNG
Web UI ── optional Codex chat ── scoped stdio MCP ────┘       │
                                                              └─ project files, versions, logs
```

The server binds only to `127.0.0.1`. Its independent MCP adapter is a local process, not a public remote MCP URL. The studio serializes Blender jobs across clients. Completed images do not update automatically when a source model changes; new renders use the chosen revision.

## Development

```bash
npm run check
npm test
npm run smoke
```

`npm test` exercises the independent MCP handshake and project tools without running Blender. `npm run smoke` runs a small real Blender edit and render. Model judgment still requires inspecting reference photos and previews.

## License

GPL-3.0-only. The bundled skill has its own copy of the same license. User projects and uploaded product assets are stored outside the source tree and are not included in this repository.
