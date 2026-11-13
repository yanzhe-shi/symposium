import { diffLineKind } from '../text-format.ts';

/** A unified diff with added, removed and header lines coloured. */
export function DiffView({ diff, truncated }: { diff: string; truncated: boolean }) {
  return (
    <pre className="diff">
      {diff.split('\n').map((line, index) => (
        <span key={index} className={`diff-line diff-${diffLineKind(line)}`}>
          {line}
          {'\n'}
        </span>
      ))}
      {truncated && <span className="diff-line muted">… diff truncated</span>}
    </pre>
  );
}
