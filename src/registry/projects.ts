import fs from 'fs';
import path from 'path';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Registry, ProjectRecord, FunctionRecord } from './types.js';
import {
  CONFIG_DIR,
  SCRIPTS_DIR,
  REGISTRY_PATH,
  FREE_TIER_PROJECT_LIMIT,
  FREE_TIER_EXECUTION_LIMIT,
  UPGRADE_URL,
} from '../utils/constants.js';

const DEFAULT_REGISTRY: Registry = {
  version: '1.0',
  githubConnected: false,
  tier: 'free',
  totalExecutions: 0,
  projects: {},
};

export function loadRegistry(): Registry {
  if (!fs.existsSync(REGISTRY_PATH)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(DEFAULT_REGISTRY, null, 2));
    return { ...DEFAULT_REGISTRY };
  }
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
  return JSON.parse(raw) as Registry;
}

export function saveRegistry(registry: Registry): void {
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

export function getProject(id: string): ProjectRecord | undefined {
  const registry = loadRegistry();
  return registry.projects[id];
}

export function upsertProject(project: ProjectRecord): void {
  const registry = loadRegistry();
  registry.projects[project.id] = project;
  saveRegistry(registry);
}

export function getFunction(
  projectId: string,
  fnName: string,
): FunctionRecord | undefined {
  const project = getProject(projectId);
  return project?.functions.find((f) => f.fnName === fnName);
}

export function upsertFunction(
  projectId: string,
  fn: FunctionRecord,
): void {
  const registry = loadRegistry();
  const project = registry.projects[projectId];
  if (!project) {
    throw new McpError(ErrorCode.InvalidRequest, `Project ${projectId} not found`);
  }
  const idx = project.functions.findIndex((f) => f.fnName === fn.fnName);
  if (idx >= 0) {
    project.functions[idx] = fn;
  } else {
    project.functions.push(fn);
  }
  saveRegistry(registry);
}

export function incrementExecution(projectId: string): void {
  const registry = loadRegistry();
  const project = registry.projects[projectId];
  if (project) {
    project.executionCount = (project.executionCount ?? 0) + 1;
  }
  registry.totalExecutions = (registry.totalExecutions ?? 0) + 1;
  saveRegistry(registry);
}

export function checkFreeTierLimits(
  registry: Registry,
  action: 'create_project' | 'execute',
): void {
  if (registry.tier !== 'free') return;

  if (
    action === 'create_project' &&
    Object.keys(registry.projects).length >= FREE_TIER_PROJECT_LIMIT
  ) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Free tier is limited to ${FREE_TIER_PROJECT_LIMIT} automation. ` +
        `Upgrade to Pro or Agency for unlimited automations: ${UPGRADE_URL}`,
    );
  }

  if (action === 'execute' && registry.totalExecutions >= FREE_TIER_EXECUTION_LIMIT) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Free tier is limited to ${FREE_TIER_EXECUTION_LIMIT} total executions. ` +
        `Upgrade to Pro or Agency for unlimited executions: ${UPGRADE_URL}`,
    );
  }
}
