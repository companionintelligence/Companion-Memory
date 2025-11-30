import { Images } from '@ci/shadcn/icons';

import { Empty } from '@/pages/MemoryPage/Components';
import { ResultCard } from '@/pages/MemoryPage/GalleryView/ResultCard';
import type { MemoryItem, SearchResult } from '@/pages/MemoryPage/types.ts';

import { useMemoryService } from '../useMemoryService';

export function GalleryView() {
  const { memories, searchResults } = useMemoryService();

  let combinedResults: (SearchResult | MemoryItem)[] = [];
  const memoryIds = memories.map((memory) => memory.id);
  const uniqueSearchResults = searchResults.filter((searchResult) => {
    return !memoryIds.includes(searchResult.id);
  });
  combinedResults = combinedResults.concat(memories).concat(uniqueSearchResults);

  // Deduplicate files - if multiple memories reference the same file, only show the first one
  const seenFileIds = new Set<string>();
  const deduplicatedResults = combinedResults.filter((result) => {
    // For MemoryItem with file, check if we've seen this file ID before
    if ('file' in result && result.file?.id) {
      if (seenFileIds.has(result.file.id)) {
        return false; // Skip duplicate file
      }

      seenFileIds.add(result.file.id);
    }

    return true; // Include all other results
  });

  return (
    <>
      {deduplicatedResults.length === 0 ? (
        <Empty
          title="No files or results found"
          description="Upload a file or search to see content here"
          icon={Images}
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 p-4 pt-0">
          {deduplicatedResults.map((result) => (
            <ResultCard key={result.id || Math.random()} result={result} />
          ))}
        </div>
      )}
    </>
  );
}
