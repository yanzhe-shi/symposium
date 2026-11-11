import { useState, type FormEvent, type KeyboardEvent } from 'react';

/** Drops blank lines at the start and whitespace at the end, but keeps first-line indentation. */
export function cleanDraft(draft: string): string {
  return draft.replace(/^\s*\n/, '').trimEnd();
}

export function Composer({ onSend }: { onSend: (body: string) => Promise<void> }) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(): Promise<void> {
    const body = cleanDraft(draft);
    if (sending || body === '') return;
    setSending(true);
    setError(undefined);
    try {
      await onSend(body);
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    void submit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // Enter sends, Shift+Enter adds a newline. Ignore Enter while an IME is composing text.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <form className="composer" onSubmit={handleSubmit}>
      {error && <p className="composer-error">Could not send: {error}</p>}
      <div className="composer-row">
        <textarea
          aria-label="Message"
          placeholder="Message the team (Enter to send, Shift+Enter for a new line)"
          rows={2}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={sending}
          autoFocus
        />
        <button type="submit" disabled={sending || draft.trim() === ''}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </form>
  );
}
