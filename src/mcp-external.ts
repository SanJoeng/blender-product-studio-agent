/** Model-neutral local stdio MCP adapter. No Codex login or SDK is used here. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { DATA_ROOT, PORT } from './config.js';
import { connectorSecret } from './connector-auth.js';
import { toolDefinitions } from './tool-definitions.js';

const base = new URL(process.env.STUDIO_URL || `http://127.0.0.1:${PORT}`);
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw new Error('MCP 只能连接本机 127.0.0.1 服务');
const token = connectorSecret(DATA_ROOT);
let projectId = process.env.STUDIO_PROJECT_ID || '';
const server = new McpServer({ name: 'product_studio', version: '0.1.0' }, {
  instructions: 'Local Blender product studio. First list_projects, then select_project (or create_project), then get_project. Read bundled SKILL.md with read_skill. For a new product inspect references and use record_intake. If intakeStatus lists missing facts, ask the user those necessary questions together and wait; do not make a prototype first or invent evidence. Blender jobs are asynchronous: use get_job until completed and view_image after previews. Every edit makes a new revision. Do not publish shared model changes or approve a version without user authorization.',
});

async function call(name: string, args: unknown, selected = projectId): Promise<CallToolResult> {
  try {
    const response = await fetch(new URL('/internal/connector', base), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, projectId: selected || undefined, args }), signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) throw new Error(`工作室未连接 (${response.status})；请先启动 npm start，核对 STUDIO_URL 和 STUDIO_DATA_DIR`);
    return await response.json() as CallToolResult;
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: String((error as Error).message) }] };
  }
}

server.registerTool('list_projects', { description: 'List local product projects. Select one before operating on its files.', inputSchema: z.object({}).shape }, async () => call('list_projects', {}));
server.registerTool('create_project', { description: 'Create a local product project from a name and product brief, and select it for this MCP connection.', inputSchema: z.object({ name: z.string().min(1).max(100), brief: z.string().max(20000).default('') }).shape }, async args => {
  const result = await call('create_project', args);
  if (!result.isError) projectId = JSON.parse((result.content[0] as { text: string }).text).projectId;
  return result;
});
server.registerTool('select_project', { description: 'Select an existing project ID for this MCP connection. Other clients keep their own selection.', inputSchema: z.object({ projectId: z.string() }).shape }, async args => {
  const result = await call('select_project', {}, args.projectId);
  if (!result.isError) projectId = args.projectId;
  return result;
});
for (const [name, definition] of Object.entries(toolDefinitions)) {
  server.registerTool(name, { description: definition.description, inputSchema: definition.schema.shape }, async (args: unknown) => {
    if (!projectId) return { isError: true, content: [{ type: 'text' as const, text: '先调用 list_projects，再用 select_project 选择项目；或调用 create_project。' }] };
    return call(name, args);
  });
}
await server.connect(new StdioServerTransport());
