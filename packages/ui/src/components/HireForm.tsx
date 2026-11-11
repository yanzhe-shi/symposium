import type { Agent, Group, ProviderId, ProviderInfo, RoleKind } from '@symposium/engine/protocol';
import { useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import type { Catalog } from '../App.tsx';

interface HireFormProps {
  group: Group;
  team: Agent[];
  catalog: Catalog;
  onDone: () => void;
}

/** A team starts with a lead; after that most hires are workers. */
function suggestedRole(team: Agent[]): RoleKind {
  return team.some((agent) => agent.role === 'lead') ? 'worker' : 'lead';
}

function defaultModel(provider: ProviderInfo, role: RoleKind): string {
  return role === 'scribe' ? provider.smallModel : (provider.modelSuggestions[0] ?? '');
}

export function HireForm({ group, team, catalog, onDone }: HireFormProps) {
  const firstProvider = catalog.providers[0]!;
  const [name, setName] = useState('');
  const [role, setRole] = useState<RoleKind>(() => suggestedRole(team));
  const [providerId, setProviderId] = useState<ProviderId>(firstProvider.id);
  const [model, setModel] = useState(() => defaultModel(firstProvider, suggestedRole(team)));
  const [instructions, setInstructions] = useState('');
  const [command, setCommand] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKeyEnv, setApiKeyEnv] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const provider = catalog.providers.find((p) => p.id === providerId) ?? firstProvider;
  const roleInfo = catalog.roles.find((r) => r.kind === role);
  const takenSeats = new Set(
    team.filter((agent) => agent.role === 'lead' || agent.role === 'scribe').map((a) => a.role),
  );
  const isCli = provider.id === 'claude-code' || provider.id === 'antigravity';

  function changeProvider(id: ProviderId): void {
    setProviderId(id);
    const next = catalog.providers.find((p) => p.id === id);
    if (next) setModel(defaultModel(next, role));
  }

  function changeRole(next: RoleKind): void {
    setRole(next);
    // Moving to or from the scribe changes which model makes sense.
    if (next === 'scribe' || role === 'scribe') setModel(defaultModel(provider, next));
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.hire(group.id, {
        name: name.trim(),
        role,
        provider: provider.id,
        model: model.trim(),
        instructions: instructions.trim() || undefined,
        options: {
          ...(isCli && command.trim() ? { command: command.trim() } : {}),
          ...(provider.id === 'openai-compatible' && baseUrl.trim()
            ? { baseUrl: baseUrl.trim() }
            : {}),
          ...(provider.id === 'openai-compatible' && apiKeyEnv.trim()
            ? { apiKeyEnv: apiKeyEnv.trim() }
            : {}),
        },
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <form className="panel-form" onSubmit={submit}>
      <h2>Hire an agent</h2>
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
      <p className="muted small">{provider.description}</p>
      {role === 'worker' && !provider.canEditFiles && (
        <p className="form-warning small">
          This provider cannot edit files, so this worker can only advise.
        </p>
      )}
      <label>
        Model
        <input
          value={model}
          onChange={(event) => setModel(event.target.value)}
          list={`models-${provider.id}`}
          required
        />
        <datalist id={`models-${provider.id}`}>
          {provider.modelSuggestions.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      </label>
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
              placeholder="http://localhost:11434/v1 (Ollama)"
            />
          </label>
          <label>
            API key environment variable (optional)
            <input
              value={apiKeyEnv}
              onChange={(event) => setApiKeyEnv(event.target.value)}
              placeholder="OPENAI_API_KEY"
            />
          </label>
          <p className="muted small">
            Give the variable's name, never the key. Symposium reads it when calling the API and
            never stores it.
          </p>
        </>
      )}
      {isCli && (
        <label>
          CLI path (optional)
          <input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
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
          {busy ? 'Hiring…' : 'Hire'}
        </button>
      </div>
    </form>
  );
}
