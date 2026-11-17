import {
  Connection,
  Document,
  Hocuspocus,
  MessageType,
} from '@hocuspocus/server';
import { AuthMessageType } from '@hocuspocus/common';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';
import { setTimeout as delay } from 'node:timers/promises';
import { AuthenticationExtension } from './authentication.extension';

const user = { id: 'user', workspaceId: 'workspace' };
const page = { id: 'page', workspaceId: 'workspace', spaceId: 'space' };
const name = 'page.page';

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  expect(predicate()).toBe(true);
}

function frame(
  type: number,
  write: (encoder: encoding.Encoder) => void = () => {},
) {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, name);
  encoding.writeVarUint(encoder, type);
  write(encoder);
  return encoding.toUint8Array(encoder);
}

function fixture() {
  const users = { findById: jest.fn(async () => user) };
  const pages = { findById: jest.fn(async () => page) };
  const members = {
    getUserSpaceRoles: jest.fn(async () => [{ role: 'writer' }]),
  };
  const permissions = {
    canUserEditPage: jest.fn(async () => ({
      hasAnyRestriction: false,
      canAccess: true,
      canEdit: true,
    })),
  };
  const subscriber = {
    on: jest.fn(),
    subscribe: jest.fn(),
    disconnect: jest.fn(),
  };
  const spaces = {
    findById: jest.fn(async () => ({ workspaceId: user.workspaceId })),
  };
  const extension = new AuthenticationExtension(
    {
      verifyJwt: jest.fn(async () => ({
        sub: user.id,
        workspaceId: user.workspaceId,
      })),
    } as any,
    users as any,
    pages as any,
    members as any,
    permissions as any,
    { getOrThrow: () => ({ duplicate: () => subscriber }) } as any,
    spaces as any,
    {
      transaction: () => ({
        setIsolationLevel: () => ({
          execute: (callback) => callback({ isTransaction: true }),
        }),
      }),
    } as any,
  );
  const socket = { readyState: 1, send: jest.fn(), close: jest.fn() };
  const types = () =>
    socket.send.mock.calls.map(([bytes]) => {
      const decoder = decoding.createDecoder(bytes);
      decoding.readVarString(decoder);
      const type = decoding.readVarUint(decoder);
      if (type === MessageType.Stateless) {
        const payload = decoding.readVarString(decoder);
        if (
          ['none', 'read', 'write'].some(
            (access) =>
              payload === JSON.stringify({ type: 'page.permissions', access }),
          )
        ) {
          return 'permissions';
        }
      }
      return type;
    });
  return {
    extension,
    users,
    pages,
    members,
    permissions,
    socket,
    types,
    subscriber,
    spaces,
  };
}

