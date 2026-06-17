export type Tier = 'free' | 'pro' | 'agency';

export type AutomationStatus =
  | 'draft'
  | 'staged'
  | 'crystallised'
  | 'deprecated';

export interface TriggerRecord {
  triggerId: string;
  fnName: string;
  frequency: string;
  description: string;
  createdAt: string;
  params: Record<string, unknown>;
}

export interface FunctionRecord {
  name: string;
  suffix: string;
  fnName: string;
  isEntryPoint: boolean;
  status: AutomationStatus;
  crystallisedAt?: string;
  createdAt: string;
}

export interface ProjectRecord {
  id: string;
  displayName: string;
  scriptId: string;
  webAppUrl?: string;
  deploymentId?: string;
  localPath: string;
  githubRepo?: string;
  githubPath?: string;
  functions: FunctionRecord[];
  triggers: TriggerRecord[];
  executionCount: number;
  setupComplete: boolean;
  stagingTempSheetId?: string;
  createdAt: string;
  lastDeployed?: string;
  authorizedScopes?: string[];
}

export interface Registry {
  version: '1.0';
  githubConnected: boolean;
  githubUsername?: string;
  tier: Tier;
  totalExecutions: number;
  projects: Record<string, ProjectRecord>;
}

export interface ValidationResponse {
  isAuthorized: boolean;
  planId?: string;
  errorMessage?: string;
  subscriptionInfo?: {
    subscription?: { plan_id: string };
  };
}

export interface ExecutionResult {
  status: 'success' | 'error' | 'async' | 'pending';
  result?: unknown;
  error?: string;
  logs?: Array<{ t: string; m: string }>;
  executionId?: string;
  message?: string;
}

export interface TemplateManifest {
  id: string;
  name: string;
  description: string;
  tier: 'free' | 'pro' | 'agency';
  surface: 'sheets' | 'standalone';
  driveTemplateId?: string;
  scriptCode: string;
  entryFunctionName: string;
  requiredScopes: string[];
  configRequired?: string[];
  usesSpreadsheet: boolean;
  tags: string[];
  version: string;
}

export interface TemplateRegistry {
  version: string;
  updatedAt: string;
  templates: TemplateManifest[];
}
