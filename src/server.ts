import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import { APP_ROOT, DATA_ROOT, PORT, environmentStatus, discoverExecutable } from './config.js';
import { Store } from './store.js';
import { Studio } from './studio.js';
import { ProductAgent } from './agent.js';
import { dispatchTool } from './tools.js';
import { connectorSecret, matchesConnectorSecret } from './connector-auth.js';
import { acquireInstanceLock } from './instance-lock.js';
import { intakeStatus } from './intake.js';

export async function startServer(options: { dataRoot?: string; port?: number } = {}) {
  const releaseLock = acquireInstanceLock(options.dataRoot || DATA_ROOT);
  const store = new Store(options.dataRoot || DATA_ROOT); store.recover();
  const studio = new Studio(store), token = randomBytes(32).toString('hex');
  const externalToken = connectorSecret(store.root);
  const app = express(), server = createServer(app);
  let url = '', agent: ProductAgent;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.get('host') || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return res.status(403).json({ error: '仅允许本机访问' });
    const origin = req.get('origin');
    if (origin && origin !== url && origin !== url.replace('127.0.0.1', 'localhost')) return res.status(403).json({ error: '来源不匹配' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (req.path.startsWith('/api/') && req.method !== 'GET' && req.get('x-studio-token') !== token) return res.status(403).json({ error: '请刷新页面后重试' });
    next();
  });
  app.use(express.json({ limit: '4mb' }));
  const uploads = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024, files: 8 } });
  const summaries = () => store.list().map(p => ({ id: p.id, name: p.name, updatedAt: p.updatedAt, agentStatus: p.agentStatus, revisionCount: p.revisions.length, renderCount: p.renders.length, preview: p.renders.at(-1)?.preview }));
  app.get('/api/bootstrap', async (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json({ token, environment: await environmentStatus(), projects: summaries() }); });
  app.get('/api/projects', (_req, res) => res.json(summaries()));
  app.post('/api/projects', (req, res) => { const body = z.object({ name: z.string().min(1).max(100), brief: z.string().max(20000).default('') }).parse(req.body); res.status(201).json(store.create(body.name, body.brief)); });
  app.get('/api/projects/:id', (req, res) => {
    const p = store.get(req.params.id);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...p, intakeStatus: intakeStatus(p.intake), jobs: p.jobs.slice(-40).map(({ result, ...j }) => j), directory: store.projectDir(p.id) });
  });
  app.patch('/api/projects/:id', (req, res) => {
    const data = z.object({ brief: z.string().max(20000).optional(), notes: z.string().max(30000).optional(), name: z.string().min(1).max(100).optional() }).parse(req.body);
    res.json(store.update(req.params.id, p => { Object.assign(p, data); }));
  });
  app.post('/api/projects/:id/inputs', uploads.array('files', 8), async (req, res) => {
    const role = z.enum(['photo', 'texture', 'reference', 'document']).parse(req.body.role || 'photo');
    const results = [];
    for (const f of (req.files as Express.Multer.File[] || [])) results.push(await studio.addInput(String(req.params.id), Buffer.from(f.originalname, 'latin1').toString('utf8'), f.buffer, role));
    res.json(results);
  });
  app.post('/api/projects/:id/import', (req, res) => {
    const { source } = z.object({ source: z.string().min(1) }).parse(req.body);
    res.json(studio.importBlend(req.params.id, source, `导入 ${path.basename(source)}`));
  });
  app.get('/api/projects/:id/file', (req, res) => {
    const file = store.file(req.params.id, String(req.query.path || ''));
    if (req.query.download === '1' || !/\.(png|jpe?g|webp)$/i.test(file)) return res.download(file);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(file);
  });
  app.post('/api/projects/:id/select', (req, res) => {
    const body = z.object({ revisionId: z.string(), approve: z.boolean().default(false) }).parse(req.body);
    if (store.get(req.params.id).agentStatus === 'running') throw new Error('请等 Agent 本轮完成或先停止，再切换版本');
    res.json(store.select(req.params.id, body.revisionId, body.approve));
  });
  app.post('/api/projects/:id/chat', (req, res) => {
    const body = z.object({ message: z.string().min(1).max(30000), imageIds: z.array(z.string()).max(8).default([]), model: z.string().max(100).default('') }).parse(req.body);
    res.status(202).json(agent.start(req.params.id, body.message, body.imageIds, body.model));
  });
  app.post('/api/projects/:id/stop', (req, res) => res.json(agent.cancel(req.params.id)));
  app.post('/api/projects/:id/render', (req, res) => {
    const body = z.object({ revisionId: z.string(), stage: z.enum(['preview', 'final']).default('preview'), longEdge: z.number().int().optional(), width: z.number().int().optional(), height: z.number().int().optional(), samples: z.number().int().min(1).max(4096).optional(), transparent: z.boolean().optional(), device: z.enum(['auto', 'gpu', 'cpu']).default('auto') }).parse(req.body);
    res.status(202).json(studio.render(req.params.id, body));
  });
  app.post('/api/projects/:id/jobs/:jobId/cancel', (req, res) => res.json(studio.queue.cancel(req.params.id, req.params.jobId)));
  app.post('/api/projects/:id/open', async (req, res) => {
    const { revisionId } = z.object({ revisionId: z.string() }).parse(req.body);
    const file = studio.revisionPath(req.params.id, revisionId), exe = await discoverExecutable('blender');
    if (!exe) throw new Error('未找到 Blender');
    const child = spawn(exe, ['--disable-autoexec', file], { detached: true, stdio: 'ignore' }); child.on('error', () => {}); child.unref();
    res.json({ opened: true });
  });
  app.post('/api/projects/:id/demo', (req, res) => {
    const projectId = req.params.id;
    const job = studio.edit(projectId, { label: '通用瓶盒 · 中性摄影示例', kind: 'scene', baseRevisionId: null, code: fs.readFileSync(path.join(APP_ROOT, 'examples', 'bottle-and-box.py'), 'utf8') });
    // A deterministic, clearly labelled fixture: it also works before login.
    void (async () => {
      let current = await studio.queue.wait(projectId, job.id, 15000);
      while (['queued', 'running'].includes(current.status)) current = await studio.queue.wait(projectId, job.id, 15000);
      if (current.status === 'completed') {
        const revisionId = (current.result as any).revision.id;
        studio.render(projectId, { revisionId, stage: 'preview', longEdge: 800, samples: 24, device: 'auto' });
      }
    })().catch(error => console.error('Demo task:', String(error)));
    res.status(202).json(job);
  });
  app.post('/internal/tool', async (req, res) => {
    const access = agent.tokens.get((req.get('authorization') || '').replace(/^Bearer /, ''));
    if (!access || access.controller.signal.aborted) return res.status(403).json({ error: 'Agent 本轮已结束' });
    try { res.json(await dispatchTool(studio, access.projectId, access.runId, req.body.name, req.body.args)); }
    catch (e) { res.json({ isError: true, content: [{ type: 'text', text: String((e as Error).message) }] }); }
  });
  app.post('/internal/connector', async (req, res) => {
    const candidate = (req.get('authorization') || '').replace(/^Bearer /, '');
    if (!matchesConnectorSecret(externalToken, candidate)) return res.status(403).json({ error: '本机 MCP 连接凭证无效' });
    try {
      const body = z.object({ name: z.string(), projectId: z.string().optional(), args: z.unknown().default({}) }).parse(req.body);
      if (body.name === 'list_projects') return res.json({ content: [{ type: 'text', text: JSON.stringify(summaries()) }] });
      if (body.name === 'create_project') {
        const args = z.object({ name: z.string().min(1).max(100), brief: z.string().max(20000).default('') }).parse(body.args);
        const project = store.create(args.name, args.brief);
        return res.json({ content: [{ type: 'text', text: JSON.stringify({ projectId: project.id, name: project.name }) }] });
      }
      if (!body.projectId) throw new Error('先用 select_project 选择项目');
      if (body.name === 'select_project') {
        const project = store.get(body.projectId);
        return res.json({ content: [{ type: 'text', text: JSON.stringify({ projectId: project.id, name: project.name }) }] });
      }
      res.json(await dispatchTool(studio, body.projectId, 'external-mcp', body.name, body.args));
    } catch (error) { res.json({ isError: true, content: [{ type: 'text', text: String((error as Error).message) }] }); }
  });
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.flushHeaders();
    res.write('data: {}\n\n');
    const onChange = (projectId: string) => res.write(`data: ${JSON.stringify({ projectId })}\n\n`);
    const heartbeat = setInterval(() => res.write(': alive\n\n'), 15000);
    store.on('change', onChange);
    req.on('close', () => { clearInterval(heartbeat); store.off('change', onChange); });
  });
  app.use(express.static(path.join(APP_ROOT, 'public'), { dotfiles: 'deny' }));
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(400).json({ error: error.message }); });
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? PORT, '127.0.0.1', resolve); }); }
  catch (error) { releaseLock(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法启动本地服务');
  url = `http://127.0.0.1:${address.port}`;
  agent = new ProductAgent(studio, url);
  return { app, server, studio, agent, token, url, close: async () => {
    agent.shutdown(); studio.queue.shutdown();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    releaseLock();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const runtime = await startServer();
  console.log(`Product Studio Agent · ${runtime.url}`);
  console.log('工作资料保存在 ' + DATA_ROOT);
  if (process.argv.includes('--open')) {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    const child = spawn(command, [runtime.url], { stdio: 'ignore' }); child.on('error', () => {}); child.unref();
  }
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await runtime.close(); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
