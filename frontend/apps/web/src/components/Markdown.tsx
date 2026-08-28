import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  children?: string | null;
  /**
   * Drop the paragraph wrapper, rendering the content as inline nodes.
   *
   * For callers whose markup already supplies the block: a feed card's bullet is
   * a `<li>` (sometimes with its own flex layout and bullet glyph), and the
   * default `<p>` either nests illegally inside an existing `<p>` or introduces
   * a block box that breaks that layout. Only the paragraph is unwrapped —
   * emphasis, links, and code still render, which is all these one-line strings
   * contain in practice.
   *
   * Multi-paragraph content passed with `inline` runs together, so use it only
   * where the content is known to be a single line.
   */
  inline?: boolean;
}

/**
 * Markdown renderer for model-authored text.
 *
 * Raw HTML is NOT enabled (no rehype-raw), so embedded markup in an LLM
 * response renders as literal text rather than executing — the reason this is
 * safe to point at generated content.
 */
export function Markdown({ children, inline = false }: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={inline ? { p: ({ children: content }) => <>{content}</> } : undefined}
    >
      {children}
    </ReactMarkdown>
  );
}
