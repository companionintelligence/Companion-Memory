import { type Decoded } from './types';

export class FrameDecoder {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Decoded[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length);

    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);

    this.buffer = merged;

    const out: Decoded[] = [];

    while (this.buffer.length >= 5) {
      const header = this.buffer[0];
      const channel = (header >> 6) & 0b11;
      const flags = header & 0b0011_1111;

      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
      const len = view.getUint32(1, false);
      const frameSize = 5 + len;

      if (this.buffer.length < frameSize) {
        break; // wait for more
      }

      const payload = this.buffer.slice(5, 5 + len);

      out.push({ channel, flags, payload });

      this.buffer = this.buffer.slice(frameSize);
    }

    return out;
  }

  hasBufferedData(): boolean {
    return this.buffer.length > 0;
  }
}