describe('AuthenticationExtension with real Hocuspocus transport', () => {
  const documents: Document[] = [];
  afterEach(() => {
    for (const document of documents.splice(0)) document.destroy();
  });

  async function open(f = fixture()) {
    const document = new Document(name);
    documents.push(document);
    await f.extension.onLoadDocument({ document, documentName: name } as any);
    const connection = new Connection(
      f.socket,
      new Request('http://localhost'),
      document,
      'socket',
      { user },
    );
    connection.beforeHandleMessage((conn) =>
      f.extension.beforeHandleMessage({ connection: conn } as any),
    );
    return { ...f, document, connection };
  }

  it('guards initial awareness before the constructor can send it', async () => {
    const f = fixture();
    const document = new Document(name);
    documents.push(document);
    document.awareness.setLocalState({ private: 'awareness' });
    let release: (value: typeof user) => void;
    const pending = new Promise<typeof user>((resolve) => {
      release = resolve;
    });
    f.users.findById.mockReturnValueOnce(pending);
    await f.extension.onLoadDocument({ document, documentName: name } as any);
    new Connection(
      f.socket,
      new Request('http://localhost'),
      document,
      'socket',
      { user },
    );
    expect(f.socket.send).not.toHaveBeenCalled();
    f.members.getUserSpaceRoles.mockResolvedValue([]);
    release(user);
    await until(() => document.getConnectionsCount() === 0);
    expect(f.types()).not.toContain(MessageType.Awareness);
  });

  it('checks idle outbound recipients without a Redis notification', async () => {
    const f = await open();
    f.document.broadcastStateless('allowed');
    await until(() => f.types().includes(MessageType.Stateless));
    f.socket.send.mockClear();
    f.members.getUserSpaceRoles.mockResolvedValue([]);
    f.document.broadcastStateless('private-after-revocation');
    await until(() => !f.document.hasConnection(f.connection));
    expect(f.types()).not.toContain(MessageType.Stateless);
    expect(f.types()).toContain('permissions');
  });

  it('rechecks every queued outbound frame instead of using the first allow', async () => {
    const f = await open();
    f.users.findById.mockImplementation(async () => {
      f.members.getUserSpaceRoles.mockResolvedValue(
        f.users.findById.mock.calls.length > 1 ? [] : [{ role: 'writer' }],
      );
      return user;
    });
    f.document.broadcastStateless('first');
    f.document.broadcastStateless('second-private');
    await until(() => !f.document.hasConnection(f.connection));
    expect(
      f.types().filter((type) => type === MessageType.Stateless),
    ).toHaveLength(1);
  });

  it('closes on a database failure without sending a queued content frame', async () => {
    const f = await open();
    f.users.findById.mockRejectedValue(new Error('synthetic-database-failure'));
    f.document.broadcastStateless('private');
    await until(() => !f.document.hasConnection(f.connection));
    expect(f.types()).not.toContain(MessageType.Stateless);
  });

  it('bounds pending outbound traffic during a slow authorization check', async () => {
    const f = await open();
    let release: (value: typeof user) => void;
    f.users.findById.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    for (let i = 0; i < 257; i++) f.connection.send(new Uint8Array(1));
    expect(f.document.hasConnection(f.connection)).toBe(false);
    release(user);
    await delay(10);
    expect(f.socket.send.mock.calls.every(([bytes]) => bytes.length > 1)).toBe(
      true,
    );
  });

  it('preserves frames above one MiB within the existing WebSocket ceiling', async () => {
    const f = await open();
    f.connection.send(new Uint8Array(2 * 1024 * 1024));
    await until(() =>
      f.socket.send.mock.calls.some(
        ([bytes]) => bytes.byteLength === 2 * 1024 * 1024,
      ),
    );
    expect(f.document.hasConnection(f.connection)).toBe(true);
  });

  it('closes when a database authorization check exceeds its deadline', async () => {
    const f = await open();
    jest.useFakeTimers();
    try {
      f.users.findById.mockReturnValue(new Promise(() => {}));
      f.connection.sendStateless('private');
      await jest.advanceTimersByTimeAsync(5000);
      expect(f.document.hasConnection(f.connection)).toBe(false);
      expect(f.types()).not.toContain(MessageType.Stateless);
    } finally {
      jest.useRealTimers();
    }
  });

  it('bounds authenticated inbound traffic while authorization is stalled', async () => {
    const f = await open();
    let release: (value: typeof user) => void;
    f.users.findById.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    try {
      for (let i = 0; i < 257; i++)
        f.connection.handleMessage(frame(MessageType.QueryAwareness));
      expect(f.document.hasConnection(f.connection)).toBe(false);
      release(user);
      await f.connection.waitForPendingMessages();
      expect(f.types()).not.toContain(MessageType.Awareness);
    } finally {
      release(user);
      consoleError.mockRestore();
    }
  });

  it('refreshes read-only state before an inbound Yjs update is applied', async () => {
    const f = await open();
    f.members.getUserSpaceRoles.mockResolvedValue([{ role: 'reader' }]);
    const client = new Y.Doc();
    client.getText('content').insert(0, 'denied');
    f.connection.handleMessage(
      frame(MessageType.Sync, (encoder) => {
        encoding.writeVarUint(encoder, 2);
        encoding.writeVarUint8Array(encoder, Y.encodeStateAsUpdate(client));
      }),
    );
    await f.connection.waitForPendingMessages();
    expect(f.document.getText('content').toString()).toBe('');
    expect(f.connection.readOnly).toBe(true);
    client.destroy();
  });

  it('restores a writer only for a freshly authorized inbound message', async () => {
    const f = await open();
    f.members.getUserSpaceRoles.mockResolvedValue([{ role: 'reader' }]);
    f.connection.handleMessage(frame(MessageType.QueryAwareness));
    await f.connection.waitForPendingMessages();
    expect(f.connection.readOnly).toBe(true);
    f.members.getUserSpaceRoles.mockResolvedValue([{ role: 'writer' }]);
    f.connection.sendStateless('readable');
    await until(() => f.types().includes(MessageType.Stateless));
    expect(f.connection.readOnly).toBe(true);
    const client = new Y.Doc();
    client.getText('content').insert(0, 'restored');
    f.connection.handleMessage(
      frame(MessageType.Sync, (encoder) => {
        encoding.writeVarUint(encoder, 2);
        encoding.writeVarUint8Array(encoder, Y.encodeStateAsUpdate(client));
      }),
    );
    await f.connection.waitForPendingMessages();
    expect(f.connection.readOnly).toBe(false);
    expect(f.document.getText('content').toString()).toBe('restored');
    client.destroy();
  });

  it('uses the guard for frames queued during actual authentication and load', async () => {
    const f = fixture();
    let release: () => void;
    let loading = false;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const instance = new Hocuspocus({
      extensions: [
        f.extension,
        {
          async onLoadDocument({ document }) {
            documents.push(document);
            document.awareness.setLocalState({ private: 'initial-awareness' });
            loading = true;
            await hold;
          },
        },
      ],
      unloadImmediately: false,
    });
    const client = instance.handleConnection(
      f.socket,
      new Request('http://localhost'),
    );
    try {
      client.handleMessage(
        frame(MessageType.Auth, (encoder) => {
          encoding.writeVarUint(encoder, AuthMessageType.Token);
          encoding.writeVarString(encoder, 'test-token');
        }),
      );
      await until(() => loading);
      const update = new Y.Doc();
      update.getText('content').insert(0, 'denied');
      client.handleMessage(
        frame(MessageType.Sync, (encoder) => {
          encoding.writeVarUint(encoder, 2);
          encoding.writeVarUint8Array(encoder, Y.encodeStateAsUpdate(update));
        }),
      );
      update.destroy();
      f.members.getUserSpaceRoles.mockResolvedValue([]);
      release();
      await until(() => f.types().includes(MessageType.CLOSE));
      expect(f.types()).not.toContain(MessageType.Awareness);
      expect(documents[0].getText('content').toString()).toBe('');
    } finally {
      release();
      client.handleClose();
      await instance.hooks('onDestroy', { instance });
    }
  });
});
