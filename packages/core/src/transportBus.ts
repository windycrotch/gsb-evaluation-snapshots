import { Transport, TransportEvent, TransportLike } from './transport';
import { WorkletTransport, TransportTick } from './transportWorklet';

export type TransportBusEvent = TransportEvent | 'tick' | 'state';

export interface TransportBusTick {
  time: number;
  beat: number;
  bpm: number;
  running: boolean;
}

export interface TransportBusState {
  bpm: number;
  isRunning: boolean;
}

type TransportBusListener = (
  payload: TransportBusTick | TransportBusState | TransportLike
) => void;

export class TransportBus {
  private readonly transport: TransportLike;
  private listeners = new Map<TransportBusEvent, Set<TransportBusListener>>();
  private unsubscribeTransport: (() => void) | null = null;
  private unsubscribeTick: (() => void) | null = null;

  constructor(transport: TransportLike) {
    this.transport = transport;
    this.bindTransport(transport);
  }

  on(event: TransportBusEvent, listener: TransportBusListener): () => void {
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

  /**
   * Snapshot of the transport state every subscriber shares. Used both by
   * `emitTick` and by the `state` event that keeps sibling Clocks in sync.
   */
  getState(): TransportBusState {
    const transport = this.transport;
    return {
      bpm: 'bpm' in transport ? (transport as Transport).bpm : 120,
      isRunning: transport.isPlaying,
    };
  }

  emitTick(time = this.transport.currentTime): void {
    const transport = this.transport;
    const beat = transport.getBeatAtTime(time);
    const { bpm, isRunning } = this.getState();
    this.emit('tick', { time, beat, bpm, running: isRunning });
  }

  dispose(): void {
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
      // `state` is the aggregate view (tempo + running) sibling Clocks listen
      // to, so they do not need to know which property changed.
      const relayState = () => this.emit('state', this.getState());
      const offStart = on('start', () => {
        this.emit('start', transport);
        relayState();
      });
      const offStop = on('stop', () => {
        this.emit('stop', transport);
        relayState();
      });
      const offTempo = on('tempo', () => {
        this.emit('tempo', transport);
        relayState();
      });
      const offSeek = on('seek', () => {
        this.emit('seek', transport);
        relayState();
      });
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

  private emit(
    event: TransportBusEvent,
    payload: TransportBusTick | TransportBusState | TransportLike
  ): void {
    const set = this.listeners.get(event);
    if (!set) {
      return;
    }
    set.forEach((listener) => listener(payload));
  }
}
