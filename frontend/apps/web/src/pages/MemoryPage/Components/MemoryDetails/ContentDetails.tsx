import { useState, useEffect, useMemo } from 'react';

import { Label, Badge } from '@ci/shadcn';
import { Link, Calendar, Image as ImageIcon, Video as VideoIcon, FileText } from '@ci/shadcn/icons';

import { useAuth } from '@/hooks';

import type { MemoryItem, FileMeta } from '../../types';
import { formatBytes } from '../utils.tsx';

interface Props {
  memory: MemoryItem;
}

export function ContentDetails({ memory }: Props) {
  const [{ authToken }] = useAuth();

  const [fileDetails, setFileDetails] = useState<FileMeta[]>([]);
  const [loading, setLoading] = useState(true);

  const sourceData = memory.metadata?.sourceData as Record<string, unknown> | undefined;
  const linkedId = memory.metadata?.linkedId as string | undefined;
  const linkedIds = memory.metadata?.linkedIds as string[] | undefined;

  // Format timestamp
  const formattedDate = memory.timestamp
    ? new Date(memory.timestamp).toLocaleString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  // Display as 'Content' for all content types
  const postType = 'Content';

  // Memoize fileIds to prevent infinite loops
  const fileIds = useMemo(() => {
    return linkedIds && linkedIds.length > 0 ? linkedIds : linkedId ? [linkedId] : [];
  }, [linkedId, linkedIds]);

  const mediaCount = (sourceData?.media_count as number) || fileIds.length || 0;

  useEffect(() => {
    if (fileIds.length > 0) {
      setLoading(true);
      Promise.all(
        fileIds.map((id) =>
          fetch(`/api/files/${id}`, {
            headers: {
              Authorization: `Bearer ${authToken}`,
            },
          })
            .then((res) => res.json())
            .catch(() => null),
        ),
      )
        .then((files: (FileMeta | null)[]) => {
          setFileDetails(files.filter((f): f is FileMeta => f !== null));
          setLoading(false);
        })
        .catch(() => {
          setLoading(false);
        });
    } else {
      setLoading(false);
      setFileDetails([]);
    }
  }, [fileIds, authToken]);

  const imageFiles = fileDetails.filter((f) => f.contentType?.startsWith('image/'));
  const videoFiles = fileDetails.filter((f) => f.contentType?.startsWith('video/'));

  return (
    <div className="grid flex-1 auto-rows-min gap-6 px-4 pb-6">
      {/* Type and Media Count */}
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="secondary" className="flex items-center gap-1">
          <FileText className="h-3 w-3" />
          {postType}
        </Badge>
        {mediaCount > 0 && (
          <Badge variant="outline" className="flex items-center gap-1">
            {imageFiles.length > 0 && (
              <>
                <ImageIcon className="h-3 w-3" />
                {imageFiles.length} {imageFiles.length === 1 ? 'photo' : 'photos'}
              </>
            )}
            {videoFiles.length > 0 && (
              <>
                {imageFiles.length > 0 && ' • '}
                <VideoIcon className="h-3 w-3" />
                {videoFiles.length} {videoFiles.length === 1 ? 'video' : 'videos'}
              </>
            )}
          </Badge>
        )}
      </div>

      {/* Date Created */}
      {formattedDate && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Calendar className="h-4 w-4" />
          <span>Posted on {formattedDate}</span>
        </div>
      )}

      {/* Caption/Description */}
      {memory.description && (
        <div className="space-y-2">
          <Label className="text-xs font-semibold text-muted-foreground">Caption</Label>
          <p className="text-sm leading-relaxed">{memory.description}</p>
        </div>
      )}

      {/* File Previews */}
      {!loading && fileDetails.length > 0 && (
        <div className="space-y-4">
          <Label className="text-xs font-semibold text-muted-foreground">
            Media ({fileDetails.length} {fileDetails.length === 1 ? 'file' : 'files'})
          </Label>
          <div className={fileDetails.length > 1 ? 'grid grid-cols-2 gap-3' : 'space-y-3'}>
            {fileDetails.map((file) => (
              <div key={file.id} className="space-y-2">
                {file.contentType?.startsWith('image/') && (
                  <div className="aspect-video w-full overflow-hidden bg-muted rounded-lg">
                    <img
                      src={`/static/${file.url}`.replace('//', '/')}
                      alt={file.name || 'Preview'}
                      className="h-full w-full object-cover"
                      loading="lazy"
                      onError={(e) => {
                        (e.target as HTMLElement).style.display = 'none';
                      }}
                    />
                  </div>
                )}
                {file.contentType?.startsWith('video/') && (
                  <div className="aspect-video w-full overflow-hidden bg-black rounded-lg">
                    <video
                      src={`/static/${file.url}`.replace('//', '/')}
                      className="h-full w-full object-cover"
                      controls
                      preload="metadata"
                    />
                  </div>
                )}
                <div className="text-xs text-muted-foreground">
                  <div className="font-medium truncate" title={file.name}>
                    {file.name}
                  </div>
                  {file.size && <div>{formatBytes(file.size, 2)}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Source Link */}
      {memory.sourceLink && (
        <div className="flex items-center gap-2 pt-2 border-t">
          <Link className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <a
            href={memory.sourceLink}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary hover:text-primary/80 underline break-all"
          >
            View on Facebook
          </a>
        </div>
      )}
    </div>
  );
}
