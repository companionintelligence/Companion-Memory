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
}

export enum Flag {
  START = 1 << 0,
  END = 1 << 1,
}
