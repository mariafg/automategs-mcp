import { text, ToolContext, ToolResult } from './common.js';
import { installPortableNode } from '../auth/clasp.js';

export const tools = [
  {
    name: 'install_node',
    description:
      'Downloads a private, sandboxed copy of Node.js (~50MB, official nodejs.org build, checksum-verified) that AutomateGS uses to run Google Apps Script deployments. ' +
      'No admin password, Homebrew, or system-wide install is involved — it only writes to ~/.automategs/node. ' +
      'Only call this after the user has explicitly confirmed they want it downloaded, and only when AutomateGS has reported it cannot find a Node.js installation.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export const handlers: Record<
  string,
  (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
> = {
  install_node: async () => {
    const nodePath = await installPortableNode();
    return text({
      success: true,
      nodePath,
      message: 'Node.js was installed privately for AutomateGS. You can now retry your automation.',
    });
  },
};
