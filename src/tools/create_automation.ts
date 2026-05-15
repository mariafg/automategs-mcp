import fs from 'fs';
import path from 'path';
import type { Tier, ProjectRecord } from '../registry/types.js';
import type { ToolEntry } from './types.js';
import {
  loadRegistry,
  upsertProject,
  checkFreeTierLimits,
} from '../registry/projects.js';
import { generateAppsScriptManifest, assembleCodeGs } from '../gas/template.js';
import { runClasp } from '../auth/clasp.js';
import { runProjectSetup } from './setup.js';
import { SCRIPTS_DIR } from '../utils/constants.js';

export function registerTool(tools: ToolEntry[], tier: Tier): void {
  tools.push({
    name: 'create_automation',
    description:
      'Create a new automation. This sets up a Google Apps Script project in your Google account and registers it with AutomateGS. You will be taken to a browser window once to authorise Google permissions.',
    inputSchema: {
      type: 'object',
      properties: {
        displayName: { type: 'string', description: 'Human-readable name for the automation' },
        description: { type: 'string', description: 'What this automation does' },
        usesSpreadsheet: {
          type: 'boolean',
          description: 'Whether this automation reads/writes a Google Sheet',
        },
        sheetId: {
          type: 'string',
          description: 'Google Sheet ID (required if usesSpreadsheet is true)',
        },
      },
      required: ['displayName'],
    },
    handler: async (args) => {
      const { displayName, description, usesSpreadsheet, sheetId } = args as {
        displayName: string;
        description?: string;
        usesSpreadsheet?: boolean;
        sheetId?: string;
      };

      const registry = loadRegistry();
      checkFreeTierLimits(registry, 'create_project');

      const slug = displayName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 40)
        .replace(/^-+|-+$/g, '');

      if (registry.projects[slug]) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  error: `A project named "${slug}" already exists. Choose a different display name.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      const localPath = path.join(SCRIPTS_DIR, slug);
      fs.mkdirSync(localPath, { recursive: true });

      const manifest = generateAppsScriptManifest({
        title: displayName,
        scopes: usesSpreadsheet
          ? ['https://www.googleapis.com/auth/spreadsheets']
          : [],
      });

      fs.writeFileSync(
        path.join(localPath, 'appsscript.json'),
        JSON.stringify(manifest, null, 2),
      );
      fs.writeFileSync(path.join(localPath, 'code.gs'), assembleCodeGs([]));

      await runClasp(['create', '--title', displayName, '--type', 'standalone'], localPath);

      const claspJson = JSON.parse(
        fs.readFileSync(path.join(localPath, '.clasp.json'), 'utf8'),
      ) as { scriptId: string };
      const scriptId = claspJson.scriptId;

      await runClasp(['push', '--force'], localPath);

      const deployOutput = await runClasp(
        ['deploy', '--description', 'AutomateGS v1'],
        localPath,
      );

      const deployMatch = deployOutput.match(/AKfycb[A-Za-z0-9_-]+/);
      if (!deployMatch) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { error: 'Could not parse deployment ID from clasp output.', deployOutput },
                null,
                2,
              ),
            },
          ],
        };
      }
      const deploymentId = deployMatch[0];
      const webAppUrl = `https://script.google.com/macros/s/${deploymentId}/exec`;

      const project: ProjectRecord = {
        id: slug,
        displayName,
        scriptId,
        webAppUrl,
        deploymentId,
        localPath,
        functions: [],
        triggers: [],
        executionCount: 0,
        setupComplete: false,
        createdAt: new Date().toISOString(),
      };

      upsertProject(project);
      await runProjectSetup({ project });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'created',
                projectId: slug,
                webAppUrl,
                scriptId,
                nextSteps: [
                  'Use update_automation to add automation functions to this project.',
                  'Use run_automation with force: true to test a draft function.',
                  description ? `Description: ${description}` : null,
                  sheetId ? `Sheet ID: ${sheetId}` : null,
                ].filter(Boolean),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  });
}
