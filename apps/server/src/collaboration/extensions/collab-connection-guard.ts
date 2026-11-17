import { Connection, OutgoingMessage } from '@hocuspocus/server';
import { Forbidden } from '@hocuspocus/common';

export type CollabAccess = 'none' | 'read' | 'write';

export class CollabConnectionGuard {
  private readonly outbound: Uint8Array[] = [];
  private outboundBytes = 0;
  private sending = false;
  private stopped = false;
  private inboundMessages = 0;
  private inboundBytes = 0;
  private readonly send: Connection['send'];
  private readonly maxMessages = 256;
  // Match ws' existing frame ceiling instead of introducing a smaller document limit.
  private readonly maxBytes = 100 * 1024 * 1024;
  private announcedAccess: CollabAccess;

  constructor(
    private readonly connection: Connection,
    private readonly access: () => Promise<CollabAccess>,
  ) {
    this.announcedAccess = connection.readOnly ? 'read' : 'write';
    this.send = connection.send.bind(connection);
    const close = connection.close.bind(connection);
    connection.close = (event) => {
      if (this.stopped) return;
      this.stopped = true;
      this.outbound.length = 0;
      this.outboundBytes = 0;
      connection.readOnly = true;
      close(event);
      // The original close routes its control frame through the now-disabled send.
      this.send(
        new OutgoingMessage(connection.messageAddress)
          .writeCloseMessage(event?.reason ?? Forbidden.reason)
          .toUint8Array(),
      );
    };
    connection.send = (message) => {
      if (this.stopped) return;
      if (
        this.outbound.length >= this.maxMessages ||
        this.outboundBytes + message.byteLength > this.maxBytes
      ) {
        connection.close(Forbidden);
        return;
      }
      this.outbound.push(message.slice());
      this.outboundBytes += message.byteLength;
      if (!this.sending) void this.drain();
    };
    const handle = connection.handleMessage.bind(connection);
    const pending = connection.waitForPendingMessages.bind(connection);
    connection.handleMessage = (message) => {
      if (this.stopped) return;
      if (
        this.inboundMessages >= this.maxMessages ||
        this.inboundBytes + message.byteLength > this.maxBytes
      ) {
        connection.close(Forbidden);
        return;
      }
      this.inboundMessages++;
      this.inboundBytes += message.byteLength;
      handle(message);
      void pending().then(
        () => {
          this.inboundMessages--;
          this.inboundBytes -= message.byteLength;
        },
        () => connection.close(Forbidden),
      );
    };
  }

  async authorize(): Promise<CollabAccess> {
    if (this.stopped) throw Forbidden;
    let timeout: ReturnType<typeof setTimeout>;
    try {
      const access = await Promise.race([
        this.access(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(Forbidden), 5000);
        }),
      ]);
      if (
        this.stopped ||
        !this.connection.document.hasConnection(this.connection)
      ) {
        throw Forbidden;
      }
      if (access === 'none') {
        this.send(
          new OutgoingMessage(this.connection.messageAddress)
            .writeStateless(
              JSON.stringify({ type: 'page.permissions', access }),
            )
            .toUint8Array(),
        );
        throw Forbidden;
      }
      if (access === 'read') this.connection.readOnly = true;
      if (access !== this.announcedAccess) {
        this.announcedAccess = access;
        this.send(
          new OutgoingMessage(this.connection.messageAddress)
            .writeStateless(
              JSON.stringify({ type: 'page.permissions', access }),
            )
            .toUint8Array(),
        );
      }
      return access;
    } catch {
      this.connection.close(Forbidden);
      throw Forbidden;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async drain(): Promise<void> {
    this.sending = true;
    try {
      while (this.outbound.length && !this.stopped) {
        await this.authorize();
        if (this.stopped) return;
        const message = this.outbound.shift();
        this.outboundBytes -= message.byteLength;
        this.send(message);
      }
    } catch {
      this.connection.close(Forbidden);
    } finally {
      this.sending = false;
    }
  }
}
