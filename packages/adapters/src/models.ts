import { OLLAMA_BASE_URL } from './openai-compatible.js';
import { runProcess, runUnderPty, type ProcessOptions } from './process.js';
import { PROVIDERS } from './registry.js';
import { AdapterError, type ModelInfo, type ProviderId, type ProviderOptions } from './types.js';

const LIST_TIMEOUT_MS = 20_000;

/** Reads `agy models` output: one `id<TAB>label` per line, after a progress line. */
export function parseAgyModels(stdout: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const line of stdout.split('\n')) {
    const [id, label] = line.split('\t').map((part) => part.trim());
    // Model ids have no spaces, which leaves out "Fetching available models...".
    if (!id || /\s/.test(id) || models.some((model) => model.id === id)) continue;
    models.push(label ? { id, label } : { id });
  }
  return models;
}

async function antigravityModels(command: string, signal?: AbortSignal): Promise<ModelInfo[]> {
  const options: ProcessOptions = {
    command,
    args: ['models'],
    cwd: process.cwd(),
    signal,
    timeoutMs: LIST_TIMEOUT_MS,
  };
  let result = await runProcess(options);
  if (result.exitCode === 0 && parseAgyModels(result.stdout).length === 0) {
    result = await runUnderPty(options);
  }
  if (result.exitCode !== 0) {
    throw new AdapterError(
      `${command} models exited with code ${result.exitCode}`,
      (result.stderr || result.stdout).slice(0, 2000),
    );
  }
  return parseAgyModels(result.stdout);
}

async function openAiCompatibleModels(
  options: ProviderOptions,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  const baseUrl = (options.baseUrl || OLLAMA_BASE_URL).replace(/\/+$/, '');
  const headers: Record<string, string> = {};
  if (options.apiKeyEnv) {
    const key = env[options.apiKeyEnv];
    if (!key) throw new AdapterError(`Environment variable ${options.apiKeyEnv} is not set.`);
    headers.authorization = `Bearer ${key}`;
  }
  const timeout = AbortSignal.timeout(LIST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    throw new AdapterError(`Could not reach ${baseUrl}: ${String(error)}`);
  }
  if (!response.ok) throw new AdapterError(`${baseUrl}/models answered ${response.status}`);
  const body = (await response.json().catch(() => ({}))) as { data?: { id?: unknown }[] };
  const ids = (body.data ?? []).map((model) => model.id).filter((id) => typeof id === 'string');
  return [...new Set(ids)].sort().map((id) => ({ id }));
}

/**
 * The models a provider offers right now, asked through its official CLI or API.
 * Claude Code has no listing command, so it answers with its aliases; any full model name
 * also works there. Throws an AdapterError when the provider cannot be asked.
 */
export async function listModels(
  provider: ProviderId,
  options: ProviderOptions = {},
  context: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<ModelInfo[]> {
  switch (provider) {
    case 'antigravity':
      return antigravityModels(options.command || 'agy', context.signal);
    case 'openai-compatible':
      return openAiCompatibleModels(options, context.env ?? process.env, context.signal);
    case 'claude-code':
    case 'mock':
      return PROVIDERS.find((info) => info.id === provider)!.modelSuggestions.map((id) => ({ id }));
  }
}
