/**
 * A small client for OBS's built-in remote control (obs-websocket 5, OBS 28 and newer).
 * Only what this module needs: connect, log in with the password, send requests.
 */

import { obsAuthentication } from './sha256';

/** The parts of the browser WebSocket this client uses, so tests can pass Node's. */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}
export type SocketFactory = (url: string) => SocketLike;

export interface ObsConnection {
  host: string;
  port: number;
  password: string;
}

interface Pending {
  resolve(data: Record<string, unknown>): void;
  reject(error: Error): void;
}

const OPEN = 1;
const TIMEOUT_MS = 5000;

/** Turns OBS's close codes into something a GM can act on. */
export function describeClose(code: number | undefined, reason: string | undefined): string {
  if (code === 4009) return 'OBS rejected the password. Check it in the module settings (OBS: Tools > WebSocket Server Settings > Show Connect Info).';
  if (code === 4008) return 'OBS wants a password. Enter it in the module settings (OBS: Tools > WebSocket Server Settings > Show Connect Info).';
  if (reason) return `OBS closed the connection: ${reason}`;
  return 'Could not reach OBS. Is OBS running, and is Tools > WebSocket Server Settings > Enable WebSocket server ticked?';
}

export class ObsError extends Error {}

export class ObsClient {
  private socket: SocketLike | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly makeSocket: SocketFactory) {}

  get connected(): boolean {
    return this.socket?.readyState === OPEN && this.ready !== null;
  }

  /** Connects and logs in, or reuses the open connection. */
  connect(connection: ObsConnection): Promise<void> {
    // Reuse a connection that is open or still opening, so two quick clicks share one login.
    if (this.ready && this.socket && this.socket.readyState <= OPEN) return this.ready;
    this.disconnect();
    const url = `ws://${connection.host}:${String(connection.port)}`;
    const ready = new Promise<void>((resolve, reject) => {
      let socket: SocketLike;
      try {
        socket = this.makeSocket(url);
      } catch (error) {
        reject(new ObsError(`Could not open ${url}: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      this.socket = socket;
      let identified = false;
      const timer = setTimeout(() => {
        if (identified) return;
        reject(new ObsError(describeClose(undefined, undefined)));
        socket.close();
      }, TIMEOUT_MS);

      socket.onmessage = (event): void => {
        let message: { op?: number; d?: Record<string, unknown> };
        try {
          message = JSON.parse(String(event.data)) as typeof message;
        } catch {
          return;
        }
        const d = message.d ?? {};
        if (message.op === 0) {
          const auth = d['authentication'] as { challenge?: string; salt?: string } | undefined;
          const identify = async (): Promise<void> => {
            const data: Record<string, unknown> = { rpcVersion: 1, eventSubscriptions: 0 };
            if (auth?.challenge && auth.salt) data['authentication'] = await obsAuthentication(connection.password, auth.salt, auth.challenge);
            socket.send(JSON.stringify({ op: 1, d: data }));
          };
          identify().catch((error: unknown) => {
            reject(new ObsError(`Could not answer OBS's password check: ${error instanceof Error ? error.message : String(error)}`));
            socket.close();
          });
        } else if (message.op === 2) {
          identified = true;
          clearTimeout(timer);
          resolve();
        } else if (message.op === 7) {
          const id = String(d['requestId']);
          const waiting = this.pending.get(id);
          if (!waiting) return;
          this.pending.delete(id);
          const status = d['requestStatus'] as { result?: boolean; code?: number; comment?: string } | undefined;
          if (status?.result) waiting.resolve((d['responseData'] as Record<string, unknown> | undefined) ?? {});
          else waiting.reject(new ObsError(status?.comment ?? `OBS refused ${String(d['requestType'])} (code ${String(status?.code)})`));
        }
      };
      socket.onclose = (event): void => {
        clearTimeout(timer);
        const error = new ObsError(describeClose(event.code, event.reason));
        if (!identified) reject(error);
        for (const waiting of this.pending.values()) waiting.reject(error);
        this.pending.clear();
        if (this.socket === socket) {
          this.socket = null;
          this.ready = null;
        }
      };
      socket.onerror = (): void => {
        // onclose follows with the details.
      };
    });
    this.ready = ready;
    ready.catch(() => {
      if (this.ready === ready) this.ready = null;
    });
    return ready;
  }

  /** Sends one request and waits for OBS's answer. */
  request(requestType: string, requestData: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return Promise.reject(new ObsError(describeClose(undefined, undefined)));
    const requestId = `npc-cam-${String(this.nextId++)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new ObsError(`OBS did not answer ${requestType} in time.`));
      }, TIMEOUT_MS);
      this.pending.set(requestId, {
        resolve: (data): void => {
          clearTimeout(timer);
          resolve(data);
        },
        reject: (error): void => {
          clearTimeout(timer);
          reject(error);
        }
      });
      socket.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    });
  }

  disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    this.ready = null;
    if (socket) {
      socket.onclose?.({ code: 1000, reason: 'closed by Foundry' });
      socket.onclose = null;
      socket.close();
    }
  }
}
