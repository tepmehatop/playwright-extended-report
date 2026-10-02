// Minimal stdio MCP server for tests: one tool "lookup_page_object".
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
rl.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined)
    return;
  if (message.method === 'initialize')
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  else if (message.method === 'tools/list')
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'lookup_page_object', description: 'Find the page object for a component', inputSchema: { type: 'object', properties: { component: { type: 'string' } }, required: ['component'] } }] } });
  else if (message.method === 'tools/call')
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `CartPage.counter = page.locator('div.cart') (component: ${message.params.arguments.component})` }] } });
  else
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method' } });
});
