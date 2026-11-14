import { useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { SendIcon } from './icons.tsx';

/** Drops blank lines at the start and whitespace at the end, but keeps first-line indentation. */
export function cleanDraft(draft: string): string {
  return draft.replace(/^\s*\n/, '').trimEnd();
}

export function Composer({
  onSend,
  placeholder,
  hint,
}: {
  onSend: (body: string) => Promise<void>;
  placeholder: string;
  /** A line of help shown under the box. */
  hint?: React.ReactNode;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const boxRef = useRef<HTMLTextAreaElement>(null);

  // The box grows with the text, up to the limit the stylesheet sets, then scrolls.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${box.scrollHeight}px`;
  }, [draft]);

  // The box is never locked: it clears at once so the next message can be typed while this one
  // is on its way, and while the team is working.
  async function submit(): Promise<void> {
    const body = cleanDraft(draft);
    if (body === '') return;
    setDraft('');
    setError(undefined);
    try {
      await onSend(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Give the text back, unless something new has been typed since.
      setDraft((current) => (current === '' ? body : current));
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
      <div className="composer-box">
        <textarea
          ref={boxRef}
          aria-label="Message"
          placeholder={placeholder}
          rows={1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
        />
        <button
          type="submit"
          className="send-button"
          disabled={draft.trim() === ''}
          title="Send (Enter)"
          aria-label="Send"
        >
          <SendIcon />
        </button>
      </div>
      {hint && <p className="composer-hint">{hint}</p>}
    </form>
  );
}
