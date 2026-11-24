export enum Channel {
  TEXT = 0,
  THINK = 1,
  TOOL = 2,
  /**
   * An empty frame that says the turn is still going. The server sends one as soon as a viewer
   * attaches and again while the model is quiet; every client skips it. The native clients keep
   * channel 0 only, so they skip it too.
   */
  KEEPALIVE = 3,
  /**
   * The evidence snapshot for an assistant turn (retrieval status and the memory sources admitted
   * to it), as JSON: once before generation and again with the citation check at the end. The
   * header has only two channel bits, so this goes out as an extended channel (see
   * {@link Flag.EXTENDED_CHANNEL}), which a client that predates it skips like a keepalive.
   */
  GROUNDING = 4,
}

export enum Flag {
  START = 1 << 0,
  END = 1 << 1,
  /**
   * Channels above 3 do not fit the header's two channel bits. Such a frame carries channel 3
   * (KEEPALIVE, which every client skips) in those bits, this flag, and `channel - 4` in header
   * bits 2-4. Only START and END remain for its flags.
   */
  EXTENDED_CHANNEL = 1 << 5,
}
