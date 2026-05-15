import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { simpleGit } from 'simple-git';
import type { Tier, FunctionRecord } from '../registry/types.js';
import type { ToolEntry } from './types.js';
import { loadRegistry, upsertProject } from '../registry/projects.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { assembleCodeGs } from '../gas/template.js';
import { runClasp } from '../auth/clasp.js';

const SEPARATOR = '// ─── User Automations ───';

function extractUserFunctions(codeGs: string): string[] {
  const idx = codeGs.indexOf(SEPARATOR);
  if (idx < 0) return [];
  const after = codeGs.slice(idx + SEPARATOR.length).trim();
  return after ? after.split(/\n\n+/).filter((s) => s.trim()) : [];
}

export function registerTool(tools: ToolEntry[], tier: Tier): void {
  tools.push({
    name: 'update_automation',
    description:
      'Add or update an automation function. Provide the complete function code. New functions will be in draft status.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project to add the function to' },
        functionCode: { type: 'string', description: 'Complete GAS function source code' },
        functionName: {
          type: 'string',
          description: 'Base name for the function (without suffix)',
        },
        isEntryPoint: {
          type: 'boolean',
          description: 'Whether this is the main entry function (default: true)',
        },
        usesSpreadsheet: {
          type: 'boolean',
          description: 'Whether this function accesses a spreadsheet',
        },
        description: { type: 'string', description: 'What this function does' },
      },
      required: ['projectId', 'functionCode', 'functionName'],
    },
    handler: async (args) => {
      const {
        projectId,
        functionCode,
        functionName,
        isEntryPoint = true,
        description,
      } = args as {
        projectId: string;
        functionCode: string;
        functionName: string;
        isEntryPoint?: boolean;
        usesSpreadsheet?: boolean;
        description?: string;
      };

      const registry = loadRegistry();
      const project = registry.projects[projectId];
      if (!project) {
        throw new McpError(ErrorCode.InvalidRequest, `Project ${projectId} not found`);
      }

      if (project.functions.find((f) => f.name === functionName)) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  error: `Function "${functionName}" already exists in project "${projectId}".`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      const suffix = crypto.randomBytes(2).toString('hex');
      const fnName = `${functionName}_${suffix}`;

      const codeGsPath = path.join(project.localPath, 'code.gs');
      const existingCode = fs.existsSync(codeGsPath)
        ? fs.readFileSync(codeGsPath, 'utf8')
        : '';

      const existingFunctions = extractUserFunctions(existingCode);
      const newCodeGs = assembleCodeGs([...existingFunctions, functionCode]);
      fs.writeFileSync(codeGsPath, newCodeGs);

      await runClasp(['push', '--force'], project.localPath);

      const fn: FunctionRecord = {
        name: functionName,
        suffix,
        fnName,
        isEntryPoint,
        status: 'draft',
        createdAt: new Date().toISOString(),
      };

      project.functions.push(fn);
      upsertProject(project);

      if (registry.githubConnected) {
        try {
          const git = simpleGit(project.localPath);
          await git.add('.');
          await git.commit(`automategs: add ${functionName} to ${projectId}`);
          await git.push();
        } catch {
          // GitHub push is best-effort
        }
      }

      const hint =
        tier === 'pro' || tier === 'agency'
          ? 'Use preview_automation to test in staging, then crystallise_automation to activate.'
          : 'Use run_automation with force: true to run this draft function.';

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { fnName, suffix, status: 'draft', description, nextStep: hint },
              null,
              2,
            ),
          },
        ],
      };
    },
  });
}
