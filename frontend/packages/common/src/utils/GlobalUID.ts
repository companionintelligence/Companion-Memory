type ResourceType =
  | 'action'
  | 'answer'
  | 'browser-activity'
  | 'communication'
  | 'concept'
  | 'connection'
  | 'content'
  | 'event'
  | 'fact'
  | 'file'
  | 'item'
  | 'message'
  | 'note'
  | 'person'
  | 'place'
  | 'provider'
  | 'provider-key'
  | 'question'
  | 'saved-search'
  | 'summary'
  | 'tag'
  | 'thread'
  | 'user';

export class GlobalUID {
  static encode(type: ResourceType, id: string): string {
    return btoa(`${type}:${id}`);
  }

  static decode(globalId: string): { type: string; id: string } {
    let decoded;

    try {
      decoded = atob(globalId);
    } catch {
      throw new Error('Invalid global id');
    }

    const [type, id] = decoded.split(':');

    if (!type || !id) {
      throw new Error('Invalid global id format');
    }

    return {
      type,
      id,
    };
  }

  static parse(type: ResourceType, globalId: string): string {
    const { type: decodedType, id } = this.decode(globalId);

    if (decodedType !== type) {
      throw new Error('Unexpected global id type');
    }

    return id;
  }
}
