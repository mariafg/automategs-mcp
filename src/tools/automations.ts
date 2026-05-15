import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Tier, ProjectRecord, FunctionRecord, TriggerRecord } from '../registry/types.js';
import {
  loadRegistry,
  saveRegistry,
  getProject,
  upsertProject,
  upsertFunction,
  getFunction,
  incrementExecution,
  checkFreeTierLimits,
} from '../registry/projects.js';
import { callWebApp } from './web-app.js';
import { SCRIPTS_DIR, TEMPLATE_REGISTRY_URL, TEMPLATE_CACHE_PATH, TEMPLATE_CACHE_TTL_MS } from '../utils/constants.js';
import type { TemplateManifest, TemplateRegistry } from '../registry/types.js';

// ─── create_automation ────────────────────────────────────────────────────────

export async function handleCreateAutomation(
  tier: Tier,
  args: {
    projectId?: string;
    displayName: string;
    scriptId: string;
    webAppUrl?: string;
    functionName: string;
  },
) {
  const registry = loadRegistry();
  checkFreeTierLimits(registry, 'create_project');

  const projectId = args.projectId ?? randomUUID();
  const localPath = path.join(SCRIPTS_DIR, projectId);
  fs.mkdirSync(localPath, { recursive: true });

  const fnName = args.functionName;
  const fn: FunctionRecord = {
    name: args.functionName,
    suffix: '',
    fnName,
    isEntryPoint: true,
    status: 'draft',
    createdAt: new Date().toISOString(),
  };

  const project: ProjectRecord = {
    id: projectId,
    displayName: args.displayName,
    scriptId: args.scriptId,
    webAppUrl: args.webAppUrl,
    localPath,
    functions: [fn],
    triggers: [],
    executionCount: 0,
    setupComplete: !!args.webAppUrl,
    createdAt: new Date().toISOString(),
  };

  registry.projects[projectId] = project;
  saveRegistry(registry);

  return { projectId, displayName: args.displayName, functionName: fnName, status: 'draft' };
}

// ─── update_automation ────────────────────────────────────────────────────────

export async function handleUpdateAutomation(
  _tier: Tier,
  args: {
    projectId: string;
    functionName: string;
    webAppUrl?: string;
    deploymentId?: string;
  },
) {
  const project = getProject(args.projectId);
  if (!project) {
    throw new McpError(ErrorCode.InvalidRequest, `Project ${args.projectId} not found`);
  }

  if (args.webAppUrl) project.webAppUrl = args.webAppUrl;
  if (args.deploymentId) project.deploymentId = args.deploymentId;
  if (args.webAppUrl || args.deploymentId) {
    project.setupComplete = true;
    project.lastDeployed = new Date().toISOString();
  }

  upsertProject(project);

  const fn = getFunction(args.projectId, args.functionName);
  if (fn) {
    upsertFunction(args.projectId, fn);
  }

  return { success: true, projectId: args.projectId, functionName: args.functionName };
}

// ─── run_automation ───────────────────────────────────────────────────────────

export async function handleRunAutomation(
  tier: Tier,
  args: {
    projectId: string;
    functionName: string;
    parameters?: Record<string, unknown>;
  },
) {
  const registry = loadRegistry();
  checkFreeTierLimits(registry, 'execute');

  const project = getProject(args.projectId);
  if (!project) {
    throw new McpError(ErrorCode.InvalidRequest, `Project ${args.projectId} not found`);
  }
  if (!project.webAppUrl) {
    throw new McpError(ErrorCode.InvalidRequest, 'Project has no deployed web app URL');
  }

  const result = await callWebApp({
    webAppUrl: project.webAppUrl,
    fnName: args.functionName,
    parameters: args.parameters ?? {},
  });

  incrementExecution(args.projectId);

  return { projectId: args.projectId, functionName: args.functionName, result };
}

// ─── check_status ─────────────────────────────────────────────────────────────

export async function handleCheckStatus(
  _tier: Tier,
  args: { projectId: string },
) {
  const project = getProject(args.projectId);
  if (!project) {
    throw new McpError(ErrorCode.InvalidRequest, `Project ${args.projectId} not found`);
  }

  return {
    projectId: project.id,
    displayName: project.displayName,
    setupComplete: project.setupComplete,
    webAppUrl: project.webAppUrl,
    deploymentId: project.deploymentId,
    functions: project.functions.map((f) => ({
      fnName: f.fnName,
      status: f.status,
      crystallisedAt: f.crystallisedAt,
    })),
    triggers: project.triggers,
    executionCount: project.executionCount,
    lastDeployed: project.lastDeployed,
    stagingTempSheetId: project.stagingTempSheetId,
  };
}

// ─── schedule_automation ──────────────────────────────────────────────────────

export async function handleScheduleAutomation(
  _tier: Tier,
  args: {
    projectId: string;
    functionName: string;
    frequency: string;
    description?: string;
    params?: Record<string, unknown>;
  },
) {
  const project = getProject(args.projectId);
  if (!project) {
    throw new McpError(ErrorCode.InvalidRequest, `Project ${args.projectId} not found`);
  }

  const trigger: TriggerRecord = {
    triggerId: randomUUID(),
    fnName: args.functionName,
    frequency: args.frequency,
    description: args.description ?? args.frequency,
    createdAt: new Date().toISOString(),
    params: args.params ?? {},
  };

  project.triggers.push(trigger);
  upsertProject(project);

  return { triggerId: trigger.triggerId, fnName: trigger.fnName, frequency: trigger.frequency };
}

