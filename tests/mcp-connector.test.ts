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
    for (const name of ['list_projects', 'create_project', 'select_project', 'get_project', 'record_intake', 'read_skill', 'edit_scene', 'render_scene', 'get_job', 'view_image']) assert.ok(names.includes(name), name);

    const noSelection = await client.callTool({ name: 'get_project', arguments: {} });
    assert.equal(noSelection.isError, true);
    const created = await client.callTool({ name: 'create_project', arguments: { name: 'Generic test bottle', brief: 'Only photos and flat artwork; no sizes or material details yet.' } });
    assert.equal(created.isError, undefined);
    const projectId = JSON.parse(resultText(created as any)).projectId as string;
    assert.match(projectId, /^prj_[a-f0-9]{16}$/);
    const project = await client.callTool({ name: 'get_project', arguments: {} });
    assert.equal(JSON.parse(resultText(project as any)).projectId, projectId);
    const prematureEdit = await client.callTool({ name: 'edit_scene', arguments: { label: 'Should wait', kind: 'model', baseRevisionId: null, code: 'import bpy' } });
    assert.equal(prematureEdit.isError, true);
    assert.match(resultText(prematureEdit as any), /尺寸/);
    assert.equal(runtime.studio.store.get(projectId).jobs.length, 0);
    const skill = await client.callTool({ name: 'read_skill', arguments: { path: 'SKILL.md' } });
    assert.match(resultText(skill as any), /Blender/);
    const reference = path.join(root, 'generic-reference.png');
    await sharp({ create: { width: 16, height: 16, channels: 4, background: '#47745b' } }).png().toFile(reference);
    const imported = await client.callTool({ name: 'import_local_input', arguments: { source: reference, role: 'reference' } });
    const preview = JSON.parse(resultText(imported as any)).preview as string;
    assert.match(preview, /^inputs\//);
    const image = await client.callTool({ name: 'view_image', arguments: { path: preview } });
    assert.equal(image.content[0].type, 'image');
    const partial = await client.callTool({ name: 'record_intake', arguments: { fields: {
      construction: { status: 'confirmed', detail: '闭合瓶身、独立旋盖，瓶身正面朝镜头', source: 'user', evidence: '测试用户说明了结构' },
      views: { status: 'approved_estimate', detail: '缺少背面照片，允许视觉近似', source: 'user', evidence: '测试用户允许对缺失视角推估' },
      artwork: { status: 'not_applicable', detail: '本轮先不贴标签', source: 'user', evidence: '测试用户要求先不贴图' },
      deliverable: { status: 'confirmed', detail: '先交付可编辑模型和小预览', source: 'user', evidence: '测试用户要求建模预览' },
    } } });
    assert.deepEqual(JSON.parse(resultText(partial as any)).intakeStatus.missing.map((item: { field: string }) => item.field), ['dimensions', 'materials']);
    const photoCannotProveSize = await client.callTool({ name: 'record_intake', arguments: { fields: {
      dimensions: { status: 'confirmed', detail: '瓶高 100 mm', source: 'reference', evidence: '实拍图里看起来大约这么高' },
    } } });
    assert.equal(JSON.parse(resultText(photoCannotProveSize as any)).intakeStatus.readyForNewProduct, false);
    const ready = await client.callTool({ name: 'record_intake', arguments: { fields: {
      dimensions: { status: 'confirmed', detail: '含盖高度 100 mm', source: 'user', evidence: '测试用户提供了含盖高度' },
      materials: { status: 'approved_estimate', detail: '玻璃瓶与塑料盖按照片视觉近似', source: 'user', evidence: '测试用户允许按照片估计材质' },
    } } });
    assert.equal(JSON.parse(resultText(ready as any)).intakeStatus.readyForNewProduct, true);
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
