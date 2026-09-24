const $ = selector => document.querySelector(selector);
const state = { token: '', projects: [], project: null, environment: null, selectedRender: null, selectedInputs: new Set(), tab: 'preview', model: localStorage.getItem('studio-model') || '' };
const welcome = $('#messages').innerHTML;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const date = value => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
let toastTimer, refreshTimer, messagesSignature = '', inputsSignature = '', versionsSignature = '';
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 6500); }
function on(selector, type, handler) { $(selector).addEventListener(type, event => { Promise.resolve(handler(event)).catch(e => toast(e.message)); }); }
async function api(route, body, method = 'POST') {
  const opts = { method: body === undefined ? 'GET' : method, headers: {} };
  if (body !== undefined) { opts.headers['x-studio-token'] = state.token; if (body instanceof FormData) opts.body = body; else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); } }
  const response = await fetch(route, opts); const data = await response.json(); if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`); return data;
}
function projectRoute(suffix = '') { if (!state.project) throw new Error('请先创建项目'); return `/api/projects/${state.project.id}${suffix}`; }
function fileUrl(relative, download = false, projectId = state.project?.id) { return `/api/projects/${projectId}/file?path=${encodeURIComponent(relative)}${download ? '&download=1' : ''}`; }
function tab(name) { state.tab = name; document.querySelectorAll('.tab').forEach(b => { b.classList.toggle('active', b.dataset.tab === name); b.setAttribute('aria-selected', String(b.dataset.tab === name)); }); document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === `panel-${name}`)); if (state.project) drawProject(); }
function drawProjects() {
  $('#project-count').textContent = state.projects.length;
  $('#projects').innerHTML = state.projects.map(p => `<button class="project-item ${p.id === state.project?.id ? 'active' : ''}" data-project="${p.id}"><strong>${escape(p.name)}</strong><small>${p.agentStatus === 'running' ? '正在工作…' : `${p.revisionCount} 个版本 · ${p.renderCount} 张图`}</small></button>`).join('');
}
async function selectProject(projectId) {
  state.selectedInputs.clear(); state.selectedRender = null; inputsSignature = versionsSignature = messagesSignature = '';
  state.project = await api(`/api/projects/${projectId}`); localStorage.setItem('studio-project', projectId); drawProjects(); drawProject();
}
async function refresh() {
  const projectId = state.project?.id;
  const [projects, project] = await Promise.all([api('/api/projects'), projectId ? api(`/api/projects/${projectId}`) : null]);
  state.projects = projects;
  if (project && state.project?.id === projectId) {
    if (project.renders.length > state.project.renders.length) state.selectedRender = project.renders.at(-1)?.id;
    state.project = project; drawProject();
  }
  drawProjects();
}
function scheduleRefresh() { if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = null; refresh().catch(e => toast(e.message)); }, 500); }
function drawProject() {
  const p = state.project; if (!p) return;
  $('#project-title').textContent = p.name;
  $('#brief-button').disabled = false; $('#render-button').disabled = !p.workingRevisionId;
  $('#start-project').textContent = '添加产品资料';
  const busy = p.agentStatus === 'running', runningJobs = p.jobs.filter(j => ['queued', 'running'].includes(j.status));
  $('#job-dot').style.display = runningJobs.length ? 'inline-block' : 'none';
  $('#send-message').disabled = busy; $('#stop-agent').hidden = !busy;
  $('#chat-status').textContent = busy ? '正在工作' : p.agentStatus === 'failed' ? '需要处理' : '就绪';
  $('#agent-state').textContent = busy ? 'Agent 工作中' : runningJobs.length ? `${runningJobs.length} 个任务进行中` : p.workingRevisionId ? '当前版本已保存' : '等待资料';
  $('#agent-state').classList.toggle('busy', busy || Boolean(runningJobs.length));
  $('#chat-error').hidden = !p.agentError; $('#chat-error').textContent = p.agentError || '';
  const activity = p.activities.at(-1); $('#activity').hidden = !busy;
  const toolNames = { get_project: '读取项目状态', read_skill: '查阅专业规范', edit_scene: '建立 / 修改 Blender 场景', render_scene: '准备渲染', get_job: '检查任务进度', view_image: '检查预览画面', save_notes: '记录项目选择', read_file: '读取资料', publish_asset: '发布主资产', select_revision: '切换版本' };
  $('#activity').textContent = `◌ ${activity ? (toolNames[activity.label] || activity.label) : '正在理解需求…'}`;
  const sig = JSON.stringify(p.messages);
  if (sig !== messagesSignature) {
    const messages = $('#messages'), atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100;
    const emptyBefore = !messagesSignature; messagesSignature = sig;
    messages.innerHTML = p.messages.length ? '' : welcome;
    for (const m of p.messages) {
      const wrap = document.createElement('div'); wrap.className = `message ${m.role}`;
      const role = document.createElement('div'); role.className = 'role'; role.textContent = m.role === 'user' ? '你' : 'Product Studio';
      const body = document.createElement('div'); body.className = 'body'; body.append(formatMessage(m.text)); wrap.append(role, body); messages.append(wrap);
    }
    if (atBottom || emptyBefore) messages.scrollTop = messages.scrollHeight;
  }
  drawAttachments();
  if (state.tab === 'preview') drawPreview();
  if (state.tab === 'inputs') drawInputs();
  if (state.tab === 'versions') drawVersions();
  if (state.tab === 'jobs') drawJobs();
}
function formatMessage(text) {
  const fragment = document.createDocumentFragment();
  const pattern = /\[([^\]]+)\]\(([^\n]+?)\)/g; let last = 0;
  for (const match of text.matchAll(pattern)) {
    fragment.append(document.createTextNode(text.slice(last, match.index)));
    const target = match[2].replace(/^<|>$/g, ''); let href = null;
    if (target.startsWith(`${state.project.directory}/`)) href = fileUrl(target.slice(state.project.directory.length + 1), true);
    else if (/^https?:\/\//.test(target)) href = target;
    if (href) { const link = document.createElement('a'); link.href = href; link.textContent = match[1]; link.target = '_blank'; link.rel = 'noopener noreferrer'; fragment.append(link); }
    else fragment.append(document.createTextNode(match[0]));
    last = match.index + match[0].length;
  }
  fragment.append(document.createTextNode(text.slice(last))); return fragment;
}
function drawPreview() {
  const p = state.project, render = p.renders.find(r => r.id === state.selectedRender) || p.renders.at(-1);
  $('#empty-preview').hidden = Boolean(render); $('#preview-image').hidden = !render; $('#image-tools').hidden = !render;
  if (render) {
    const src = fileUrl(render.preview); if ($('#preview-image').getAttribute('src') !== src) $('#preview-image').src = src;
    state.selectedRender = render.id;
    const rev = p.revisions.find(r => r.id === render.revisionId);
    $('#preview-label').textContent = rev?.label || '渲染图';
    $('#preview-meta').textContent = `${render.width} × ${render.height} px · ${render.hasTransparentPixels ? '含透明背景' : '不透明画面'} · ${render.stage === 'preview' ? '预览' : '正式图'} · ${date(render.createdAt)}`;
    $('#download-image').href = fileUrl(render.path, true);
    if (!$('#viewer').dataset.chosenBg) $('#viewer').className = 'viewer checker';
  } else { $('#preview-label').textContent = '尚未生成预览'; $('#preview-meta').textContent = p.workingRevisionId ? '已有场景版本，可以渲染小预览' : '上传资料后，告诉 Agent 你的产品与摄影需求'; }
  $('#filmstrip').innerHTML = p.renders.slice().reverse().map(r => `<button class="thumbnail ${r.id === render?.id ? 'selected' : ''}" data-render="${r.id}" title="${escape(p.revisions.find(v => v.id === r.revisionId)?.label || '')}"><img src="${fileUrl(r.preview)}" alt="渲染缩略图"><small>${r.width} × ${r.height}</small></button>`).join('');
}
function drawAttachments() { $('#attachments').innerHTML = [...state.selectedInputs].map(inputId => { const f = state.project.inputs.find(f => f.id === inputId); return f ? `<button type="button" data-remove-input="${f.id}" title="移除附图">${escape(f.name)} ×</button>` : ''; }).join(''); }
function drawInputs() {
  const p = state.project, sig = JSON.stringify([p.inputs, [...state.selectedInputs]]); if (sig === inputsSignature) return; inputsSignature = sig;
  const roles = { photo: '实拍', texture: '贴图', reference: '参考', document: '说明' };
  $('#input-list').innerHTML = p.inputs.map(f => `<button class="input-card ${state.selectedInputs.has(f.id) ? 'selected' : ''}" data-input="${f.id}" title="${escape(f.warning || f.name)}">${f.preview ? `<img src="${fileUrl(f.preview)}" alt="${escape(f.name)}">` : `<div class="file-symbol">${escape(f.name.split('.').pop()?.toUpperCase())}</div>`}<strong>${escape(f.name)}</strong><small>${roles[f.role]} · ${(f.size / 1024 / 1024).toFixed(1)} MB${f.warning ? ' · 预览未生成' : ''}</small></button>`).join('') || '<p class="empty-list">实拍、尺寸、刀模和摄影参考都可以放在这里。</p>';
}
function drawVersions() {
  const p = state.project, sig = JSON.stringify([p.revisions, p.workingRevisionId, p.approvedRevisionId, p.assets, p.agentStatus]); if (sig === versionsSignature) return; versionsSignature = sig;
  $('#version-list').innerHTML = p.revisions.slice().reverse().map((v, index) => `<article class="version-card ${p.workingRevisionId === v.id ? 'current' : ''}"><h3>${escape(v.label)}${p.workingRevisionId === v.id ? '<span class="card-tag">工作版</span>' : ''}${p.approvedRevisionId === v.id ? '<span class="card-tag">已确认</span>' : ''}</h3><p>${v.kind === 'model' ? '主模型' : '摄影场景'} · 版本 ${p.revisions.length - index} · ${date(v.createdAt)}</p><div class="card-actions"><button class="button small" data-select="${v.id}" ${p.agentStatus === 'running' ? 'disabled' : ''}>设为当前</button><button class="button small subtle" data-approve="${v.id}" ${p.agentStatus === 'running' ? 'disabled' : ''}>确认此版</button><button class="button small subtle" data-open="${v.id}">Blender 打开 ↗</button><a class="button small subtle" href="${fileUrl(v.path, true)}">.blend ↓</a></div></article>`).join('') || '<p class="empty-list">Agent 建模或导入 .blend 后，版本会出现在这里。</p>';
  $('#asset-list').innerHTML = p.assets.length ? `<h3>已发布主资产</h3>${p.assets.map(a => `<div class="asset-row"><strong>${escape(a.name)}</strong><br>链接集合：${escape(a.collections.join('、'))}<br>发布于 ${date(a.updatedAt)}</div>`).join('')}` : '';
}
function drawJobs() {
  const opened = new Set([...$('#job-list').querySelectorAll('details[open]')].map(d => d.dataset.job));
  const statuses = { queued: '排队中', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已停止' };
  $('#job-list').innerHTML = state.project.jobs.slice().reverse().map(j => `<article class="job-card"><div class="job-heading"><div><h3>${escape(j.label)}</h3><time>${date(j.createdAt)}</time></div><span class="status ${j.status}">${statuses[j.status]}</span></div>${j.error ? `<p class="job-error">${escape(j.error)}</p>` : ''}${['queued','running'].includes(j.status) ? `<button class="button small subtle" data-cancel-job="${j.id}" style="margin-top:12px">停止任务</button>` : ''}<details data-job="${j.id}" ${opened.has(j.id) ? 'open' : ''}><summary>查看实际执行日志</summary><pre>${escape(j.log.join('\n') || '等待开始…')}</pre></details></article>`).join('') || '<p class="empty-list">建模和渲染任务会显示在这里。</p>';
}
async function createProject(name, brief = '') { const p = await api('/api/projects', { name, brief }); state.projects = await api('/api/projects'); await selectProject(p.id); return p; }
async function upload(files) {
  if (!state.project) { $('#project-dialog').showModal(); return; }
  if (!files.length) return; if (files.length > 8) throw new Error('一次最多上传 8 个文件');
  const form = new FormData(); form.append('role', $('#input-role').value); for (const file of files) form.append('files', file);
  toast('正在保存资料并生成预览…'); const result = await api(projectRoute('/inputs'), form);
  for (const f of result) if (f.preview && state.selectedInputs.size < 8) state.selectedInputs.add(f.id);
  inputsSignature = ''; await refresh(); toast(`已添加 ${result.length} 个文件，可在对话中说明如何使用`);
}
on('#new-project', 'click', () => $('#project-dialog').showModal());
on('#start-project', 'click', () => state.project ? tab('inputs') : $('#project-dialog').showModal());
on('#project-form', 'submit', async e => { e.preventDefault(); await createProject($('#project-name').value, $('#project-brief').value); $('#project-dialog').close(); $('#project-form').reset(); tab('inputs'); });
on('#demo-button', 'click', async () => { if (!state.project) await createProject('瓶盒摄影示例', '通用瓶盒示例，用于体验本地 Blender 工作流。尺寸与材质均为示例起点。'); $('#demo-button').disabled = true; try { await api(projectRoute('/demo'), {}); tab('jobs'); toast('已开始实际建模，完成后自动渲染 800px 预览'); } finally { $('#demo-button').disabled = false; } });
on('#projects', 'click', async e => { const button = e.target.closest('[data-project]'); if (button) await selectProject(button.dataset.project); });
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => tab(b.dataset.tab)));
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
on('#messages', 'click', e => { const button = e.target.closest('[data-prompt]'); if (button) { $('#message-input').value = button.dataset.prompt; $('#message-input').focus(); } });
on('#filmstrip', 'click', e => { const button = e.target.closest('[data-render]'); if (button) { state.selectedRender = button.dataset.render; drawPreview(); } });
on('#image-tools', 'click', e => { const button = e.target.closest('[data-bg]'); if (button) { $('#viewer').className = `viewer ${button.dataset.bg}`; $('#viewer').dataset.chosenBg = 'yes'; } });
on('#input-list', 'click', e => { const button = e.target.closest('[data-input]'); if (!button) return; const input = state.project.inputs.find(f => f.id === button.dataset.input); if (!input?.preview) { window.open(fileUrl(input.path, true), '_blank', 'noopener'); return; } if (state.selectedInputs.has(input.id)) state.selectedInputs.delete(input.id); else if (state.selectedInputs.size < 8) state.selectedInputs.add(input.id); else throw new Error('一次最多附 8 张图'); drawInputs(); drawAttachments(); });
on('#attachments', 'click', e => { const button = e.target.closest('[data-remove-input]'); if (button) { state.selectedInputs.delete(button.dataset.removeInput); drawAttachments(); inputsSignature = ''; } });
on('#file-input', 'change', async e => { await upload([...e.target.files]); e.target.value = ''; });
for (const event of ['dragenter', 'dragover']) $('#drop-zone').addEventListener(event, e => { e.preventDefault(); $('#drop-zone').classList.add('drag'); });
for (const event of ['dragleave', 'drop']) $('#drop-zone').addEventListener(event, e => { e.preventDefault(); $('#drop-zone').classList.remove('drag'); });
on('#drop-zone', 'drop', e => upload([...e.dataTransfer.files]));
on('#import-form', 'submit', async e => { e.preventDefault(); await api(projectRoute('/import'), { source: $('#blend-path').value.trim().replace(/^['"]|['"]$/g, '') }); $('#blend-path').value = ''; tab('jobs'); toast('正在导入场景副本'); });
on('#chat-form', 'submit', async e => { e.preventDefault(); const message = $('#message-input').value.trim(); if (!message) return; await api(projectRoute('/chat'), { message, imageIds: [...state.selectedInputs], model: state.model }); $('#message-input').value = ''; state.selectedInputs.clear(); await refresh(); $('#messages').scrollTop = $('#messages').scrollHeight; });
on('#message-input', 'keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); $('#chat-form').requestSubmit(); } });
on('#stop-agent', 'click', async () => { await api(projectRoute('/stop'), {}); toast('正在停止本轮和它启动的任务…'); });
on('#brief-button', 'click', () => { $('#brief-edit').value = state.project.brief; $('#notes-edit').value = state.project.notes; $('#project-directory').textContent = state.project.directory; $('#brief-dialog').showModal(); });
on('#brief-form', 'submit', async e => { e.preventDefault(); await api(projectRoute(), { brief: $('#brief-edit').value, notes: $('#notes-edit').value }, 'PATCH'); $('#brief-dialog').close(); await refresh(); toast('档案已保存'); });
on('#version-list', 'click', async e => { const select = e.target.closest('[data-select]'), approve = e.target.closest('[data-approve]'), open = e.target.closest('[data-open]'); if (select || approve) { await api(projectRoute('/select'), { revisionId: (select || approve).dataset[select ? 'select' : 'approve'], approve: Boolean(approve) }); await refresh(); toast(approve ? '已设为确认版本' : '已切换工作版本'); } if (open) { await api(projectRoute('/open'), { revisionId: open.dataset.open }); toast('已请求 Blender 打开此版本'); } });
on('#job-list', 'click', async e => { const button = e.target.closest('[data-cancel-job]'); if (button) { await api(projectRoute(`/jobs/${button.dataset.cancelJob}/cancel`), {}); await refresh(); } });
on('#render-button', 'click', () => { const revision = state.project.revisions.find(r => r.id === state.project.workingRevisionId); $('#render-source').textContent = `当前场景：${revision.label}`; $('#render-dialog').showModal(); });
on('#render-stage', 'change', () => { $('#render-edge').value = $('#render-stage').value === 'final' ? '6000' : '1000'; });
on('#size-mode', 'change', () => { $('#edge-field').hidden = $('#size-mode').value === 'exact'; $('#exact-fields').hidden = $('#size-mode').value !== 'exact'; });
on('#render-form', 'submit', async e => { e.preventDefault(); const body = { revisionId: state.project.workingRevisionId, stage: $('#render-stage').value, device: $('#render-device').value }; if ($('#size-mode').value === 'edge') body.longEdge = Number($('#render-edge').value); else { body.width = Number($('#render-width').value); body.height = Number($('#render-height').value); } if ($('#render-alpha').value !== 'keep') body.transparent = $('#render-alpha').value === 'transparent'; await api(projectRoute('/render'), body); $('#render-dialog').close(); tab('jobs'); toast('已加入渲染队列'); });
on('#settings-button', 'click', () => { const env = state.environment; $('#environment-detail').innerHTML = `<p><strong>Blender ${env.blender.ok ? '已连接' : '未找到'}</strong><br>${escape(env.blender.detail.split('\n')[0])}<br><code>${escape(env.blender.path || '可通过 BLENDER_PATH 指定路径')}</code></p><p><strong>Codex ${env.codex.ok ? '已登录' : '尚未登录'}</strong><br>${escape(env.codex.detail)}</p>`; $('#model-name').value = state.model; $('#settings-dialog').showModal(); });
on('#save-settings', 'click', () => { state.model = $('#model-name').value.trim(); localStorage.setItem('studio-model', state.model); $('#settings-dialog').close(); toast('后续对话将使用此设置'); });

try {
  const data = await api('/api/bootstrap'); state.token = data.token; state.projects = data.projects; state.environment = data.environment;
  $('#environment-badge').textContent = data.environment.blender.ok ? '● Blender 已连接' : '○ 请安装 Blender';
  const remembered = localStorage.getItem('studio-project'), first = data.projects.find(p => p.id === remembered) || data.projects[0];
  if (first) await selectProject(first.id); drawProjects();
  const events = new EventSource('/api/events'); events.onmessage = e => { const data = JSON.parse(e.data); if (data.projectId) scheduleRefresh(); };
  setInterval(() => { if (state.project?.agentStatus === 'running' || state.project?.jobs.some(j => ['queued','running'].includes(j.status))) scheduleRefresh(); }, 5000);
} catch (e) { $('#environment-badge').textContent = '连接失败'; toast(e.message); }
