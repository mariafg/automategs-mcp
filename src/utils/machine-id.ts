import crypto from 'crypto';
import os from 'os';

export function getMachineId(): string {
  const raw = os.hostname() + os.userInfo().username + os.platform();
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}
