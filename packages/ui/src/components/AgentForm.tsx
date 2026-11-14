import type {
  Agent,
  CommandMode,
  EffortLevel,
  FileAccess,
  Group,
  ModelInfo,
  ProviderId,
  ProviderInfo,
  ProviderOptions,
  RoleKind,
} from '@symposium/engine/protocol';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import type { Catalog } from '../App.tsx';
import { InlineText } from './RichText.tsx';

interface AgentFormProps {
  group: Group;
  team: Agent[];
  catalog: Catalog;
  /** The agent to edit. Without it the form hires a new one. */
  agent?: Agent;
  onDone: () => void;
}

const FILE_ACCESS_LABELS: Record<FileAccess, string> = {
  none: 'None: chat only',
  read: 'Read: project folder',
  edit: 'Edit: own worktree',
};
const FILE_ACCESS: FileAccess[] = ['none', 'read', 'edit'];
const COMMAND_MODES: CommandMode[] = ['off', 'ask', 'allowlist', 'auto'];
const COMMAND_MODE_LABELS: Record<CommandMode, string> = {
  off: 'Off: no terminal',
  ask: 'Ask every time',
  allowlist: 'Allow-list: ask for the rest',
  auto: 'Full auto',
};
const COMMAND_MODE_HELP: Record<CommandMode, string> = {
  off: 'This agent cannot run terminal commands.',
  ask: 'Every command waits in the chat for you to allow or deny it.',
  allowlist: 'Commands on the list below run at once. You are asked about any other.',
  auto: 'Commands run without asking, in the agent’s own worktree.',
};
const ALWAYS_ASKS =
  'Whatever you choose, these always ask: git push, deleting a branch, sudo, and anything that reaches outside the agent’s folder.';
const EFFORT_LEVELS: EffortLevel[] = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];

/** A team starts with a lead; after that most hires are workers. */
function suggestedRole(team: Agent[]): RoleKind {
  return team.some((agent) => agent.role === 'lead') ? 'worker' : 'lead';
}

function defaultModel(provider: ProviderInfo, role: RoleKind): string {
  return role === 'scribe' ? provider.smallModel : (provider.modelSuggestions[0] ?? '');
}

/** The provider options that apply to a provider, without empty values. */
function optionsFor(providerId: ProviderId, typed: Required<ProviderOptions>): ProviderOptions {
  const isCli = providerId === 'claude-code' || providerId === 'antigravity';
  const isApi = providerId === 'openai-compatible';
  return {
    ...(isCli && typed.command.trim() ? { command: typed.command.trim() } : {}),
    ...(isApi && typed.baseUrl.trim() ? { baseUrl: typed.baseUrl.trim() } : {}),
    ...(isApi && typed.apiKeyEnv.trim() ? { apiKeyEnv: typed.apiKeyEnv.trim() } : {}),
  };
}

interface ModelLookup {
  /** Which provider and options this answer is for. */
  key: string;
  models?: ModelInfo[];
  error?: string;
}

