import { useMemo, useState, type ReactNode } from 'react';
import { parseInline, parseMarkdown, type Block, type Inline } from '../markdown.ts';

function renderInline(parts: Inline[]): ReactNode {
  return parts.map((part, index) => {
    switch (part.kind) {
      case 'text':
        return part.text;
      case 'code':
        return <code key={index}>{part.text}</code>;
      case 'mention':
        return (
          <span key={index} className="mention">
            @{part.name}
          </span>
        );
      case 'link':
        return (
          <a key={index} href={part.href} target="_blank" rel="noreferrer noopener">
            {part.text}
          </a>
        );
      case 'bold':
        return <strong key={index}>{renderInline(part.children)}</strong>;
      case 'italic':
        return <em key={index}>{renderInline(part.children)}</em>;
      case 'strike':
        return <s key={index}>{renderInline(part.children)}</s>;
    }
  });
}

function CodeBlock({ language, text }: { language: string; text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // The clipboard is not available (an insecure page, or permission refused). Nothing to do.
    }
  }

  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span>{language || 'text'}</span>
        <button type="button" className="code-copy" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

function renderBlocks(blocks: Block[]): ReactNode {
  return blocks.map((block, index) => {
    switch (block.kind) {
      case 'paragraph':
        return <p key={index}>{renderInline(block.content)}</p>;
      case 'heading': {
        // Message headings are kept modest: an agent's "# Title" must not shout over the chat.
        const Tag = block.level <= 1 ? 'h3' : block.level === 2 ? 'h4' : 'h5';
        return <Tag key={index}>{renderInline(block.content)}</Tag>;
      }
      case 'rule':
        return <hr key={index} />;
      case 'quote':
        return <blockquote key={index}>{renderBlocks(block.blocks)}</blockquote>;
      case 'codeBlock':
        return <CodeBlock key={index} language={block.language} text={block.text} />;
      case 'table':
        return (
          <div key={index} className="table-scroll">
            <table>
              <thead>
                <tr>
                  {block.header.map((cell, column) => (
                    <th key={column}>{renderInline(cell)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, column) => (
                      <td key={column}>{renderInline(cell)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case 'list': {
        const items = block.items.map((item, itemIndex) => {
          const [first, ...rest] = item.blocks;
          const lead = first?.kind === 'paragraph' ? renderInline(first.content) : null;
          const task = item.checked !== undefined;
          return (
            <li key={itemIndex} className={task ? 'task-item' : undefined}>
              {task && (
                <span className={item.checked ? 'task-box task-done' : 'task-box'} aria-hidden>
                  {item.checked ? '✓' : ''}
                </span>
              )}
              {lead}
              {renderBlocks(lead === null ? item.blocks : rest)}
            </li>
          );
        });
        return block.ordered ? (
          <ol key={index} start={block.start}>
            {items}
          </ol>
        ) : (
          <ul key={index}>{items}</ul>
        );
      }
    }
  });
}

/** One line of text with `code`, **bold** and links, for labels and descriptions. */
export function InlineText({ text }: { text: string }) {
  return <>{renderInline(parseInline(text, []))}</>;
}

/**
 * Message text, read as Markdown, with highlighted @mentions. Renders elements only, never raw
 * HTML, and links only to web addresses.
 */
export function RichText({ text, names }: { text: string; names: readonly string[] }) {
  const key = names.join('\n');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for the names
  const blocks = useMemo(() => parseMarkdown(text, names), [text, key]);
  return <div className="rich-text">{renderBlocks(blocks)}</div>;
}
