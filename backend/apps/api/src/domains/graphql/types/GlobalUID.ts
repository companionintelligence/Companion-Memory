type ResourceType = 'fact' | 'file' | 'item' | 'message' | 'person' | 'tag' | 'thread' | 'user';

export class GlobalUID {
  static encode(type: ResourceType, id: string): string {
    return Buffer.from(`${type}:${id}`).toString('base64');
  }

  static decode(globalId: string): { type: string; id: string } {
    let decoded;

    try {
      decoded = Buffer.from(globalId, 'base64').toString('utf-8');
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
