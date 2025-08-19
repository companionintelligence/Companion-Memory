import { type Channel } from './types';

export class FrameEncoder {
  private readonly encoder = new TextEncoder();

  encodeFrame(channel: Channel, text: string, flags: number = 0): Uint8Array {
    const body = this.encoder.encode(text);
    const out = new Uint8Array(1 + 4 + body.length);

    // Partition 1-byte header into 2 channel bits and 6 flag bits
    out[0] = ((channel & 0b11) << 6) | (flags & 0b0011_1111);

    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

    view.setUint32(1, body.length, false); // big-endian
    out.set(body, 5);

    return out;
  }
}
