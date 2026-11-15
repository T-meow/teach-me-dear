import fs from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { TOOLS } from '../src/tools.mjs';

const store = new Store();
const engine = new Engine(store);
const server = new Server({ name: 'teach-me-dear', version: '0.2.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    const result = await engine.call(request.params.name, request.params.arguments || {});
    const { imagePath, ...value } = result;
    const content = [{ type: 'text', text: JSON.stringify(value) }];
    if (imagePath) content.push({ type: 'image', mimeType: 'image/png', data: (await fs.readFile(imagePath)).toString('base64') });
    return { content, structuredContent: value };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
});
server.onclose = () => store.close();
await server.connect(new StdioServerTransport());
