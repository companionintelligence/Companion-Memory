import { Injectable } from '@nestjs/common';

@Injectable()
export class ContentSearchIndexListener {
  constructor() {}

  private getSearchContent(): string[] {
    return [];
  }

  private getSearchDocument(): string | null {
    // const parts = new Set<string>();
    // const push = (value: unknown) => {
    //   if (typeof value !== 'string') {
    //     return;
    //   }

    //   const normalized = value.trim();
    //   if (normalized.length === 0) {
    //     return;
    //   }

    //   parts.add(normalized);
    // };

    // push(contentDto.title ?? null);
    // push((contentDto as { text?: string }).text ?? null);
    // push(contentDto.mimetype ?? null);
    // push(contentDto.url ?? null);

    // if (parts.size === 0) {
    //   return null;
    // }

    // return Array.from(parts).join(' ');

    return null;
  }
}
