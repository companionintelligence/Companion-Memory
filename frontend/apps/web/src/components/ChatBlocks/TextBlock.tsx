import React from 'react';

import ReactMarkdown from 'react-markdown';

interface TextBlockProps {
  content: string;
}

export const TextBlock: React.FC<TextBlockProps> = ({ content }) => {
  const trimmedContent = content.trim();

  if (!trimmedContent) {
    return null;
  }

  return (
    <div className="prose prose-stone max-w-none leading-relaxed dark:prose-invert">
      <ReactMarkdown>{trimmedContent}</ReactMarkdown>
    </div>
  );
};