/** Hires a new agent, or changes one already on the team without firing it. */
export function AgentForm({ group, team, catalog, agent, onDone }: AgentFormProps) {
  const firstProvider = catalog.providers[0]!;
  const [name, setName] = useState(agent?.name ?? '');
  const [role, setRole] = useState<RoleKind>(() => agent?.role ?? suggestedRole(team));
  const [providerId, setProviderId] = useState<ProviderId>(agent?.provider ?? firstProvider.id);
  const [model, setModel] = useState(
    () => agent?.model ?? defaultModel(firstProvider, suggestedRole(team)),
  );
  const [instructions, setInstructions] = useState(agent?.instructions ?? '');
  const [command, setCommand] = useState(agent?.options.command ?? '');
  const [baseUrl, setBaseUrl] = useState(agent?.options.baseUrl ?? '');
  const [apiKeyEnv, setApiKeyEnv] = useState(agent?.options.apiKeyEnv ?? '');
  // Undefined means "whatever the role gives", so the choice follows the role until it is made.
  const [chosenFiles, setChosenFiles] = useState<FileAccess | undefined>(agent?.settings.files);
  const [effort, setEffort] = useState<EffortLevel>(agent?.settings.effort ?? 'default');
  const [chosenCommands, setChosenCommands] = useState<CommandMode | undefined>(
    agent?.settings.commands,
  );
  // One pattern per line.
  const [allowlist, setAllowlist] = useState((agent?.settings.allowlist ?? []).join('\n'));
  // The options the model list was last asked with. Updated when a field loses focus, so
  // the provider is not asked on every keystroke.
  const [lookupOptions, setLookupOptions] = useState<ProviderOptions>(() =>
    optionsFor(agent?.provider ?? firstProvider.id, { command, baseUrl, apiKeyEnv }),
  );
  const [lookup, setLookup] = useState<ModelLookup>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const provider = catalog.providers.find((p) => p.id === providerId) ?? firstProvider;
  const roleInfo = catalog.roles.find((r) => r.kind === role);
  const roleFiles = roleInfo?.defaultFiles ?? 'read';
  const files = role === 'scribe' ? 'none' : (chosenFiles ?? roleFiles);
  const roleCommands = roleInfo?.defaultCommands ?? 'off';
  const takenSeats = new Set(
    team
      .filter((member) => member.id !== agent?.id)
      .filter((member) => member.role === 'lead' || member.role === 'scribe')
      .map((member) => member.role),
  );
  const isCli = provider.id === 'claude-code' || provider.id === 'antigravity';
  const hasTerminal = provider.canRunCommands && role !== 'scribe';
  const commands = hasTerminal ? (chosenCommands ?? roleCommands) : 'off';
  const patterns = allowlist
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const providerOptions = (): ProviderOptions =>
    optionsFor(provider.id, { command, baseUrl, apiKeyEnv });

  // Asks the provider which models it offers. The field stays free text: this only feeds the
  // suggestions, so a failed lookup is a note, not an error.
  const lookupKey = JSON.stringify([providerId, lookupOptions]);
  useEffect(() => {
    let active = true;
    api.models(providerId, lookupOptions).then(
      (list) => {
        if (active) setLookup({ key: lookupKey, models: list.models, error: list.error });
      },
      (err: unknown) => {
        if (active) setLookup({ key: lookupKey, error: String(err) });
      },
    );
    return () => {
      active = false;
    };
  }, [providerId, lookupOptions, lookupKey]);
  // An answer for other options is out of date: show "Loading" until the new one arrives.
  const answered = lookup?.key === lookupKey ? lookup : undefined;
  const models = answered?.models;
  const modelsError = answered?.error;
  const refreshModels = (): void => setLookupOptions(providerOptions());

  function changeProvider(id: ProviderId): void {
    setProviderId(id);
    setLookupOptions(optionsFor(id, { command, baseUrl, apiKeyEnv }));
    const next = catalog.providers.find((p) => p.id === id);
    if (next) setModel(defaultModel(next, role));
  }

  function changeRole(next: RoleKind): void {
    setRole(next);
    // File access and the terminal go back to what the new role gives.
    setChosenFiles(undefined);
    setChosenCommands(undefined);
    // Moving to or from the scribe changes which model makes sense.
    if (next === 'scribe' || role === 'scribe') setModel(defaultModel(provider, next));
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    const details = {
      role,
      provider: provider.id,
      model: model.trim(),
      instructions: instructions.trim(),
      options: providerOptions(),
      settings: {
        files,
        effort: isCli ? effort : ('default' as const),
        // A provider without a terminal keeps whatever was set, for the day it is swapped.
        ...(hasTerminal ? { commands, allowlist: patterns } : {}),
      },
    };
    try {
      if (agent) await api.editAgent(group.id, agent.id, details);
      else await api.hire(group.id, { name: name.trim(), ...details });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const suggestions: ModelInfo[] = models ?? provider.modelSuggestions.map((id) => ({ id }));

  return (
    <form className="panel-form" onSubmit={submit}>
      <h2>{agent ? `Edit ${agent.name}` : 'Hire an agent'}</h2>
      {agent ? (
        <p className="muted small">
          Changes apply from {agent.name}&apos;s next turn. Memory, branch and history stay.
        </p>
      ) : (
        <label>
          Name (used for @mentions)
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ada"
            pattern="[A-Za-z][A-Za-z0-9_\-]{0,31}"
            title="Letters, digits, - or _; starts with a letter"
            required
            autoFocus
          />
        </label>
      )}
      <label>
        Role
        <select value={role} onChange={(event) => changeRole(event.target.value as RoleKind)}>
          {catalog.roles.map((r) => (
            <option key={r.kind} value={r.kind} disabled={takenSeats.has(r.kind)}>
              {r.title}
              {takenSeats.has(r.kind) ? ' (taken)' : ''}
            </option>
          ))}
        </select>
      </label>
      {roleInfo && <p className="muted small">{roleInfo.summary}</p>}
      <label>
        Provider
        <select
          value={provider.id}
          onChange={(event) => changeProvider(event.target.value as ProviderId)}
        >
          {catalog.providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">
        <InlineText text={provider.description} />
      </p>
      <label>
        Model
        <input
          value={model}
          onChange={(event) => setModel(event.target.value)}
          list={`models-${provider.id}`}
          required
        />
        <datalist id={`models-${provider.id}`}>
          {suggestions.map((suggestion) => (
            <option key={suggestion.id} value={suggestion.id} label={suggestion.label} />
          ))}
        </datalist>
      </label>
      <p className="muted small">
        {modelsError
          ? `Could not ask ${provider.label} for its models (${modelsError}). You can still type any model name.`
          : models
            ? `${models.length} model${models.length === 1 ? '' : 's'} suggested by ${provider.label}. Any other model name works too.`
            : answered
              ? 'You can type any model name.'
              : 'Loading models…'}
      </p>
      <label>
        File access
        <select
          value={files}
          disabled={role === 'scribe'}
          onChange={(event) => setChosenFiles(event.target.value as FileAccess)}
        >
          {FILE_ACCESS.map((access) => (
            <option key={access} value={access}>
              {FILE_ACCESS_LABELS[access]}
              {access === roleFiles ? ' (usual)' : ''}
            </option>
          ))}
        </select>
      </label>
      {role === 'scribe' && (
        <p className="muted small">
          The scribe has no tools: it returns project.md and Symposium writes it.
        </p>
      )}
      {files === 'edit' && !provider.canEditFiles && (
        <p className="form-warning small">
          This provider cannot edit files, so this agent can only advise.
        </p>
      )}
      {hasTerminal && (
        <>
          <label>
            Terminal commands
            <select
              value={commands}
              onChange={(event) => setChosenCommands(event.target.value as CommandMode)}
            >
              {COMMAND_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {COMMAND_MODE_LABELS[mode]}
                  {mode === roleCommands ? ' (usual)' : ''}
                </option>
              ))}
            </select>
          </label>
          <p className="muted small">
            {files === 'edit' || commands === 'off'
              ? COMMAND_MODE_HELP[commands]
              : 'Without a worktree of its own this agent works in the project folder, so it can run only the commands on the list below.'}
            {commands !== 'off' && ` ${ALWAYS_ASKS}`}
          </p>
          {commands !== 'off' &&
            (commands !== 'auto' || files !== 'edit' || patterns.length > 0) && (
              <label>
                Allow-list (one command per line, * matches anything)
                <textarea
                  value={allowlist}
                  onChange={(event) => setAllowlist(event.target.value)}
                  placeholder={'pnpm test\nnpm run *\ngit status'}
                  rows={4}
                  spellCheck={false}
                />
              </label>
            )}
          {commands === 'ask' && files === 'edit' && patterns.length > 0 && (
            <p className="muted small">The list is kept but not used while every command asks.</p>
          )}
        </>
      )}
      {isCli && (
        <label>
          Effort
          <select value={effort} onChange={(event) => setEffort(event.target.value as EffortLevel)}>
            {EFFORT_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level === 'default' ? "Default (the provider's own)" : level}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Specialty (optional)
        <textarea
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder="Frontend specialist: React, accessibility, CSS"
          rows={3}
        />
      </label>
      {provider.id === 'openai-compatible' && (
        <>
          <label>
            Base URL
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              onBlur={refreshModels}
              placeholder="http://localhost:11434/v1 (Ollama)"
            />
          </label>
          <label>
            API key environment variable (optional)
            <input
              value={apiKeyEnv}
              onChange={(event) => setApiKeyEnv(event.target.value)}
              onBlur={refreshModels}
              placeholder="OPENAI_API_KEY"
            />
          </label>
          <p className="muted small">
            Give the variable&apos;s name, never the key. Symposium reads it when calling the API
            and never stores it.
          </p>
        </>
      )}
      {isCli && (
        <label>
          CLI path (optional)
          <input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            onBlur={refreshModels}
            placeholder={provider.id === 'claude-code' ? 'claude' : 'agy'}
          />
        </label>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button type="button" className="button-secondary" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" disabled={busy}>
          {agent ? (busy ? 'Saving…' : 'Save changes') : busy ? 'Hiring…' : 'Hire'}
        </button>
      </div>
    </form>
  );
}
