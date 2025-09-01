import { v7 as uuidv7 } from 'uuid';

import type { RequestContext } from '@ci/common/types';
import type { ContentService, CreateContentDto } from '@ci/domains/memory';

import type { Connection } from '../types';

import { BaseOAuth2Client } from './BaseOAuth2Client';
import type { SyncResult, SyncResponse } from './types';

// Local interface for creating content without required event_id
interface DropboxContentDto {
  id: string;
  type: string;
  title?: string;
  text?: string | null;
  url?: string | null;
  mimetype?: string | null;
  external_id?: string | null;
  source_url?: string | null;
  source_data?: Record<string, unknown> | DropboxFileEntry | DropboxAccountData | DropboxSpaceData;
  user?: {
    id: string;
  };
}

// Basic types for Dropbox API responses
interface DropboxAccountData {
  account_id: string;
  email: string;
  name?: {
    display_name?: string;
    given_name?: string;
    surname?: string;
  };
}

interface DropboxSpaceData {
  used: number;
  allocation?: {
    allocated?: number;
  };
}

interface DropboxFileEntry {
  '.tag': string;
  id?: string;
  rev?: string;
  name: string;
  path_lower?: string;
  server_modified?: string;
  media_info?: Record<string, unknown>;
  sharing_info?: {
    preview_url?: string;
  };
  preview_url?: string;
  description?: string;
  preview_text?: string;
}

interface DropboxFilesData {
  entries: DropboxFileEntry[];
  cursor?: string;
  has_more: boolean;
}

interface DropboxSearchData {
  matches: Array<{
    metadata: {
      metadata: DropboxFileEntry;
    };
  }>;
}

interface DropboxSharedData {
  entries: Array<{
    shared_folder_id: string;
    name: string;
    access_type?: string;
    preview_url?: string;
  }>;
}

interface DropboxPaperData {
  doc_ids: string[];
}

