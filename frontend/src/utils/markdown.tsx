/**
 * Shared ReactMarkdown component definitions for game and chat views.
 *
 * Game view: prose-style narration (headings, blockquotes, hr, simple inline code)
 * Chat view: conversational messages (syntax-highlighted code blocks, tighter spacing)
 */
import type { Components } from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

/**
 * Markdown components for the TRPG game view (GameRoom).
 * Optimized for narrative prose: relaxed spacing, headings, blockquotes, hr.
 */
export const GAME_MARKDOWN_COMPONENTS: Components = {
  p: ({ children }) => (
    <p className="mb-3 last:mb-0 leading-relaxed whitespace-pre-wrap">
      {children}
    </p>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  ul: ({ children }) => (
    <ul className="list-disc list-inside mb-3 space-y-1">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal list-inside mb-3 space-y-1">{children}</ol>
  ),
  li: ({ children }) => <li>{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-4 border-slate-300 pl-4 italic text-slate-700 my-3">
      {children}
    </blockquote>
  ),
  h1: ({ children }) => (
    <h1 className="text-xl font-bold mb-2 mt-4 first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-lg font-bold mb-2 mt-3 first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-base font-bold mb-2 mt-3 first:mt-0">{children}</h3>
  ),
  hr: () => <hr className="my-4 border-slate-200" />,
  code: ({ children }) => (
    <code className="bg-slate-200 text-slate-800 px-1.5 py-0.5 rounded text-sm font-mono">
      {children}
    </code>
  ),
};

/**
 * Markdown components for the chat view (MessageRow).
 * Optimized for conversational messages: tighter spacing, syntax-highlighted code blocks.
 */
export const CHAT_MARKDOWN_COMPONENTS: Components = {
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  ul: ({ children }) => (
    <ul className="list-disc list-inside mb-2">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal list-inside mb-2">{children}</ol>
  ),
  li: ({ children }) => <li className="mb-1">{children}</li>,
  code: ({
    inline,
    className,
    children,
    ...props
  }: {
    inline?: boolean;
    className?: string;
    children?: React.ReactNode;
  } & React.HTMLAttributes<HTMLElement>) => {
    const match = /language-(\w+)/.exec(className || "");
    const codeString = String(children).replace(/\n$/, "");
    const isInline = inline ?? (!className && !codeString.includes("\n"));

    return isInline ? (
      <code
        className="bg-slate-200 text-slate-800 px-1.5 py-0.5 rounded text-sm font-mono"
        {...props}
      >
        {children}
      </code>
    ) : (
      <SyntaxHighlighter
        style={oneDark as { [key: string]: React.CSSProperties }}
        language={match ? match[1] : "text"}
        PreTag="div"
        customStyle={{
          margin: 0,
          borderRadius: "0.75rem",
          fontSize: "0.875rem",
        }}
      >
        {codeString}
      </SyntaxHighlighter>
    );
  },
  pre: ({ children }) => (
    <div className="mb-2 overflow-hidden rounded-xl">{children}</div>
  ),
};
