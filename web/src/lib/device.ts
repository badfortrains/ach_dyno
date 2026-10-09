import { deviceAddress, parseMessage, type DeviceMessage } from './model';
export type ConnectionState =
  'disconnected' | 'connecting' | 'connected' | 'reconnecting';
interface Callbacks {
  state: (state: ConnectionState, detail: string) => void;
  message: (message: DeviceMessage) => void;
  interrupted: (reason: string) => void;
}
export class DeviceConnection {
  private ws: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private wanted = false;
  private attempt = 0;
  private lastMessage = 0;
  private address = '';
  private generation = 0;
  private pending = new Map<
    string,
    {
      resolve: (message: string) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(private callbacks: Callbacks) {}
  connect(input: string) {
    const address = deviceAddress(input);
    this.disconnect();
    this.address = address.ws;
    this.wanted = true;
    this.callbacks.state('connecting', 'Requesting local device access…');
    const generation = this.generation;
    // A plain HTTP status fetch triggers Chrome's Local Network Access prompt in versions
    // that gate fetch but don't yet gate WebSockets. Failure still allows a socket attempt.
    void fetch(address.status, {
      signal: AbortSignal.timeout(5000),
      cache: 'no-store',
    })
      .catch(() => undefined)
      .finally(() => {
        if (generation === this.generation && this.wanted) this.open();
      });
  }
  private open() {
    if (!this.wanted) return;
    this.callbacks.state(
      this.attempt ? 'reconnecting' : 'connecting',
      this.attempt ? 'Connection lost. Retrying…' : 'Opening local WebSocket…',
    );
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.address);
    } catch (error) {
      this.callbacks.state(
        'disconnected',
        `Browser blocked this connection: ${String(error)}. Check Chrome local network permission.`,
      );
      this.wanted = false;
      return;
    }
    this.ws = ws;
    this.timeout = setTimeout(() => ws.close(), 8000);
    ws.onopen = () => {
      clearTimeout(this.timeout);
      this.attempt = 0;
      this.lastMessage = Date.now();
      this.callbacks.state('connected', 'Connected to local dynamometer');
      ws.send(JSON.stringify({ type: 'status' }));
      this.watchdog = setInterval(() => {
        if (Date.now() - this.lastMessage > 6000) ws.close();
      }, 1000);
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      const message = parseMessage(event.data);
      if (!message) {
        this.callbacks.interrupted('Invalid device message');
        this.callbacks.state(
          'connected',
          'Device sent an unsupported message. Check firmware protocol 1.',
        );
        return;
      }
      this.lastMessage = Date.now();
      if (message.type === 'ack') {
        const pending = this.pending.get(message.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          if (message.ok) pending.resolve(message.message);
          else pending.reject(new Error(message.message));
        }
      }
      this.callbacks.message(message);
    };
    ws.onerror = () => {
      /* onclose owns retry and run recovery */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      clearInterval(this.watchdog);
      clearTimeout(this.timeout);
      this.ws = null;
      this.rejectPending();
      this.callbacks.interrupted('Device connection lost');
      if (this.wanted) {
        this.callbacks.state(
          'reconnecting',
          'Check power, same Wi-Fi, Chrome local network permission, and device origin allowlist. Try its IP if .local fails.',
        );
        const delay = Math.min(30_000, 1000 * 2 ** this.attempt++);
        this.retry = setTimeout(() => this.open(), delay);
      }
    };
  }
  command(type: 'tare' | 'calibrate', massKg?: number): Promise<string> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('Connect to the dynamometer first.'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error('Sensor command timed out. Check status before retrying.'),
        );
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(
        JSON.stringify({
          type,
          id,
          ...(massKg === undefined ? {} : { massKg }),
        }),
      );
    });
  }
  private rejectPending() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Connection lost during sensor command.'));
    }
    this.pending.clear();
  }
  disconnect() {
    this.generation++;
    this.wanted = false;
    clearTimeout(this.retry);
    clearTimeout(this.timeout);
    clearInterval(this.watchdog);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.onopen = null;
      ws.close();
    }
    this.rejectPending();
    this.callbacks.state('disconnected', 'Ready to connect');
  }
}
