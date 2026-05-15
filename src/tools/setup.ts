import http from 'http';
import { URL } from 'url';
import open from 'open';
import { findAvailablePort } from '../utils/port.js';
import { upsertProject } from '../registry/projects.js';
import type { ProjectRecord } from '../registry/types.js';

export async function runProjectSetup(params: { project: ProjectRecord }): Promise<void> {
  const { project } = params;
  const port = await findAvailablePort();

  await new Promise<void>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url?.startsWith('/callback')) return;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Setup complete. You can close this tab.');

      const parsed = new URL(req.url, `http://localhost:${port}`);
      const resultStr = parsed.searchParams.get('result');
      if (resultStr) {
        try {
          const result = JSON.parse(decodeURIComponent(resultStr)) as { status?: string };
          if (result.status === 'setup_complete') {
            project.setupComplete = true;
            upsertProject(project);
          }
        } catch {
          // ignore parse errors
        }
      }

      server.close(() => resolve());
    });

    server.listen(port, '127.0.0.1', () => {
      const callbackUrl = `http://localhost:${port}/callback`;
      const setupUrl = `${project.webAppUrl}?callback=${encodeURIComponent(callbackUrl)}`;
      open(setupUrl).catch(() => {});
    });

    const timeoutHandle = setTimeout(() => {
      server.close(() => {
        reject(
          new Error(
            `Setup timed out. Please restart AutomateGS and try again, or visit ${project.webAppUrl} manually in your browser.`,
          ),
        );
      });
    }, 5 * 60 * 1000);

    server.on('close', () => clearTimeout(timeoutHandle));
  });
}
