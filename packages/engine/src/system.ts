import { commandExists, PROVIDERS } from '@symposium/adapters';
import type { AppContext } from './context.js';
import type { HireRequest, ProviderId, SystemInfo } from './protocol.js';

/** The command each CLI provider runs unless an agent is told otherwise. */
const PROVIDER_COMMANDS: Partial<Record<ProviderId, string>> = {
  'claude-code': 'claude',
  antigravity: 'agy',
};

/**
 * What is installed on this machine, for the first-run checks. Only looks for the programs on
 * PATH. It runs nothing and reads no login.
 */
export async function systemInfo(ctx: AppContext): Promise<SystemInfo> {
  const found = async (command: string): Promise<boolean> => commandExists(command);
  return {
    git: await found('git'),
    vscode: await found(ctx.vscodeCommand),
    providers: {
      'claude-code': await found(PROVIDER_COMMANDS['claude-code']!),
      antigravity: await found(PROVIDER_COMMANDS.antigravity!),
      // An API may or may not be reachable. Asking would mean a network call, so it is offered.
      'openai-compatible': true,
      mock: true,
    },
  };
}

/** The providers a starter team can be hired on: the ones whose agents can edit files, and mock. */
export const STARTER_PROVIDERS: readonly ProviderId[] = ['claude-code', 'antigravity', 'mock'];

/**
 * A small team to begin with: a lead, a worker, a reviewer and a scribe, all on one provider.
 * The scribe gets the provider's small model. The human asks for this when creating a group
 * and can change or fire anyone afterwards.
 */
export function starterTeam(providerId: ProviderId): HireRequest[] {
  const provider = PROVIDERS.find((info) => info.id === providerId)!;
  const model = provider.modelSuggestions[0]!;
  return [
    { name: 'Lea', role: 'lead', provider: providerId, model },
    { name: 'Ada', role: 'worker', provider: providerId, model },
    { name: 'Rex', role: 'reviewer', provider: providerId, model },
    { name: 'Sam', role: 'scribe', provider: providerId, model: provider.smallModel },
  ];
}
