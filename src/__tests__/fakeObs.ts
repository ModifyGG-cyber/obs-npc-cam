// A stand-in for OBS's WebSocket server (obs-websocket 5 protocol), enough for these tests.
import { createHash } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { SocketFactory, SocketLike } from '../obsClient';

const b64sha = (text: string): string => createHash('sha256').update(text).digest('base64');

export interface FakeInput {
  kind: string;
  settings: Record<string, unknown>;
}

export class FakeObs {
  readonly scenes = new Map<string, string[]>([['Camera', ['Webcam']]]);
  readonly inputs = new Map<string, FakeInput>([['Webcam', { kind: 'dshow_input', settings: {} }]]);
  program = 'Camera';
  readonly log: string[] = [];
  private server: WebSocketServer;
  port = 0;

  constructor(private readonly password = '') {
    this.server = new WebSocketServer({ port: 0 });
  }

  async start(): Promise<void> {
    await new Promise<void>(resolve => this.server.once('listening', () => resolve()));
    this.port = (this.server.address() as { port: number }).port;
    this.server.on('connection', socket => this.serve(socket));
  }

  stop(): Promise<void> {
    for (const client of this.server.clients) client.terminate();
    return new Promise(resolve => this.server.close(() => resolve()));
  }

  private serve(socket: WebSocket): void {
    const salt = 'saltysalt';
    const challenge = 'challenge123';
    const hello: Record<string, unknown> = { obsWebSocketVersion: '5.5.0', rpcVersion: 1 };
    if (this.password) hello['authentication'] = { salt, challenge };
    socket.send(JSON.stringify({ op: 0, d: hello }));
    let identified = false;
    socket.on('message', raw => {
      const message = JSON.parse(String(raw)) as { op: number; d: Record<string, unknown> };
      if (message.op === 1) {
        if (this.password) {
          const expected = b64sha(b64sha(this.password + salt) + challenge);
          if (message.d['authentication'] !== expected) {
            socket.close(4009, 'Authentication failed.');
            return;
          }
        }
        identified = true;
        socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        return;
      }
      if (message.op !== 6 || !identified) return;
      const { requestType, requestId, requestData } = message.d as { requestType: string; requestId: string; requestData: Record<string, unknown> };
      this.log.push(requestType);
      let responseData: Record<string, unknown> = {};
      let error: string | null = null;
      try {
        responseData = this.handle(requestType, requestData);
      } catch (e) {
        error = (e as Error).message;
      }
      socket.send(JSON.stringify({
        op: 7,
        d: { requestType, requestId, requestStatus: error ? { result: false, code: 600, comment: error } : { result: true, code: 100 }, responseData }
      }));
    });
  }

  private handle(type: string, data: Record<string, unknown>): Record<string, unknown> {
    const name = (key: string): string => String(data[key]);
    switch (type) {
      case 'GetSceneList':
        return { currentProgramSceneName: this.program, scenes: [...this.scenes.keys()].map(sceneName => ({ sceneName })) };
      case 'CreateScene':
        if (this.scenes.has(name('sceneName'))) throw new Error('scene exists');
        this.scenes.set(name('sceneName'), []);
        return {};
      case 'GetVideoSettings':
        return { baseWidth: 1280, baseHeight: 720 };
      case 'GetInputSettings': {
        const input = this.inputs.get(name('inputName'));
        if (!input) throw new Error('No source was found by the name of `' + name('inputName') + '`.');
        return { inputKind: input.kind, inputSettings: input.settings };
      }
      case 'CreateInput': {
        const scene = this.scenes.get(name('sceneName'));
        if (!scene) throw new Error('no scene');
        this.inputs.set(name('inputName'), { kind: name('inputKind'), settings: data['inputSettings'] as Record<string, unknown> });
        scene.push(name('inputName'));
        return { sceneItemId: 1 };
      }
      case 'GetSceneItemId': {
        if (!this.scenes.get(name('sceneName'))?.includes(name('sourceName'))) throw new Error('no item');
        return { sceneItemId: 1 };
      }
      case 'CreateSceneItem':
        this.scenes.get(name('sceneName'))?.push(name('sourceName'));
        return { sceneItemId: 2 };
      case 'SetInputSettings': {
        const input = this.inputs.get(name('inputName'));
        if (!input) throw new Error('no input');
        input.settings = { ...input.settings, ...(data['inputSettings'] as Record<string, unknown>) };
        return {};
      }
      case 'SetCurrentProgramScene':
        if (!this.scenes.has(name('sceneName'))) throw new Error('No scene was found by the name of `' + name('sceneName') + '`.');
        this.program = name('sceneName');
        return {};
      default:
        throw new Error('unknown request ' + type);
    }
  }
}

export const nodeSockets: SocketFactory = url => new WebSocket(url) as unknown as SocketLike;
