import { AntigravityAdapter } from './antigravity.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { reportingFileChanges } from './file-changes.js';
import { MockAdapter } from './mock.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';
import type { AgentAdapter, ProviderId, ProviderInfo, ProviderOptions } from './types.js';

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: 'claude-code',
    label: 'Claude Code (CLI)',
    canEditFiles: true,
    modelSuggestions: ['sonnet', 'opus', 'haiku', 'fable'],
    smallModel: 'haiku',
    description:
      'Runs `claude -p` with your own Claude Code login. Use an alias or a full model name.',
  },
  {
    id: 'antigravity',
    label: 'Antigravity (CLI)',
    canEditFiles: true,
    modelSuggestions: ['gemini-3.8-flash-medium', 'gemini-3.8-flash-low', 'claude-sonnet-4-6'],
    smallModel: 'gemini-3.8-flash-low',
    description: 'Runs `agy -p` with your own Antigravity login.',
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible API',
    canEditFiles: false,
    modelSuggestions: ['llama3.2', 'qwen2.5-coder', 'gpt-4.1-mini'],
    smallModel: 'llama3.2',
    description:
      'Any chat completions API. Defaults to a local Ollama server. Text only: cannot edit files.',
  },
  {
    id: 'mock',
    label: 'Mock (no AI)',
    canEditFiles: false,
    modelSuggestions: ['mock'],
    smallModel: 'mock',
    description: 'Echoes messages back. Free, for trying out Symposium.',
  },
];

export function isProviderId(value: string): value is ProviderId {
  return PROVIDERS.some((provider) => provider.id === value);
}

export function createAdapter(provider: ProviderId, options: ProviderOptions = {}): AgentAdapter {
  switch (provider) {
    case 'mock':
      return new MockAdapter();
    case 'claude-code':
      return reportingFileChanges(new ClaudeCodeAdapter(options.command || undefined));
    case 'antigravity':
      return reportingFileChanges(new AntigravityAdapter(options.command || undefined));
    case 'openai-compatible':
      return new OpenAICompatibleAdapter({
        baseUrl: options.baseUrl,
        apiKeyEnv: options.apiKeyEnv,
      });
  }
}
