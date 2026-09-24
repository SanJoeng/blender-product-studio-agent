import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SKILL_ROOT } from './config.js';
import { type Studio } from './studio.js';
import { toolDefinitions, type ToolName } from './tool-definitions.js';
import { intakeStatus, requireNewProductIntake } from './intake.js';

export async function dispatchTool(studio: Studio, projectId: string, runId: string, name: string, args: unknown): Promise<CallToolResult> {
  const definition = toolDefinitions[name as ToolName];
  if (!definition) throw new Error('未知工具');
  const data = definition.schema.parse(args) as any;
  let value: unknown;
  switch (name) {
    case 'get_project': {
      const p = studio.store.get(projectId);
      value = { projectId, projectRoot: studio.store.projectDir(projectId), name: p.name, brief: p.brief, notes: p.notes, intake: p.intake || {}, intakeStatus: intakeStatus(p.intake), workingRevisionId: p.workingRevisionId, approvedRevisionId: p.approvedRevisionId, inputs: p.inputs, revisions: p.revisions.slice(-30), renders: p.renders.slice(-12), assets: p.assets, jobs: p.jobs.slice(-6).map(({ result, ...j }) => j) }; break;
    }
    case 'record_intake': {
      const current = studio.store.get(projectId);
      for (const answer of Object.values(data.fields) as Array<{ source: string }>) {
        if (answer.source === 'reference' && !current.inputs.length) throw new Error('尚未导入参考文件，不能把条目记录为参考证据');
        if (answer.source === 'existing_scene' && !current.revisions.length) throw new Error('尚无已有场景版本，不能把条目记录为场景证据');
      }
      const p = studio.store.update(projectId, next => { next.intake = { ...(next.intake || {}), ...data.fields }; });
      value = { intake: p.intake, intakeStatus: intakeStatus(p.intake) }; break;
    }
    case 'read_skill': {
      const file = fs.realpathSync(path.resolve(SKILL_ROOT, data.path));
      if (!file.startsWith(fs.realpathSync(SKILL_ROOT) + path.sep) || !/\.(md|json|py|yaml)$/.test(file)) throw new Error('只可读取技能目录中的文本资源');
      value = fs.readFileSync(file, 'utf8'); break;
    }
    case 'read_file': {
      const file = studio.store.file(projectId, data.path);
      if (!/\.(md|txt|json|svg|py|csv|yaml|log)$/i.test(file)) throw new Error('此工具仅用于文本；图像请用 view_image');
      if (fs.statSync(file).size > 50 * 1024 * 1024) throw new Error('文件过大');
      const text = fs.readFileSync(file, 'utf8'); value = { text: text.slice(data.offset, data.offset + data.limit), totalCharacters: text.length, nextOffset: data.offset + data.limit < text.length ? data.offset + data.limit : null }; break;
    }
    case 'view_image': {
      const file = studio.store.file(projectId, data.path);
      const buffer = await sharp(file, { limitInputPixels: 150000000 }).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      return { content: [{ type: 'image', mimeType: 'image/png', data: buffer.toString('base64') }] };
    }
    case 'import_local_input': {
      const source = fs.realpathSync(data.source);
      const stat = fs.statSync(source);
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('请选择不超过 64MB 的本地文件');
      value = await studio.addInput(projectId, path.basename(source), fs.readFileSync(source), data.role); break;
    }
    case 'import_blend_path': value = studio.importBlend(projectId, data.source, data.label, runId); break;
    case 'edit_scene': {
      if (data.baseRevisionId === null || data.kind === 'model') requireNewProductIntake(studio.store.get(projectId).intake);
      value = studio.edit(projectId, data, runId); break;
    }
    case 'render_scene': value = studio.render(projectId, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null)) as any, runId); break;
    case 'get_job': value = await studio.queue.wait(projectId, data.jobId, data.waitMs); break;
    case 'cancel_job': value = studio.queue.cancel(projectId, data.jobId); break;
    case 'publish_asset': value = studio.publish(projectId, data.revisionId, data.assetId, data.name, data.collections, runId); break;
    case 'select_revision': { const p = studio.store.select(projectId, data.revisionId, data.approve); value = { workingRevisionId: p.workingRevisionId, approvedRevisionId: p.approvedRevisionId }; break; }
    case 'save_notes': studio.store.update(projectId, p => { p.notes = data.notes; }); value = { saved: true }; break;
    case 'import_uploaded_blend': {
      const file = studio.store.get(projectId).inputs.find(f => f.id === data.inputId);
      if (!file) throw new Error('资料不存在');
      value = studio.importBlend(projectId, studio.store.file(projectId, file.path), data.label, runId); break;
    }
  }
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length > 45000) text = text.slice(0, 45000) + '\n[结果截断；完整场景报告可用 read_file 按 offset 分页读取。]';
  return { content: [{ type: 'text', text }] };
}
