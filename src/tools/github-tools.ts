import type { Tier } from '../registry/types.js';
import { requireTier } from '../utils/require-tier.js';
import {
  startGithubDeviceFlow,
  pollGithubDeviceFlow,
  getGithubToken,
  getGithubUsername,
  ensureRepo,
  pushRegistry,
} from '../auth/github.js';
import { getSecret, storeSecret, deleteSecret } from '../auth/keychain.js';
import { loadRegistry, saveRegistry } from '../registry/projects.js';

export async function handleConnectVersionControl(tier: Tier) {
  requireTier(tier, 'agency', 'connect_version_control');

  // Two-phase flow: first call starts device flow, second call polls and completes.
  const pendingCode = await getSecret('github-pending-device-code');
  const pendingIntervalStr = await getSecret('github-pending-interval');

  if (pendingCode && pendingIntervalStr) {
    // Phase 2: user has authorized — poll and complete
    const interval = parseInt(pendingIntervalStr, 10);
    await deleteSecret('github-pending-device-code');
    await deleteSecret('github-pending-interval');

    const success = await pollGithubDeviceFlow(pendingCode, interval);
    if (!success) {
      return {
        success: false,
        message:
          'GitHub authorization failed or timed out. ' +
          'Call connect_version_control again to start a new authorization flow.',
      };
    }

    const username = await getGithubUsername();
    const token = await getGithubToken();
    if (!username || !token) {
      throw new Error('GitHub auth data missing after successful poll');
    }

    await ensureRepo(username, token);

    const registry = loadRegistry();
    registry.githubConnected = true;
    registry.githubUsername = username;
    saveRegistry(registry);

    await pushRegistry(registry);

    return {
      success: true,
      message:
        `GitHub connected. Your automations are now backed up to ` +
        `github.com/${username}/automategs-scripts`,
    };
  }

  // Phase 1: start the device flow
  const flowData = await startGithubDeviceFlow();

  await storeSecret('github-pending-device-code', flowData.deviceCode);
  await storeSecret('github-pending-interval', String(flowData.interval));

  return {
    success: false,
    pendingAuthorization: true,
    verificationUri: flowData.verificationUri,
    userCode: flowData.userCode,
    message:
      `To connect GitHub, visit ${flowData.verificationUri} ` +
      `and enter the code: ${flowData.userCode}\n` +
      `Tell me when you have authorised it.`,
  };
}
