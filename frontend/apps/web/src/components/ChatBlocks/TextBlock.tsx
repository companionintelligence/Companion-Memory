import React from 'react';

interface TextBlockProps {
  content: string;
}

export const TextBlock: React.FC<TextBlockProps> = ({ content }) => {
  const trimmedContent = content.trim();

  if (!trimmedContent) {
    return null;
  }

  return <div className="whitespace-pre-wrap leading-relaxed">{trimmedContent}</div>;
};
