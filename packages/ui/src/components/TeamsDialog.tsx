import type { Agent, Group, SavedTeam } from '@symposium/engine/protocol';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api.ts';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** "Lea (lead), Ada (worker)": who is on a saved team. */
export function savedTeamSummary(team: SavedTeam): string {
  return team.members.map((member) => `${member.name} (${member.role})`).join(', ');
}

/**
 * Saves the group's team under a name, and lists the saved teams: each can be hired into this
 * group or deleted.
 */
export function TeamsDialog({
  group,
  team,
  onClose,
}: {
  group: Group;
  team: Agent[];
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [saved, setSaved] = useState<SavedTeam[]>();
  const [name, setName] = useState(group.name);
  const [withMemory, setWithMemory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();

  useEffect(() => {
    dialogRef.current?.showModal();
    let active = true;
    api
      .teams()
      .then((list) => {
        if (active) setSaved(list);
      })
      .catch((err: unknown) => {
        if (active) setError(message(err));
      });
    return () => {
      active = false;
    };
  }, []);

  /** Runs one request, showing what went wrong or what was done. */
  async function run(work: () => Promise<string>): Promise<void> {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      setDone(await work());
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  function save(event: FormEvent): void {
    event.preventDefault();
    void run(async () => {
      const wanted = { name: name.trim(), withMemory };
      let team: SavedTeam;
      try {
        team = await api.saveTeam(group.id, wanted);
      } catch (err) {
        // The engine says so when the name is taken. Writing over it is the human's call.
        if (!message(err).startsWith('There is already a saved team')) throw err;
        if (!confirm(`${message(err)}. Replace it with this team?`)) return '';
        team = await api.saveTeam(group.id, { ...wanted, replace: true });
      }
      setSaved(await api.teams());
      return `Saved "${team.name}".`;
    });
  }

  function hire(team: SavedTeam): void {
    void run(async () => {
      const result = await api.hireTeam(group.id, team.id);
      const hired = result.hired.map((agent) => agent.name).join(', ');
      if (result.skipped.length === 0) return `Hired ${hired}.`;
      return `${hired ? `Hired ${hired}. ` : ''}Not hired: ${result.skipped.join('; ')}`;
    });
  }

  function remove(team: SavedTeam): void {
    if (!confirm(`Delete the saved team "${team.name}"? Agents already hired from it stay.`)) {
      return;
    }
    void run(async () => {
      setSaved(await api.removeTeam(team.id));
      return `Deleted "${team.name}".`;
    });
  }

  return (
    <dialog ref={dialogRef} className="dialog" onClose={onClose}>
      <h2>Saved teams</h2>
      <p className="muted small">
        A saved team keeps who is on the team and how each agent is set up: provider, model, role,
        specialty and permissions. Hire it into any group, or pick it when you create one.
      </p>
      <form className="saved-team-form" onSubmit={save}>
        <label>
          Save this team as
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            required
            disabled={team.length === 0}
          />
        </label>
        <label className="setting-row">
          <span>
            Save what they remember too
            <small>
              Off: the team starts fresh in its next group. On: each agent brings its memory notes
              from this project along.
            </small>
          </span>
          <input
            type="checkbox"
            className="switch"
            role="switch"
            checked={withMemory}
            onChange={(event) => setWithMemory(event.target.checked)}
            disabled={team.length === 0}
          />
        </label>
        <div className="form-actions">
          <button type="submit" disabled={busy || team.length === 0 || !name.trim()}>
            Save team
          </button>
        </div>
        {team.length === 0 && (
          <p className="muted small">Nobody is on this team yet, so there is nothing to save.</p>
        )}
      </form>
      {error && <p className="form-error">{error}</p>}
      {done && <p className="form-done small">{done}</p>}
      <h3 className="saved-team-heading">Saved</h3>
      {saved === undefined ? (
        !error && <p className="muted small">Loading…</p>
      ) : saved.length === 0 ? (
        <p className="muted small">No team saved yet.</p>
      ) : (
        <ul className="saved-team-list">
          {saved.map((entry) => (
            <li key={entry.id}>
              <div className="saved-team-text">
                <strong>{entry.name}</strong>
                <span className="muted small">
                  {savedTeamSummary(entry)}
                  {entry.members.some((member) => member.hasMemory) && ' · with memory'}
                </span>
              </div>
              <button
                type="button"
                className="button-secondary"
                disabled={busy}
                title={`Hire this team into ${group.name}. Anyone whose name or seat is taken is left out.`}
                onClick={() => hire(entry)}
              >
                Hire here
              </button>
              <button
                type="button"
                className="link-button danger"
                disabled={busy}
                onClick={() => remove(entry)}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="form-actions">
        <button type="button" className="button-secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}

/** Sends an agent to another group: a copy is hired there, with its memory unless switched off. */
export function SendAgentDialog({
  group,
  agent,
  onClose,
}: {
  group: Group;
  agent: Agent;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [others, setOthers] = useState<Group[]>();
  const [toGroupId, setToGroupId] = useState('');
  const [name, setName] = useState(agent.name);
  const [withMemory, setWithMemory] = useState(true);
  const [leave, setLeave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    dialogRef.current?.showModal();
    let active = true;
    api
      .groups()
      .then((groups) => {
        if (!active) return;
        const list = groups.filter((other) => other.id !== group.id);
        setOthers(list);
        setToGroupId(list[0]?.id ?? '');
      })
      .catch((err: unknown) => {
        if (active) setError(message(err));
      });
    return () => {
      active = false;
    };
  }, [group.id]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.sendAgent(group.id, agent.id, { toGroupId, name: name.trim(), withMemory, leave });
      onClose();
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialogRef} className="dialog" onClose={onClose}>
      <h2>Send {agent.name} to another group</h2>
      <p className="muted small">
        {agent.name} is hired there with the same provider, model, role, specialty and permissions.
        Their branch and their work here stay here.
      </p>
      {others?.length === 0 ? (
        <p className="muted">There is no other group yet. Create one first.</p>
      ) : (
        <form className="saved-team-form" onSubmit={(event) => void submit(event)}>
          <label>
            Group
            <select
              value={toGroupId}
              onChange={(event) => setToGroupId(event.target.value)}
              disabled={!others}
            >
              {others?.map((other) => (
                <option key={other.id} value={other.id}>
                  {other.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Name there
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={32}
              required
            />
          </label>
          <label className="setting-row">
            <span>
              Take their memory along
              <small>
                A copy of {agent.name}'s memory notes goes with them, marked as coming from{' '}
                {group.name}.
              </small>
            </span>
            <input
              type="checkbox"
              className="switch"
              role="switch"
              checked={withMemory}
              onChange={(event) => setWithMemory(event.target.checked)}
            />
          </label>
          <label className="setting-row">
            <span>
              Leave this team
              <small>
                Off: {agent.name} works in both groups. On: {agent.name} is fired here once they
                have arrived there.
              </small>
            </span>
            <input
              type="checkbox"
              className="switch"
              role="switch"
              checked={leave}
              onChange={(event) => setLeave(event.target.checked)}
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <div className="form-actions">
            <button type="button" className="button-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={busy || !toGroupId || !name.trim()}>
              {busy ? 'Sending…' : `Send ${agent.name}`}
            </button>
          </div>
        </form>
      )}
      {others?.length === 0 && (
        <div className="form-actions">
          <button type="button" className="button-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      )}
    </dialog>
  );
}
