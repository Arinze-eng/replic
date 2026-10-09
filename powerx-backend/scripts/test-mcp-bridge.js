// Quick live test of services/mcpBridge.js — sequential-thinking + filesystem.
const mcp = require('../services/mcpBridge');

(async () => {
  console.log('MCP_AVAILABLE:', mcp.MCP_AVAILABLE, '| dir:', mcp.MCP_DIR);

  // 1) Discover sequential-thinking tools
  console.log('\n--- sequential-thinking tools/list ---');
  try {
    const tools = await mcp.listTools('sequential-thinking');
    console.log(tools.map(t => t.name).join(', '));
  } catch (e) { console.log('ERR', e.message); }

  // 2) Add a thought step
  console.log('\n--- think_step ---');
  console.log(await mcp.call('sequential-thinking', 'think_step',
    { thought: 'First, understand the goal.', step_type: 'observe' }));

  // 3) Filesystem: write then read
  console.log('\n--- filesystem write_file ---');
  console.log(await mcp.call('filesystem', 'write_file',
    { path: 'mcp_test_artifact.txt', content: 'hello from MCP filesystem' }));
  console.log('\n--- filesystem read_file ---');
  console.log(await mcp.call('filesystem', 'read_file', { path: 'mcp_test_artifact.txt' }));
  console.log('\n--- filesystem list_directory ---');
  console.log(await mcp.call('filesystem', 'list_directory', { path: '.' }));

  mcp.shutdownAll();
  // give procs a tick to die
  setTimeout(() => process.exit(0), 300);
})();
