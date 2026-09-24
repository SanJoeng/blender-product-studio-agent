import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { startServer } from '../src/server.js';
import { APP_ROOT } from '../src/config.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-studio-smoke-'));
const runtime = await startServer({ dataRoot: root, port: 0 });
const { studio, token, url } = runtime;
async function wait(projectId: string, jobId: string) {
  while (true) {
    const j = await studio.queue.wait(projectId, jobId, 15000);
    console.log(j.kind, j.status, j.log.at(-1) || '');
    if (j.status === 'completed') return j.result as any;
    if (j.status === 'failed' || j.status === 'cancelled') throw new Error(j.error + '\n' + j.log.join('\n'));
  }
}
try {
  const created = await fetch(`${url}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-studio-token': token }, body: JSON.stringify({ name: 'Integration fixture', brief: 'Generic fixture, no customer data' }) });
  assert.equal(created.status, 201);
  const p = await created.json() as { id: string };
  const demo = studio.edit(p.id, { kind: 'scene', label: 'Demo', baseRevisionId: null, code: fs.readFileSync(path.join(APP_ROOT, 'examples/bottle-and-box.py'), 'utf8') });
  const r1 = await wait(p.id, demo.id);
  const firstHash = r1.revision.sha256;
  const edit = studio.edit(p.id, { kind: 'scene', label: 'Transparent', baseRevisionId: r1.revision.id, code: "bpy.data.objects['Studio | ground'].hide_render = True\nbpy.context.scene.render.film_transparent = True\n" });
  const r2 = await wait(p.id, edit.id);
  assert.notEqual(r2.revision.id, r1.revision.id);
  assert.equal(studio.store.get(p.id).revisions[0].sha256, firstHash);
  studio.store.select(p.id, r1.revision.id, true);
  assert.equal(studio.store.get(p.id).workingRevisionId, r1.revision.id);
  const render = studio.render(p.id, { revisionId: r2.revision.id, stage: 'preview', width: 320, height: 320, samples: 8, transparent: true, device: 'cpu' });
  const output = await wait(p.id, render.id);
  const meta = await sharp(studio.store.file(p.id, output.render.path)).metadata();
  assert.equal(meta.width, 320); assert.equal(meta.height, 320); assert.equal(meta.hasAlpha, true); assert.equal(output.render.hasTransparentPixels, true);
  const fileResponse = await fetch(`${url}/api/projects/${p.id}/file?path=${encodeURIComponent(output.render.preview)}`);
  assert.equal(fileResponse.status, 200);
  assert.equal((await fetch(`${url}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  console.log(JSON.stringify({ passed: true, root, projectId: p.id, render: output.render }, null, 2));
} finally { await runtime.close(); }
