import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { type Project, now } from './types.js';

export const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
export function atomicJson(file: string, value: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

export class Store extends EventEmitter {
  constructor(public root: string) { super(); fs.mkdirSync(root, { recursive: true }); }
  projectDir(projectId: string) {
    if (!/^prj_[a-f0-9]{16}$/.test(projectId)) throw new Error('项目 ID 无效');
    return path.join(this.root, 'projects', projectId);
  }
  get(projectId: string): Project {
    const file = path.join(this.projectDir(projectId), 'project.json');
    if (!fs.existsSync(file)) throw new Error('项目不存在');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  list(): Project[] {
    const dir = path.join(this.root, 'projects');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(n => /^prj_[a-f0-9]{16}$/.test(n)).flatMap(n => {
      try { return [this.get(n)]; } catch { return []; }
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  create(name: string, brief = '') {
    if (!name.trim()) throw new Error('请输入项目名称');
    const p: Project = { id: id('prj'), name: name.trim().slice(0, 100), brief: brief.slice(0, 20000), notes: '', intake: {}, createdAt: now(), updatedAt: now(), workingRevisionId: null, approvedRevisionId: null, threadId: null, inputs: [], revisions: [], renders: [], assets: [], jobs: [], messages: [], activities: [], agentStatus: 'idle' };
    for (const dir of ['inputs', 'revisions', 'renders', 'jobs', 'assets']) fs.mkdirSync(path.join(this.projectDir(p.id), dir), { recursive: true });
    this.save(p);
    return p;
  }
  save(project: Project) {
    project.updatedAt = now();
    atomicJson(path.join(this.projectDir(project.id), 'project.json'), project);
    this.emit('change', project.id);
    return project;
  }
  update(projectId: string, fn: (project: Project) => void) {
    const p = this.get(projectId); fn(p); return this.save(p);
  }
  recover() {
    for (const p of this.list()) {
      let dirty = false;
      if (p.agentStatus === 'running') { p.agentStatus = 'failed'; p.agentError = '服务已重启。可发送消息继续已有对话。'; dirty = true; }
      for (const j of p.jobs) if (j.status === 'running' || j.status === 'queued') {
        j.status = 'failed'; j.error = '服务在任务完成前中断；保留现场，请检查后重新发起。'; j.endedAt = now(); dirty = true;
      }
      if (dirty) this.save(p);
    }
  }
  /** Resolve existing artifacts, rejecting traversal and symlink escapes. */
  file(projectId: string, relative: string) {
    const root = fs.realpathSync(this.projectDir(projectId));
    const candidate = path.resolve(root, relative);
    if (candidate === root || !candidate.startsWith(root + path.sep)) throw new Error('文件超出项目目录');
    const resolved = fs.realpathSync(candidate);
    if (!resolved.startsWith(root + path.sep) || !fs.statSync(resolved).isFile()) throw new Error('文件不属于此项目');
    return resolved;
  }
  select(projectId: string, revisionId: string, approve = false) {
    return this.update(projectId, p => {
      if (!p.revisions.some(r => r.id === revisionId)) throw new Error('找不到版本');
      p.workingRevisionId = revisionId;
      if (approve) p.approvedRevisionId = revisionId;
    });
  }
}
