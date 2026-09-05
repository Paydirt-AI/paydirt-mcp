#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as api from './api.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  createPaydirtServer,
  type CredentialStore,
  type StoredCredentials,
} from './server.js';

const credentialsDirectory = join(homedir(), '.paydirt');
const credentialsFile = join(credentialsDirectory, 'credentials.json');

class FileCredentialStore implements CredentialStore {
  get(): StoredCredentials | null {
    if (process.env.PAYDIRT_AUTH_TOKEN) {
      return { auth_token: process.env.PAYDIRT_AUTH_TOKEN };
    }

    if (!existsSync(credentialsFile)) return null;
    try {
      return JSON.parse(readFileSync(credentialsFile, 'utf8')) as StoredCredentials;
    } catch {
      return null;
    }
  }

  set(credentials: StoredCredentials): void {
    if (!existsSync(credentialsDirectory)) {
      mkdirSync(credentialsDirectory, { recursive: true, mode: 0o700 });
    }
    chmodSync(credentialsDirectory, 0o700);
    writeFileSync(credentialsFile, JSON.stringify(credentials, null, 2), { mode: 0o600 });
    chmodSync(credentialsFile, 0o600);
  }
}

async function main() {
  const server = createPaydirtServer(new FileCredentialStore());
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Paydirt MCP server running on stdio');
  let lastNotifiedVersion: string | null = null;
  const checkForUpdate = () => {
    void api.getMcpVersionPolicy().then((policy) => {
      if (
        policy.update_available
        && policy.update_action
        && policy.latest_version !== lastNotifiedVersion
      ) {
        lastNotifiedVersion = policy.latest_version;
        console.error(`[Paydirt] ${policy.status}: ${policy.update_action}`);
      }
    }).catch(() => {
      // Update checks are best effort and must never prevent MCP startup.
    });
  };

  checkForUpdate();
  const updateTimer = setInterval(checkForUpdate, 6 * 60 * 60 * 1_000);
  updateTimer.unref();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
