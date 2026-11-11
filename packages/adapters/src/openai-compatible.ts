import {
  AdapterError,
  CancelledError,
  DEFAULT_TIMEOUT_MS,
  type AgentAdapter,
  type AgentReply,
  type AgentTask,
} from './types.js';

export const OLLAMA_BASE_URL = 'http://localhost:11434/v1';

export interface OpenAICompatibleOptions {
  baseUrl?: string;
  /** Name of the environment variable holding the API key. Read at call time, never stored. */
  apiKeyEnv?: string;
  env?: NodeJS.ProcessEnv;
}

interface ChatCompletion {
  choices?: { message?: { content?: string | null } }[];
  error?: { message?: string };
}

/**
 * Calls any OpenAI-compatible chat completions API (OpenAI, Ollama, LM Studio, vLLM, ...).
 * Text only: agents on this provider plan and review but cannot edit files.
 */
export class OpenAICompatibleAdapter implements AgentAdapter {
  readonly provider = 'openai-compatible' as const;
  private readonly baseUrl: string;

  constructor(private readonly options: OpenAICompatibleOptions = {}) {
    this.baseUrl = (options.baseUrl || OLLAMA_BASE_URL).replace(/\/+$/, '');
  }

  async run(task: AgentTask): Promise<AgentReply> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.options.apiKeyEnv) {
      const key = (this.options.env ?? process.env)[this.options.apiKeyEnv];
      if (!key) {
        throw new AdapterError(
          `Environment variable ${this.options.apiKeyEnv} is not set. Set it before starting Symposium.`,
        );
      }
      headers.authorization = `Bearer ${key}`;
    }

    const timeout = AbortSignal.timeout(task.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = task.signal ? AbortSignal.any([task.signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify({
          model: task.model,
          messages: [
            { role: 'system', content: task.systemPrompt },
            { role: 'user', content: task.prompt },
          ],
        }),
      });
    } catch (error) {
      if (task.signal?.aborted) throw new CancelledError();
      if (timeout.aborted) throw new AdapterError(`${this.baseUrl} timed out`);
      throw new AdapterError(`Could not reach ${this.baseUrl}: ${String(error)}`);
    }

    const body = (await response.json().catch(() => ({}))) as ChatCompletion;
    if (!response.ok) {
      throw new AdapterError(
        `${this.baseUrl} answered ${response.status}: ${body.error?.message ?? response.statusText}`,
      );
    }
    const text = body.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || text.trim() === '') {
      throw new AdapterError(`${this.baseUrl} returned no message content`);
    }
    return { text: text.trim(), changedFiles: [] };
  }
}
