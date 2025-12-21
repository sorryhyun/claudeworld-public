import { useEffect, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useGame } from '@/contexts/GameContext';
import { API_BASE_URL, getFetchOptions } from '@/services/apiClient';

interface HowToUseModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function HowToUseModal({ open, onOpenChange }: HowToUseModalProps) {
  const { language } = useGame();
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchReadme = useCallback(async () => {
    if (!open) return;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `${API_BASE_URL}/readme?lang=${language}`,
        getFetchOptions()
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch readme: ${response.status}`);
      }

      const text = await response.text();
      setContent(text);
    } catch (err) {
      console.error('Error fetching readme:', err);
      setError(language === 'ko' ? '문서를 불러오는데 실패했습니다.' : 'Failed to load documentation.');
    } finally {
      setLoading(false);
    }
  }, [open, language]);

  useEffect(() => {
    fetchReadme();
  }, [fetchReadme]);

  const title = language === 'ko' ? '사용 방법' : 'How to Use';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="text-xl font-bold text-slate-800">
            {title}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto pr-2">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin h-8 w-8 border-2 border-slate-600 border-t-transparent rounded-full" />
            </div>
          ) : error ? (
            <div className="text-center py-12 text-red-600">
              {error}
            </div>
          ) : (
            <div className="prose prose-slate prose-sm max-w-none">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkBreaks]}
                components={{
                  h1: ({ children }) => (
                    <h1 className="text-2xl font-bold text-slate-800 mb-4 pb-2 border-b border-slate-200">
                      {children}
                    </h1>
                  ),
                  h2: ({ children }) => (
                    <h2 className="text-xl font-semibold text-slate-700 mt-6 mb-3">
                      {children}
                    </h2>
                  ),
                  h3: ({ children }) => (
                    <h3 className="text-lg font-medium text-slate-700 mt-4 mb-2">
                      {children}
                    </h3>
                  ),
                  p: ({ children }) => (
                    <p className="mb-3 text-slate-600 leading-relaxed">
                      {children}
                    </p>
                  ),
                  ul: ({ children }) => (
                    <ul className="list-disc list-inside mb-3 text-slate-600 space-y-1">
                      {children}
                    </ul>
                  ),
                  ol: ({ children }) => (
                    <ol className="list-decimal list-inside mb-3 text-slate-600 space-y-1">
                      {children}
                    </ol>
                  ),
                  li: ({ children }) => (
                    <li className="text-slate-600">{children}</li>
                  ),
                  blockquote: ({ children }) => (
                    <blockquote className="border-l-4 border-slate-300 pl-4 italic text-slate-500 my-3">
                      {children}
                    </blockquote>
                  ),
                  code: ({ className, children, ...props }: { className?: string; children?: React.ReactNode } & React.HTMLAttributes<HTMLElement>) => {
                    const isInline = !className;
                    return isInline ? (
                      <code className="bg-slate-100 text-slate-800 px-1.5 py-0.5 rounded text-sm font-mono" {...props}>
                        {children}
                      </code>
                    ) : (
                      <pre className="bg-slate-800 text-slate-100 p-4 rounded-lg overflow-x-auto my-3">
                        <code className="text-sm font-mono" {...props}>{children}</code>
                      </pre>
                    );
                  },
                  table: ({ children }) => (
                    <div className="overflow-x-auto my-4">
                      <table className="min-w-full border-collapse border border-slate-300">
                        {children}
                      </table>
                    </div>
                  ),
                  th: ({ children }) => (
                    <th className="border border-slate-300 px-3 py-2 bg-slate-100 text-left font-semibold text-slate-700">
                      {children}
                    </th>
                  ),
                  td: ({ children }) => (
                    <td className="border border-slate-300 px-3 py-2 text-slate-600">
                      {children}
                    </td>
                  ),
                  hr: () => <hr className="my-6 border-slate-200" />,
                  a: ({ children, href }) => (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:text-blue-500 underline"
                    >
                      {children}
                    </a>
                  ),
                  strong: ({ children }) => (
                    <strong className="font-semibold text-slate-800">{children}</strong>
                  ),
                }}
              >
                {content}
              </ReactMarkdown>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
