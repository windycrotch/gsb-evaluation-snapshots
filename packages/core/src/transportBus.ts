import { Transport, TransportEvent, TransportLike } from './transport';
import { WorkletTransport, TransportTick } from './transportWorklet';

export type TransportBusEvent = TransportEvent | 'tick';

export interface TransportBusTick {
  time: number;
  beat: number;
  bpm: number;
  running: boolean;
}

type TransportBusListener = (payload: TransportBusTick | TransportLike) => void;

export class TransportBus {
  private readonly transport: TransportLike;
  private listeners = new Map<TransportBusEvent, Set<TransportBusListener>>();
  private unsubscribeTransport: (() => void) | null = null;
  private unsubscribeTick: (() => void) | null = null;
  private disposed = false;

  constructor(transport: TransportLike) {
    this.transport = transport;
    this.bindTransport(transport);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  on(event: TransportBusEvent, listener: TransportBusListener): () => void {
    if (this.disposed) {
      // A disposed bus is inert: subscribing after teardown must never fire.
      return () => {};
    }
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return () => this.off(event, listener);
  }

  off(event: TransportBusEvent, listener: TransportBusListener): void {
    const set = this.listeners.get(event);
    if (!set) {
      return;
    }
    set.delete(listener);
    if (set.size === 0) {
      this.listeners.delete(event);
    }
  }

  emitTick(time = this.transport.currentTime): void {
    if (this.disposed) {
      return;
    }
    const transport = this.transport;
    const beat = transport.getBeatAtTime(time);
    const bpm = 'bpm' in transport ? (transport as Transport).bpm : 120;
    this.emit('tick', { time, beat, bpm, running: transport.isPlaying });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.unsubscribeTransport) {
      this.unsubscribeTransport();
      this.unsubscribeTransport = null;
    }
    if (this.unsubscribeTick) {
      this.unsubscribeTick();
      this.unsubscribeTick = null;
    }
    this.listeners.clear();
  }

  private bindTransport(transport: TransportLike): void {
    if ('on' in transport) {
      const on = (transport as Transport).on.bind(transport);
      const offStart = on('start', () => this.emit('start', transport));
      const offStop = on('stop', () => this.emit('stop', transport));
      const offTempo = on('tempo', () => this.emit('tempo', transport));
      const offSeek = on('seek', () => this.emit('seek', transport));
      this.unsubscribeTransport = () => {
        offStart();
        offStop();
        offTempo();
        offSeek();
      };
    }

    if ('onTick' in transport) {
      const offTick = (transport as WorkletTransport).onTick((tick: TransportTick) => {
        this.emit('tick', {
          time: tick.time,
          beat: tick.beat,
          bpm: tick.bpm,
          running: tick.running,
        });
      });
      this.unsubscribeTick = offTick;
    }
  }

  private emit(event: TransportBusEvent, payload: TransportBusTick | TransportLike): void {
    if (this.disposed) {
      return;
    }
    const set = this.listeners.get(event);
    if (!set) {
      return;
    }
    // Iterate over a snapshot: listeners may unsubscribe during dispatch.
    Array.from(set).forEach((listener) => {
      if (this.disposed) {
        return;
      }
      if (this.listeners.get(event)?.has(listener)) {
        listener(payload);
      }
    });
  }
}
