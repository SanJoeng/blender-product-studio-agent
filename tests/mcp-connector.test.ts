import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { APP_ROOT } from '../src/config.js';
import { startServer } from '../src/server.js';

function resultText(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.find(item => item.type === 'text')?.text || '';
}

test('a non-Codex MCP client can create, select and inspect a project', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-studio-mcp-'));
  const runtime = await startServer({ dataRoot: root, port: 0 });
  const client = new Client({ name: 'independent-client-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(APP_ROOT, 'dist', 'mcp-external.js')],
    env: { ...process.env, STUDIO_URL: runtime.url, STUDIO_DATA_DIR: root } as Record<string, string>, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    for (const name of ['list_projects', 'create_project', 'select_project', 'get_project', 'read_skill', 'edit_scene', 'render_scene', 'get_job', 'view_image']) assert.ok(names.includes(name), name);

    const noSelection = await client.callTool({ name: 'get_project', arguments: {} });
    assert.equal(noSelection.isError, true);
    const created = await client.callTool({ name: 'create_project', arguments: { name: 'Generic test bottle', brief: 'Height 100 mm' } });
    assert.equal(created.isError, undefined);
    const projectId = JSON.parse(resultText(created as any)).projectId as string;
    assert.match(projectId, /^prj_[a-f0-9]{16}$/);
    const project = await client.callTool({ name: 'get_project', arguments: {} });
    assert.equal(JSON.parse(resultText(project as any)).projectId, projectId);
    const skill = await client.callTool({ name: 'read_skill', arguments: { path: 'SKILL.md' } });
    assert.match(resultText(skill as any), /Blender/);
    const reference = path.join(root, 'generic-reference.png');
    await sharp({ create: { width: 16, height: 16, channels: 4, background: '#47745b' } }).png().toFile(reference);
    const imported = await client.callTool({ name: 'import_local_input', arguments: { source: reference, role: 'reference' } });
    const preview = JSON.parse(resultText(imported as any)).preview as string;
    assert.match(preview, /^inputs\//);
    const image = await client.callTool({ name: 'view_image', arguments: { path: preview } });
    assert.equal(image.content[0].type, 'image');
    const projects = await client.callTool({ name: 'list_projects', arguments: {} });
    assert.ok(JSON.parse(resultText(projects as any)).some((entry: { id: string }) => entry.id === projectId));
    const wrong = await client.callTool({ name: 'select_project', arguments: { projectId: 'prj_0000000000000000' } });
    assert.equal(wrong.isError, true);
    assert.equal(JSON.parse(resultText((await client.callTool({ name: 'get_project', arguments: {} })) as any)).projectId, projectId);

    const unauthorized = await fetch(`${runtime.url}/internal/connector`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'list_projects' }) });
    assert.equal(unauthorized.status, 403);
  } finally {
    await client.close(); await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
