import { type RefObject, useMemo } from 'react';

import { cn } from '@ci/shadcn';
import { Bot } from '@ci/shadcn/icons';

interface Props {
  content?: string;
  renderEmptyContent?: boolean;
  streamingRef?: RefObject<HTMLDivElement | null> | ((el: HTMLDivElement | null) => void);
}

// Helper function to extract image URLs from content
function extractImageUrls(content: string): Array<{ url: string; alt: string }> {
  const imageUrlRegex = /!\[([^\]]*)\]\(([^)]+)\)/g; // Markdown image format
  const matches = [];
  let match;
  
  while ((match = imageUrlRegex.exec(content)) !== null) {
    matches.push({
      alt: match[1] || 'Generated image',
      url: match[2]
    });
  }
  
  return matches;
}

// Helper function to render content with images
function renderContentWithImages(content: string) {
  const imageData = extractImageUrls(content);
  
  if (imageData.length === 0) {
    return <>{content}</>;
  }

  // Split content and render with images
  const parts = content.split(/!\[([^\]]*)\]\(([^)]+)\)/g);
  const elements = [];
  
  for (let i = 0; i < parts.length; i += 3) {
    // Text before image
    if (parts[i]) {
      elements.push(<span key={`text-${i}`}>{parts[i]}</span>);
    }
    
    // Image (if exists)
    if (parts[i + 2]) {
      const altText = parts[i + 1] || 'Generated image';
      const imageUrl = parts[i + 2];
      elements.push(
        <div key={`image-${i}`} className="my-4 first:mt-2 last:mb-2">
          <div className="relative group">
            <img 
              src={imageUrl} 
              alt={altText}
              className="max-w-full h-auto rounded-lg border border-border/50 shadow-sm transition-shadow hover:shadow-md"
              style={{ maxHeight: '400px' }}
              loading="lazy"
              onError={(e) => {
                const target = e.target as HTMLImageElement;
                target.style.display = 'none';
              }}
            />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-colors rounded-lg pointer-events-none" />
          </div>
          {altText && altText !== 'Generated image' && (
            <p className="text-xs text-muted-foreground mt-2 italic">{altText}</p>
          )}
        </div>
      );
    }
  }
  
  return <>{elements}</>;
}

function AssistantMessage(props: Props) {
  const { content, renderEmptyContent = false, streamingRef } = props;

  const trimmedContent = useMemo(() => content?.trim(), [content]);

  if (!trimmedContent && !renderEmptyContent) {
    return null;
  }

  return (
    <div
      className={cn(
        'relative rounded-xl rounded-tl-none px-4 py-3 text-sm whitespace-pre-wrap leading-relaxed shadow-sm bg-gradient-to-br from-muted to-muted/80 text-foreground border border-border/50 backdrop-blur-sm',
        'has-[>.streaming-content:empty]:hidden',
      )}
    >
      <div className="streaming-content" ref={streamingRef}>
        {trimmedContent ? renderContentWithImages(trimmedContent) : null}
      </div>

      <div className="absolute -top-2 -left-2 p-1 rounded-full bg-gradient-to-br from-gray-400 to-gray-400">
        <Bot className="h-4 w-4 text-primary-foreground z-10" />
      </div>
    </div>
  );
}

export { AssistantMessage };