export class DropboxClient extends BaseOAuth2Client {
  async sync(connection: Connection, contentService: ContentService, userId: string): Promise<SyncResponse> {
    this.logger.log('Syncing Dropbox data', { connectionId: connection.id });

    const syncResults: SyncResult[] = [];
    const errors: string[] = [];
    const contentItems: DropboxContentDto[] = [];

    // Helper function to create content items from API responses
    const createContentFromFile = (fileData: DropboxFileEntry, apiName: string) => {
      try {
        const contentId = uuidv7();

        const contentItem: DropboxContentDto = {
          id: contentId,
          type: this.determineContentType(fileData),
          title: fileData.name || 'Untitled',
          text: fileData.preview_text || fileData.description || null,
          url: fileData.preview_url || fileData.sharing_info?.preview_url || null,
          mimetype: this.determineMimeType(fileData),
          external_id: fileData.id || fileData.rev || null,
          source_url: `https://www.dropbox.com/home${fileData.path_lower || ''}`,
          source_data: fileData,
          user: {
            id: userId,
          },
        };

        contentItems.push(contentItem);

        return contentItem;
      } catch (error) {
        this.logger.warn(`Failed to create content item from ${apiName} data`, {
          error: error instanceof Error ? error.message : 'Unknown error',
          fileData: JSON.stringify(fileData).substring(0, 200) + '...',
        });

        return null;
      }
    };

    // Helper function to determine content type
    const determineContentType = (fileData: DropboxFileEntry): string => {
      if (fileData['.tag'] === 'folder') {
        return 'folder';
      }

      if (fileData.media_info) {
        return 'media';
      }

      if (fileData.path_lower?.includes('.pdf')) {
        return 'document';
      }

      if (fileData.path_lower?.includes('.txt')) {
        return 'text';
      }

      if (fileData.path_lower?.includes('.doc')) {
        return 'document';
      }

      if (fileData.path_lower?.includes('.xls')) {
        return 'spreadsheet';
      }

      if (fileData.path_lower?.includes('.ppt')) {
        return 'presentation';
      }

      if (fileData.path_lower?.match(/\.(jpg|jpeg|png|gif|bmp)$/i)) {
        return 'image';
      }

      if (fileData.path_lower?.match(/\.(mp4|avi|mov|wmv|flv)$/i)) {
        return 'video';
      }

      if (fileData.path_lower?.match(/\.(mp3|wav|flac|aac)$/i)) {
        return 'audio';
      }

      return 'file';
    };

    // Helper function to determine MIME type
    const determineMimeType = (fileData: DropboxFileEntry): string | null => {
      if (!fileData.path_lower) {
        return null;
      }

      const ext = fileData.path_lower.split('.').pop()?.toLowerCase();
      const mimeTypes: Record<string, string> = {
        pdf: 'application/pdf',
        txt: 'text/plain',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xls: 'application/vnd.ms-excel',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ppt: 'application/vnd.ms-powerpoint',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        mp4: 'video/mp4',
        mp3: 'audio/mpeg',
        wav: 'audio/wav',
      };

      return ext ? mimeTypes[ext] || 'application/octet-stream' : null;
    };

    // Store references to the helper functions in the class context
    this.determineContentType = determineContentType;
    this.determineMimeType = determineMimeType;

    // Dropbox Current Account Info
    try {
      const accountData = await this.request<DropboxAccountData>(connection, '/2/users/get_current_account');

      // Create content item for account info
      const accountContent: DropboxContentDto = {
        id: uuidv7(),
        type: 'account',
        title: accountData.name?.display_name || accountData.email || 'Dropbox Account',
        text: `Dropbox account: ${accountData.email}`,
        external_id: accountData.account_id,
        source_url: 'https://www.dropbox.com/account',
        source_data: accountData,
        user: {
          id: userId,
        },
      };

      contentItems.push(accountContent);

      syncResults.push({
        api: 'Dropbox Account',
        data: accountData,
      });
    } catch (error) {
      const errorMsg = `Dropbox Account API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(errorMsg);
    }

    // Dropbox Space Usage
    try {
      const spaceData = await this.request<DropboxSpaceData>(connection, '/2/users/get_space_usage');

      // Create content item for space usage
      const spaceContent: DropboxContentDto = {
        id: uuidv7(),
        type: 'usage',
        title: 'Dropbox Storage Usage',
        text: `Used: ${spaceData.used} bytes, Allocated: ${spaceData.allocation?.allocated || 'Unknown'} bytes`,
        external_id: `space_usage_${userId}`,
        source_url: 'https://www.dropbox.com/account/usage',
        source_data: spaceData,
        user: {
          id: userId,
        },
      };

      contentItems.push(spaceContent);

      syncResults.push({ api: 'Dropbox Space Usage', data: spaceData });
    } catch (error) {
      const errorMsg = `Dropbox Space Usage API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(errorMsg);
    }

    // Dropbox Files - List root folder contents with metadata
    try {
      const filesData = await this.request<DropboxFilesData>(connection, '/2/files/list_folder', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path: '',
          recursive: true, // Get all files recursively
          include_media_info: true,
          include_deleted: false,
          include_has_explicit_shared_members: true,
          include_mounted_folders: true,
          limit: 500, // Increased limit to get more files
        }),
      });

      // Process each file/folder entry
      if (filesData.entries && Array.isArray(filesData.entries)) {
        for (const entry of filesData.entries) {
          createContentFromFile(entry, 'Dropbox Files');
        }
      }

      syncResults.push({ api: 'Dropbox Files', data: filesData });
    } catch (error) {
      const errorMsg = `Dropbox Files API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(errorMsg);
    }

    // Dropbox File Search - Recent files
    try {
      const searchData = await this.request<DropboxSearchData>(connection, '/2/files/search_v2', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: '',
          options: {
            path: '',
            max_results: 100,
            order_by: {
              '.tag': 'last_modified_time',
              order: 'descending',
            },
            file_status: 'active',
            filename_only: false,
          },
        }),
      });

      // Process search results - these might be duplicates of files already processed
      if (searchData.matches && Array.isArray(searchData.matches)) {
        const recentFileIds = new Set(contentItems.map((item) => item.external_id));

        for (const match of searchData.matches) {
          if (match.metadata && match.metadata.metadata) {
            const fileData = match.metadata.metadata;
            // Only create content if we haven't seen this file already
            if (!recentFileIds.has(fileData.id)) {
              createContentFromFile(fileData, 'Dropbox Search');
            }
          }
        }
      }

      syncResults.push({ api: 'Dropbox Search', data: searchData });
    } catch (error) {
      const errorMsg = `Dropbox Search API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(errorMsg);
    }

    // Dropbox Shared Folders
    try {
      const sharedData = await this.request<DropboxSharedData>(connection, '/2/sharing/list_folders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          limit: 50,
          actions: [],
        }),
      });

      // Process shared folders
      if (sharedData.entries && Array.isArray(sharedData.entries)) {
        for (const folder of sharedData.entries) {
          const sharedContent: DropboxContentDto = {
            id: uuidv7(),
            type: 'shared_folder',
            title: folder.name || 'Shared Folder',
            text: folder.access_type ? `Access: ${folder.access_type}` : null,
            external_id: folder.shared_folder_id,
            source_url: folder.preview_url || null,
            source_data: folder,
            user: {
              id: userId,
            },
          };

          contentItems.push(sharedContent);
        }
      }

      syncResults.push({ api: 'Dropbox Shared Folders', data: sharedData });
    } catch (error) {
      const errorMsg = `Dropbox Shared Folders API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(errorMsg);
    }

    // Dropbox Paper Documents
    try {
      const paperData = await this.request<DropboxPaperData>(connection, '/2/paper/docs/list', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filter_by: 'docs_accessed',
          sort_by: 'accessed',
          sort_order: 'descending',
          limit: 50,
        }),
      });

      // Process Paper documents
      if (paperData.doc_ids && Array.isArray(paperData.doc_ids)) {
        for (const docId of paperData.doc_ids) {
          const paperContent: DropboxContentDto = {
            id: uuidv7(),
            type: 'paper_document',
            title: `Paper Document ${docId}`,
            external_id: docId,
            source_url: `https://paper.dropbox.com/doc/${docId}`,
            source_data: { doc_id: docId },
            user: {
              id: userId,
            },
          };

          contentItems.push(paperContent);
        }
      }

      syncResults.push({ api: 'Dropbox Paper', data: paperData });
    } catch (error) {
      const errorMsg = `Dropbox Paper API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(errorMsg);
    }

    // Store all content items in the database
    if (contentItems.length > 0) {
      try {
        this.logger.log(`Creating ${contentItems.length} content items in database`);

        // Create all content items at once
        await contentService.create({ userId } as RequestContext, contentItems as CreateContentDto[]);

        this.logger.log(`Successfully created ${contentItems.length} content items`);
      } catch (error) {
        const errorMsg = `Failed to store content items: ${error instanceof Error ? error.message : 'Unknown error'}`;
        errors.push(errorMsg);
        this.logger.error('Content storage failed', { error: errorMsg, itemCount: contentItems.length });
      }
    }

    return {
      success: errors.length === 0,
      message: `Sync completed. ${syncResults.length} APIs processed successfully. ${contentItems.length} content items created. ${errors.length} errors occurred.`,
      data: {
        results: syncResults,
        errors,
      },
    };
  }

  // Helper methods added as instance methods
  private determineContentType(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _fileData: DropboxFileEntry,
  ): string {
    // This will be overridden in sync method
    return 'file';
  }

  private determineMimeType(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _fileData: DropboxFileEntry,
  ): string | null {
    // This will be overridden in sync method
    return null;
  }
}
