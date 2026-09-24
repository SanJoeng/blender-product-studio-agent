import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { APP_ROOT, SKILL_ROOT, discoverExecutable } from './config.js';
import { Store, id, atomicJson } from './store.js';
import { JobQueue, type JobContext } from './jobs.js';
import { type Revision, type Render, type InputFile, now } from './types.js';

const exec = promisify(execFile);
export type EditArgs = { label: string; kind: 'model' | 'scene'; baseRevisionId: string | null; code: string };
export type RenderArgs = { revisionId: string; stage: 'preview' | 'final'; longEdge?: number; width?: number; height?: number; samples?: number; transparent?: boolean; device?: 'auto' | 'gpu' | 'cpu' };
const hash = (p: string) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

export class Studio {
  queue: JobQueue;
  constructor(public store: Store) { this.queue = new JobQueue(store); }
  private async blender(ctx: JobContext, source: string | null, args: string[]) {
    const blender = await discoverExecutable('blender');
    if (!blender) throw new Error('未找到 Blender；请安装 Blender，或设置 BLENDER_PATH');
    // Factory settings avoid dependence on the user's startup file. Auto-exec
    // stays disabled when opening .blend files. Our explicit worker still runs.
    await ctx.run(blender, ['--background', '--factory-startup', '--disable-autoexec', ...(source ? [source] : []), '--python-exit-code', '1', ...args]);
  }
  private async snapshot(ctx: JobContext, projectId: string, source: string | null, output: string, report: string, extra: Record<string, unknown> = {}) {
    const project = this.store.get(projectId), root = this.store.projectDir(projectId);
    const spec = path.join(root, 'jobs', `${ctx.jobId}-${id('step')}.json`);
    atomicJson(spec, { project_root: root, skill_root: SKILL_ROOT, output, report,
      inputs: Object.fromEntries(project.inputs.map(f => [f.id, path.join(root, f.path)])),
      assets: Object.fromEntries(project.assets.map(a => [a.id, { ...a, path: path.join(root, a.path) }])), ...extra });
    await this.blender(ctx, source, ['--python', path.join(APP_ROOT, 'blender', 'execute.py'), '--', spec]);
    ctx.signal.throwIfAborted();
    if (!fs.existsSync(output) || !fs.existsSync(report)) throw new Error('Blender 没有生成可验证的场景和报告');
  }
  edit(projectId: string, args: EditArgs, runId?: string) {
    if (args.code.length > 200000) throw new Error('单次脚本过长，请拆分修改');
    const p = this.store.get(projectId);
    const source = args.baseRevisionId ? this.revisionPath(projectId, args.baseRevisionId) : null;
    const revisionId = id('rev'), dir = path.join(this.store.projectDir(projectId), 'revisions', revisionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'edit.py'), args.code);
    return this.queue.enqueue(projectId, 'edit', args.label, async ctx => {
      const output = path.join(dir, 'scene.blend'), report = path.join(dir, 'report.json');
      await this.snapshot(ctx, projectId, source, output, report, { code_file: path.join(dir, 'edit.py') });
      const revision: Revision = { id: revisionId, label: args.label, kind: args.kind, parentId: args.baseRevisionId,
        path: `revisions/${revisionId}/scene.blend`, report: `revisions/${revisionId}/report.json`, code: `revisions/${revisionId}/edit.py`, createdAt: now(), sha256: hash(output) };
      this.store.update(projectId, next => { next.revisions.push(revision); if (next.workingRevisionId === p.workingRevisionId) next.workingRevisionId = revision.id; });
      return { revision, reportPath: revision.report, note: '场景报告已保存；可用 read_file 查看相机、灯光、依赖和集合。' };
    }, runId);
  }
  revisionPath(projectId: string, revisionId: string) {
    const revision = this.store.get(projectId).revisions.find(r => r.id === revisionId);
    if (!revision) throw new Error('版本不存在');
    return this.store.file(projectId, revision.path);
  }
  render(projectId: string, args: RenderArgs, runId?: string) {
    const source = this.revisionPath(projectId, args.revisionId);
    const renderId = id('render'), relative = `renders/${renderId}`, dir = path.join(this.store.projectDir(projectId), relative);
    if (args.longEdge && (args.width || args.height)) throw new Error('长边与指定宽高只能选一种');
    if ((args.width && !args.height) || (!args.width && args.height)) throw new Error('请同时设置宽和高');
    for (const value of [args.longEdge, args.width, args.height]) if (value !== undefined && (!Number.isInteger(value) || value < 64 || value > 12000)) throw new Error('像素尺寸须为 64–12000 的整数');
    if (args.stage === 'preview' && Math.max(args.longEdge || 0, args.width || 0, args.height || 0) > 1600) throw new Error('预览上限为 1600px；高清请选择正式渲染');
    fs.mkdirSync(dir, { recursive: true });
    return this.queue.enqueue(projectId, 'render', args.stage === 'preview' ? '渲染预览' : '渲染正式图', async ctx => {
      const snapshot = path.join(dir, 'source.blend');
      await this.snapshot(ctx, projectId, source, snapshot, path.join(dir, 'source.report.json'), { freeze: true });
      const output = path.join(dir, 'image.png');
      const options = ['--python', path.join(SKILL_ROOT, 'scripts', 'render_still.py'), '--', '--output', output,
        '--stage', args.stage, '--depth', '16', '--device', args.device || 'auto'];
      if (args.width && args.height) options.push('--size', String(args.width), String(args.height));
      else options.push('--long-edge', String(args.longEdge || (args.stage === 'preview' ? 1000 : 6000)));
      if (args.samples !== undefined) {
        if (!Number.isInteger(args.samples) || args.samples < 1 || args.samples > 4096) throw new Error('采样范围为 1–4096');
        options.push('--samples', String(args.samples));
      }
      if (args.transparent !== undefined) options.push(args.transparent ? '--transparent' : '--opaque');
      await this.blender(ctx, snapshot, options);
      const meta = await sharp(output).metadata();
      // Decode the entire result while generating a browser-safe sRGB preview.
      const preview = path.join(dir, 'preview.png');
      await sharp(output).resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).png().toFile(preview);
      const stats = await sharp(preview).stats();
      const recordPath = path.join(dir, 'image.render.json');
      const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
      if (!meta.width || !meta.height) throw new Error('无法读取渲染图像素尺寸');
      if (args.width && (meta.width !== args.width || meta.height !== args.height)) throw new Error('实际渲染尺寸与请求不同');
      if (args.longEdge && Math.max(meta.width, meta.height) !== args.longEdge) throw new Error('实际渲染长边与请求不同');
      const render: Render = { id: renderId, revisionId: args.revisionId, path: `${relative}/image.png`, preview: `${relative}/preview.png`, record: `${relative}/image.render.json`, snapshot: `${relative}/source.blend`, width: meta.width, height: meta.height, stage: args.stage, transparent: args.transparent ?? Boolean(record.settings?.film_transparent), hasTransparentPixels: meta.hasAlpha && stats.channels.length === 4 && stats.channels[3].min < 255, createdAt: now(), device: record.device?.actual };
      this.store.update(projectId, p => p.renders.push(render));
      return { render, note: render.transparent && !render.hasTransparentPixels ? '图有 Alpha 通道但未检测到透明像素；请检查背景物体或合成器。' : 'PNG 已解码验证；视觉效果仍需检查预览。' };
    }, runId);
  }
  publish(projectId: string, revisionId: string, assetId: string, name: string, collections: string[], runId?: string) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(assetId)) throw new Error('资产 ID 使用小写字母、数字、下划线或短横线');
    if (!collections.length) throw new Error('需指定可链接的集合名称');
    const p = this.store.get(projectId), rev = p.revisions.find(r => r.id === revisionId);
    if (!rev || rev.kind !== 'model') throw new Error('请选择产品模型版本来发布主资产');
    const source = this.revisionPath(projectId, revisionId);
    const dir = path.join(this.store.projectDir(projectId), 'assets', assetId);
    fs.mkdirSync(dir, { recursive: true });
    return this.queue.enqueue(projectId, 'publish', `发布主资产：${name}`, async ctx => {
      // Save to a new sibling first so a failed save cannot corrupt the live library.
      const candidate = path.join(dir, `${ctx.jobId}.blend`);
      await this.snapshot(ctx, projectId, source, candidate, path.join(dir, `${ctx.jobId}.report.json`), { required_collections: collections });
      fs.renameSync(candidate, path.join(dir, 'library.blend'));
      this.store.update(projectId, next => {
        const existing = next.assets.find(a => a.id === assetId);
        const data = { id: assetId, name, path: `assets/${assetId}/library.blend`, revisionId, collections, history: [...(existing?.history || []), revisionId], updatedAt: now() };
        if (existing) Object.assign(existing, data); else next.assets.push(data);
      });
      return { asset: this.store.get(projectId).assets.find(a => a.id === assetId), note: '链接场景在下次重新打开时载入此版主资产。已生成的图片和冻结渲染快照保持原版本。' };
    }, runId);
  }
  importBlend(projectId: string, source: string, label: string, runId?: string) {
    if (path.extname(source).toLowerCase() !== '.blend' || !fs.statSync(source).isFile()) throw new Error('请选择 .blend 文件');
    const revId = id('rev'), root = this.store.projectDir(projectId), dir = path.join(root, 'revisions', revId);
    fs.mkdirSync(dir, { recursive: true });
    return this.queue.enqueue(projectId, 'import', label, async ctx => {
      await this.snapshot(ctx, projectId, path.resolve(source), path.join(dir, 'scene.blend'), path.join(dir, 'report.json'));
      const rev: Revision = { id: revId, label, kind: 'scene', parentId: null, path: `revisions/${revId}/scene.blend`, report: `revisions/${revId}/report.json`, createdAt: now(), sha256: hash(path.join(dir, 'scene.blend')) };
      this.store.update(projectId, p => { p.revisions.push(rev); p.workingRevisionId = rev.id; });
      return { revision: rev, reportPath: rev.report, note: '已另存可编辑的导入版本；可用 read_file 检查场景报告。' };
    }, runId);
  }
  async addInput(projectId: string, name: string, bytes: Buffer, role: InputFile['role']) {
    const inputId = id('input'), safeName = path.basename(name.replaceAll('\\', '/')).replace(/[\x00-\x1f]/g, '_');
    const dir = path.join(this.store.projectDir(projectId), 'inputs', inputId);
    fs.mkdirSync(dir, { recursive: true });
    const source = path.join(dir, safeName);
    fs.writeFileSync(source, bytes);
    const input: InputFile = { id: inputId, name: safeName, path: `inputs/${inputId}/${safeName}`, size: bytes.length, role, createdAt: now() };
    const ext = path.extname(safeName).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.svg', '.heic', '.heif'].includes(ext)) {
      try {
        let imageSource = source;
        if (['.heic', '.heif'].includes(ext) && process.platform === 'darwin') {
          imageSource = path.join(dir, 'converted.png');
          await exec('/usr/bin/sips', ['-s', 'format', 'png', source, '--out', imageSource], { timeout: 30000 });
        }
        await sharp(imageSource, { limitInputPixels: 150000000 }).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).png().toFile(path.join(dir, 'preview.png'));
        input.preview = `inputs/${inputId}/preview.png`;
      } catch { input.warning = '原文件已保存，但此格式暂时不能生成预览；可另传 PNG/JPG 查看副本。'; }
    }
    this.store.update(projectId, p => p.inputs.push(input)); return input;
  }
}
