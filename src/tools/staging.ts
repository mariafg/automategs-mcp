import { randomUUID } from 'crypto';
import type { Registry, ProjectRecord, FunctionRecord, StagingSession, Tier } from '../registry/types.js';
import { upsertProject, upsertFunction } from '../registry/projects.js';
import { callWebApp } from './web-app.js';
import { getAccessToken } from '../auth/clasp.js';
import { detectImportRanges } from '../gas/importrange.js';
import { commitAndPush } from '../auth/github.js';

export const activeSessions = new Map<string, StagingSession>();

export async function createPreviewSession(params: {
  project: ProjectRecord;
  fn: FunctionRecord;
  sheetId: string;
}): Promise<StagingSession> {
  const { project, fn, sheetId } = params;
  const sessionId = randomUUID();

  const cpResult = await callWebApp({
    webAppUrl: project.webAppUrl!,
    fnName: '_ags_cp',
    parameters: { sourceId: sheetId, title: project.displayName },
  });

  if (cpResult.status === 'error') {
    throw new Error(`Failed to copy spreadsheet: ${cpResult.error}`);
  }

  const { tempSheetId, tempSheetUrl } = cpResult.result as {
    tempSheetId: string;
    tempSheetUrl: string;
  };

  const session: StagingSession = {
    sessionId,
    projectId: project.id,
    fnName: fn.fnName,
    originalSheetId: sheetId,
    tempSheetId,
    tempSheetUrl,
    importRangesFound: 0,
    importRangesAuthorized: 0,
    status: 'authorizing',
    createdAt: new Date().toISOString(),
  };

  activeSessions.set(sessionId, session);
  project.stagingTempSheetId = tempSheetId;
  upsertProject(project);

  const accessToken = await getAccessToken();
  const ranges = await detectImportRanges({ spreadsheetId: tempSheetId, accessToken });
  session.importRangesFound = ranges.length;

  if (ranges.length > 0) {
    const donorIds = [
      ...new Set(ranges.map((r) => r.sourceId).filter((id): id is string => id !== null)),
    ];
    if (donorIds.length > 0) {
      const airResult = await callWebApp({
        webAppUrl: project.webAppUrl!,
        fnName: '_ags_air',
        parameters: { spreadsheetId: tempSheetId, donorIds },
      });
      if (airResult.status === 'success') {
        const airData = airResult.result as { authorized?: number };
        session.importRangesAuthorized = airData.authorized ?? 0;
      }
    }
  }

  session.status = 'executing';
  activeSessions.set(sessionId, session);
  return session;
}

export async function executePreview(
  session: StagingSession,
  project: ProjectRecord,
  additionalParams?: Record<string, unknown>,
): Promise<StagingSession> {
  const parameters: Record<string, unknown> = {
    sheetId: session.tempSheetId,
    ...additionalParams,
  };

  const result = await callWebApp({
    webAppUrl: project.webAppUrl!,
    fnName: session.fnName,
    parameters,
  });

  session.executionResult = result;
  session.status = 'awaiting_approval';
  activeSessions.set(session.sessionId, session);
  return session;
}

export async function activateAutomation(
  session: StagingSession,
  project: ProjectRecord,
  registry: Registry,
  _tier: Tier,
): Promise<void> {
  const fn = project.functions.find((f) => f.fnName === session.fnName);
  if (!fn) throw new Error(`Function ${session.fnName} not found in project`);

  fn.status = 'crystallised';
  fn.crystallisedAt = new Date().toISOString();
  upsertFunction(project.id, fn);

  await callWebApp({
    webAppUrl: project.webAppUrl!,
    fnName: '_ags_del',
    parameters: { fileId: session.tempSheetId },
  });

  project.stagingTempSheetId = undefined;
  upsertProject(project);

  session.status = 'approved';
  activeSessions.set(session.sessionId, session);

  if (registry.githubConnected && project.localPath) {
    try {
      await commitAndPush({
        localPath: project.localPath,
        message: 'automategs: activate ' + session.fnName,
      });
    } catch (err) {
      console.error('[AutomateGS] Git push failed:', err);
    }
  }
}

export async function discardPreview(
  session: StagingSession,
  project: ProjectRecord,
): Promise<void> {
  await callWebApp({
    webAppUrl: project.webAppUrl!,
    fnName: '_ags_del',
    parameters: { fileId: session.tempSheetId },
  });

  project.stagingTempSheetId = undefined;
  upsertProject(project);

  session.status = 'rejected';
  activeSessions.set(session.sessionId, session);
}
