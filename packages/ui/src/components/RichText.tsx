import { formatText } from '../text-format.ts';

/** Message text with code and highlighted @mentions. Renders elements only, never raw HTML. */
export function RichText({ text, names }: { text: string; names: readonly string[] }) {
  return (
    <div className="rich-text">
      {formatText(text, names).map((segment, index) => {
        switch (segment.kind) {
          case 'text':
            return <span key={index}>{segment.text}</span>;
          case 'code':
            return <code key={index}>{segment.text}</code>;
          case 'mention':
            return (
              <span key={index} className="mention">
                @{segment.name}
              </span>
            );
          case 'codeBlock':
            return (
              <pre key={index} className="code-block" data-language={segment.language || undefined}>
                <code>{segment.text}</code>
              </pre>
            );
        }
      })}
    </div>
  );
}