// ─── unschedule_automation ────────────────────────────────────────────────────

export async function handleUnscheduleAutomation(
  _tier: Tier,
  args: { projectId: string; triggerId: string },
) {
  const project = getProject(args.projectId);
  if (!project) {
    throw new McpError(ErrorCode.InvalidRequest, `Project ${args.projectId} not found`);
  }

  const before = project.triggers.length;
  project.triggers = project.triggers.filter((t) => t.triggerId !== args.triggerId);

  if (project.triggers.length === before) {
    throw new McpError(ErrorCode.InvalidRequest, `Trigger ${args.triggerId} not found`);
  }

  upsertProject(project);
  return { success: true, triggerId: args.triggerId };
}

// ─── view_schedule ────────────────────────────────────────────────────────────

export async function handleViewSchedule(_tier: Tier, args: { projectId?: string }) {
  const registry = loadRegistry();
  const projects = args.projectId
    ? [registry.projects[args.projectId]].filter(Boolean)
    : Object.values(registry.projects);

  const schedule = projects.flatMap((p) =>
    (p.triggers ?? []).map((t) => ({
      projectId: p.id,
      displayName: p.displayName,
      triggerId: t.triggerId,
      fnName: t.fnName,
      frequency: t.frequency,
      description: t.description,
      createdAt: t.createdAt,
    })),
  );

  return { schedule, total: schedule.length };
}

// ─── list_templates ───────────────────────────────────────────────────────────

async function fetchTemplateRegistry(): Promise<TemplateManifest[]> {
  // Serve from cache if fresh
  if (fs.existsSync(TEMPLATE_CACHE_PATH)) {
    try {
      const cached = JSON.parse(fs.readFileSync(TEMPLATE_CACHE_PATH, 'utf8')) as {
        fetchedAt: number;
        templates: TemplateManifest[];
      };
      if (Date.now() - cached.fetchedAt < TEMPLATE_CACHE_TTL_MS) {
        return cached.templates;
      }
    } catch {
      // ignore corrupt cache
    }
  }

  const res = await fetch(TEMPLATE_REGISTRY_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Template registry fetch failed: ${res.status}`);
  const data = (await res.json()) as TemplateRegistry;

  fs.mkdirSync(path.dirname(TEMPLATE_CACHE_PATH), { recursive: true });
  fs.writeFileSync(
    TEMPLATE_CACHE_PATH,
    JSON.stringify({ fetchedAt: Date.now(), templates: data.templates }, null, 2),
  );

  return data.templates;
}

export async function handleListTemplates(
  tier: Tier,
  args: { tags?: string[]; surface?: string },
) {
  const templates = await fetchTemplateRegistry();

  const filtered = templates.filter((t) => {
    if (tier === 'free' && t.tier !== 'free') return false;
    if (tier === 'pro' && t.tier === 'agency') return false;
    if (args.surface && t.surface !== args.surface) return false;
    if (args.tags?.length) {
      return args.tags.some((tag) => t.tags.includes(tag));
    }
    return true;
  });

  return { templates: filtered, total: filtered.length };
}

// ─── install_template ─────────────────────────────────────────────────────────

export async function handleInstallTemplate(
  tier: Tier,
  args: { templateId: string; displayName?: string; scriptId: string; webAppUrl?: string },
) {
  const registry = loadRegistry();
  checkFreeTierLimits(registry, 'create_project');

  const templates = await fetchTemplateRegistry();
  const template = templates.find((t) => t.id === args.templateId);
  if (!template) {
    throw new McpError(ErrorCode.InvalidRequest, `Template ${args.templateId} not found`);
  }

  if (tier === 'free' && template.tier !== 'free') {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Template '${template.name}' requires ${template.tier} tier`,
    );
  }

  const projectId = randomUUID();
  const localPath = path.join(SCRIPTS_DIR, projectId);
  fs.mkdirSync(localPath, { recursive: true });

  const fn: FunctionRecord = {
    name: template.entryFunctionName,
    suffix: '',
    fnName: template.entryFunctionName,
    isEntryPoint: true,
    status: 'draft',
    createdAt: new Date().toISOString(),
  };

  const project: ProjectRecord = {
    id: projectId,
    displayName: args.displayName ?? template.name,
    scriptId: args.scriptId,
    webAppUrl: args.webAppUrl,
    localPath,
    functions: [fn],
    triggers: [],
    executionCount: 0,
    setupComplete: !!args.webAppUrl,
    createdAt: new Date().toISOString(),
  };

  registry.projects[projectId] = project;
  saveRegistry(registry);

  return {
    projectId,
    displayName: project.displayName,
    templateId: args.templateId,
    templateName: template.name,
    entryFunction: template.entryFunctionName,
    status: 'draft',
  };
}
