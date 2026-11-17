import { RedisSyncExtension } from './redis-sync.extension';
import { CollabProxySocket } from './collab-proxy-socket';
import * as encoding from 'lib0/encoding';

describe('Collaboration Redis failure boundaries', () => {
  it('handles rejected publication and closes the proxy transport', async () => {
    const pub = {
      status: 'ready',
      publish: jest.fn(async () => {
        throw new Error('unavailable');
      }),
    };
    const socket = new CollabProxySocket(
      pub as any,
      JSON.stringify as any,
      'reply',
      'socket',
    );
    socket.onClose = jest.fn();
    socket.send(new Uint8Array(1));
    await Promise.resolve();
    await Promise.resolve();
    expect(socket.readyState).toBe(3);
    expect(socket.onClose).toHaveBeenCalled();
  });

  it('does not queue content while Redis is reconnecting', () => {
    const pub = { status: 'reconnecting', publish: jest.fn() };
    const socket = new CollabProxySocket(
      pub as any,
      JSON.stringify as any,
      'reply',
      'socket',
    );
    expect(() => socket.send(new Uint8Array(1))).toThrow();
    expect(pub.publish).not.toHaveBeenCalled();
    expect(socket.readyState).toBe(3);
  });

  it('closes origin routing instead of queuing unauthenticated proxy traffic offline', async () => {
    const pub = {
      status: 'reconnecting',
      publish: jest.fn(),
      on: jest.fn(),
      set: jest.fn(async () => {
        throw new Error('Redis unavailable');
      }),
    };
    const sub = { subscribe: jest.fn(), on: jest.fn() };
    const redis = {
      duplicate: jest.fn().mockReturnValueOnce(pub).mockReturnValueOnce(sub),
    };
    const client = { handleMessage: jest.fn(), handleClose: jest.fn() };
    const instance = { documents: new Map(), handleConnection: () => client };
    const sync = new RedisSyncExtension({
      redis: redis as any,
      pack: JSON.stringify as any,
      unpack: JSON.parse as any,
      serverId: 'origin',
    });
    await sync.onConfigure({ instance } as any);
    const socket = { readyState: 1, close: jest.fn(), send: jest.fn() };
    const request = {
      headers: { 'sec-websocket-key': 'socket' },
      method: 'GET',
      url: '/',
      socket: { remoteAddress: '' },
    };
    sync.onSocketOpen(socket, request);
    const encoder = encoding.createEncoder();
    encoding.writeVarString(encoder, 'page.example');
    encoding.writeVarUint(encoder, 2);
    const message = encoding.toUint8Array(encoder);
    await sync.onSocketMessage(request, message.buffer as ArrayBuffer);
    expect(socket.close).toHaveBeenCalled();
    expect(client.handleClose).toHaveBeenCalled();
    expect(pub.publish).not.toHaveBeenCalled();
    expect(pub.set).not.toHaveBeenCalled();
  });
});
