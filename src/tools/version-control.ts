import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { loadRegistry, saveRegistry } from '../registry/projects.js';
import {
  isGithubConnected,
  startGithubDeviceFlow,
  pollGithubDeviceFlow,
  getGithubUsername,
} from '../auth/github.js';
import { text, ToolContext, ToolResult, requireTier } from './common.js';

export const tools = [
  {
    name: 'connect_version_control',
    description:
      'Connect an automation to a GitHub repository for version control. Every update and activation is committed automatically. Agency plan only.',
    inputSchema: {
      type: 'object',
      required: ['projectId'],
      properties: {
        projectId: { type: 'string' },
        githubRepo: {
          type: 'string',
          description: 'GitHub repo in owner/repo format, e.g. "acme-corp/automations"',
        },
        githubPath: {
          type: 'string',
          description: 'Path within the repo to store script files. Defaults to the project ID.',
        },
      },
    },
  },
];

export const handlers: Record<
  string,
  (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
> = {
  connect_version_control: async (args, ctx) => {
    requireTier(ctx.tier, 'agency', 'Version control');

    const projectId = args.projectId as string;
    const githubRepo = args.githubRepo as string | undefined;
    const githubPath = (args.githubPath as string | undefined) ?? projectId;

    const registry = loadRegistry();
    const project = registry.projects[projectId];
    if (!project) throw new McpError(ErrorCode.InvalidRequest, `Project "${projectId}" not found.`);

    const connected = await isGithubConnected();
    let username: string | null = null;

    if (!connected) {
      const flow = await startGithubDeviceFlow();
      const authResult = await pollGithubDeviceFlow(flow.deviceCode, flow.interval);
      if (!authResult) {
        throw new McpError(
          ErrorCode.InternalError,
          'GitHub authentication timed out or was denied. Please try again.',
        );
      }
    }

    username = await getGithubUsername();
    registry.githubConnected = true;
    registry.githubUsername = username ?? undefined;

    if (githubRepo) {
      project.githubRepo = githubRepo;
      project.githubPath = githubPath;
    }
    saveRegistry(registry);

    return text({
      success: true,
      projectId,
      githubUsername: username,
      githubRepo: project.githubRepo,
      githubPath: project.githubPath,
      message: githubRepo
        ? `GitHub connected. Future updates and activations for "${project.displayName}" will be committed to ${githubRepo}/${githubPath}.`
        : `GitHub connected as ${username ?? 'unknown'}. Provide githubRepo to link this automation to a repository.`,
    });
  },
};
