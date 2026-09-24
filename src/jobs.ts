import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { type Job, now } from './types.js';
import { Store, id } from './store.js';

export type JobContext = { jobId: string; signal: AbortSignal; log: (line: string) => void; run: (exe: string, args: string[], timeoutMs?: number) => Promise<void> };
type Pending = { projectId: string; jobId: string; task: (ctx: JobContext) => Promise<unknown>; controller: AbortController };
export class JobQueue {
  private waiting: Pending[] = [];
  private active: Pending | null = null;
  private closed = false;
  constructor(private store: Store) {}
  enqueue(projectId: string, kind: Job['kind'], label: string, task: Pending['task'], runId?: string) {
    if (this.closed) throw new Error('任务服务正在停止');
    const job: Job = { id: id('job'), projectId, kind, label, runId, status: 'queued', createdAt: now(), log: [] };
    this.store.update(projectId, p => p.jobs.push(job));
    this.waiting.push({ projectId, jobId: job.id, task, controller: new AbortController() });
    void this.pump(); return job;
  }
  get(projectId: string, jobId: string) {
    const j = this.store.get(projectId).jobs.find(j => j.id === jobId);
    if (!j) throw new Error('任务不存在'); return j;
  }
  private update(projectId: string, jobId: string, fn: (j: Job) => void) {
    this.store.update(projectId, p => { const j = p.jobs.find(j => j.id === jobId); if (j) fn(j); });
  }
  async wait(projectId: string, jobId: string, ms = 15000) {
    const end = Date.now() + Math.min(Math.max(ms, 0), 20000);
    while (Date.now() < end && ['queued', 'running'].includes(this.get(projectId, jobId).status)) await new Promise(r => setTimeout(r, 250));
    return this.get(projectId, jobId);
  }
  cancel(projectId: string, jobId: string) {
    const queued = this.waiting.find(p => p.projectId === projectId && p.jobId === jobId);
    if (queued) { this.waiting = this.waiting.filter(p => p !== queued); this.update(projectId, jobId, j => { j.status = 'cancelled'; j.endedAt = now(); }); }
    if (this.active?.projectId === projectId && this.active.jobId === jobId) this.active.controller.abort();
    return this.get(projectId, jobId);
  }
  cancelRun(projectId: string, runId: string) {
    for (const j of this.store.get(projectId).jobs) if (j.runId === runId && ['queued', 'running'].includes(j.status)) this.cancel(projectId, j.id);
  }
  shutdown() { this.closed = true; for (const p of [...this.waiting]) this.cancel(p.projectId, p.jobId); this.active?.controller.abort(); }
  private async pump() {
    if (this.active || this.closed) return;
    const p = this.waiting.shift(); if (!p) return;
    this.active = p;
    this.update(p.projectId, p.jobId, j => { j.status = 'running'; j.startedAt = now(); });
    const logPath = path.join(this.store.projectDir(p.projectId), 'jobs', `${p.jobId}.log`);
    const log = (line: string) => {
      if (!line.trim()) return;
      fs.appendFileSync(logPath, `${line}\n`);
      this.update(p.projectId, p.jobId, j => { j.log.push(line.slice(-1200)); j.log = j.log.slice(-60); });
    };
    try {
      const result = await p.task({ jobId: p.jobId, signal: p.controller.signal, log,
        run: (exe, args, timeoutMs = 30 * 60000) => runProcess(exe, args, this.store.projectDir(p.projectId), p.controller.signal, log, timeoutMs) });
      p.controller.signal.throwIfAborted();
      this.update(p.projectId, p.jobId, j => { j.status = 'completed'; j.result = result; j.endedAt = now(); });
    } catch (e) {
      this.update(p.projectId, p.jobId, j => { j.status = p.controller.signal.aborted ? 'cancelled' : 'failed'; j.error = String((e as Error).message); j.endedAt = now(); });
    } finally { this.active = null; void this.pump(); }
  }
}

export function runProcess(exe: string, args: string[], cwd: string, signal: AbortSignal, log: (line: string) => void, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('任务已取消'));
    const proc = spawn(exe, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    let timedOut = false, killTimer: NodeJS.Timeout | undefined;
    const stop = () => { proc.kill('SIGTERM'); killTimer = setTimeout(() => proc.kill('SIGKILL'), 2500); killTimer.unref(); };
    const timeout = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal.addEventListener('abort', stop, { once: true });
    const buffers = { out: '', err: '' };
    const consume = (key: 'out' | 'err', chunk: Buffer) => {
      buffers[key] += chunk.toString('utf8');
      const lines = buffers[key].split(/[\r\n]+/); buffers[key] = lines.pop() || '';
      for (const line of lines) log(line);
    };
    proc.stdout.on('data', c => consume('out', c)); proc.stderr.on('data', c => consume('err', c));
    const cleanup = () => { clearTimeout(timeout); if (killTimer) clearTimeout(killTimer); signal.removeEventListener('abort', stop); };
    proc.on('error', e => { cleanup(); reject(e); });
    proc.on('close', code => {
      cleanup(); for (const b of Object.values(buffers)) if (b) log(b);
      if (signal.aborted) reject(new Error('任务已取消'));
      else if (timedOut) reject(new Error('任务超过运行时间限制，已停止；请检查日志'));
      else if (code !== 0) reject(new Error(`Blender 退出码 ${code}，请查看任务日志`));
      else resolve();
    });
  });
}
