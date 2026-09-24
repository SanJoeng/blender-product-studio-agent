import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { toolDefinitions } from './tool-definitions.js';

const base = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:4318');
if (base.hostname !== '127.0.0.1' || base.protocol !== 'http:') throw new Error('Product Studio MCP requires a loopback server');
const token = process.env.STUDIO_ACCESS_TOKEN;
if (!token) throw new Error('Missing run token');
const server = new McpServer({ name: 'product_studio', version: '0.1.0' }, { instructions: 'Manage only the current product project. Read get_project and relevant skill guidance. Blender work is queued: wait for actual completion, then inspect preview images. Use immutable versions and keep approved choices.' });
for (const [name, definition] of Object.entries(toolDefinitions)) {
  server.registerTool(name, { description: definition.description, inputSchema: definition.schema.shape }, async (args: unknown) => {
    try {
      const response = await fetch(new URL('/internal/tool', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ name, args }), signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw new Error(`Local tool server: ${response.status} ${await response.text()}`);
      return await response.json() as CallToolResult;
    } catch (e) { return { isError: true, content: [{ type: 'text' as const, text: String((e as Error).message) }] }; }
  });
}
await server.connect(new StdioServerTransport());
