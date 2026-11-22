#!/usr/bin/env node
/* eslint-disable no-console */
// Local MCP server (stdio, newline-delimited JSON-RPC) that lets Claude artifact pages refresh boss guides live.
// Register it in the Claude app's MCP config as "osrs" (pages call it as `host:osrs`):
//   claude mcp add -s user osrs -- node <repo>/src/server/mcp.js
// The tools themselves are in guideTools.js.
// stdout carries the protocol, so log to stderr only.
const readline = require('node:readline');
const { tools } = require('./guideTools');

const PROTOCOL_VERSION = '2025-06-18';

// --- JSON-RPC over stdio ----------------------------------------------------------------------------------------

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

const handle = async ({ id, method, params }) => {
  if (id === undefined) return; // a notification
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'osrs', version: '0.2.0' },
      });
      return;
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, {
        tools: Object.entries(tools).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: true, openWorldHint: false },
        })),
      });
      return;
    case 'tools/call': {
      const tool = tools[params?.name];
      if (!tool) {
        fail(id, -32602, `Unknown tool: ${params?.name}`);
        return;
      }
      try {
        const data = await tool.run(params.arguments || {});
        reply(id, { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
      } catch (e) {
        reply(id, { isError: true, content: [{ type: 'text', text: String(e?.message || e) }] });
      }
      return;
    }
    default:
      fail(id, -32601, `Method not found: ${method}`);
  }
};

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  handle(msg).catch((e) => console.error(e));
});
