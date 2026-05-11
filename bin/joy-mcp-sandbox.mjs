#!/usr/bin/env node
/**
 * Whitehat MCP sandbox CLI shim.
 *
 * Claude Desktop spawns this in place of a real MCP server. It looks up the
 * real server config in the JoyCreate database (or falls back to env vars)
 * and runs the stdio proxy.
 *
 * Usage (from `claude_desktop_config.json`):
 *   {
 *     "mcpServers": {
 *       "filesystem": {
 *         "command": "node",
 *         "args": [
 *           "C:/path/to/joycreate/bin/joy-mcp-sandbox.mjs",
 *           "--server", "filesystem",
 *           "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "C:/some/dir"
 *         ]
 *       }
 *     }
 *   }
 *
 * Everything after `--` is the real server command + args. The `--server`
 * flag names the logical server for policy lookups.
 */

import { runProxy } from "../src/lib/mcp_sandbox/proxy.js";

function parseArgs(argv) {
  let serverName = null;
  let i = 2;
  for (; i < argv.length; i++) {
    if (argv[i] === "--server") {
      serverName = argv[++i];
    } else if (argv[i] === "--") {
      i++;
      break;
    } else {
      throw new Error(`unknown flag: ${argv[i]}`);
    }
  }
  const rest = argv.slice(i);
  if (!serverName) throw new Error("missing --server <name>");
  if (rest.length === 0) throw new Error("missing real server command after --");
  return { serverName, command: rest[0], args: rest.slice(1) };
}

const { serverName, command, args } = parseArgs(process.argv);
runProxy({ serverName, command, args }).then((code) => process.exit(code));
