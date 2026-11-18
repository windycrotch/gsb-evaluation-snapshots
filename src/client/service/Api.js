import EventEmitter from 'tom32i-event-emitter.js/EventEmitter.js';
import { Client, BinaryEncoder } from 'netcode/client';
import events from '@events';

/**
 * Delay before attempting to reconnect after an unexpected socket close.
 * The server keeps the user entry around for a few seconds, so a quick
 * retry reuses the same identity instead of creating a new user.
 */
const RECONNECT_DELAY = 1000;

export default class Api {
    constructor(host, protocol, identity) {
        this.host = host;
        this.protocol = protocol;
        this.identity = identity;

        // Stable emitter: survives the underlying socket being recreated,
        // so UI listeners stay attached across reconnections.
        this.emitter = new EventEmitter();
        this.client = null;
        this.room = null;
        this.leaving = false;
        this.reconnectTimer = null;

        this.play = this.play.bind(this);
        this.pause = this.pause.bind(this);
        this.onClose = this.onClose.bind(this);
    }

    addEventListener(name, callback) {
        this.emitter.on(name, callback);
    }

    removeEventListener(name, callback) {
        this.emitter.off(name, callback);
    }

    join(room) {
        if (this.room) {
            throw new Error(`Already connected to room ${this.room}`);
        }

        this.room = room;
        this.leaving = false;
        this.open();
    }

    leave() {
        this.leaving = true;
        this.cancelReconnect();

        if (this.client) {
            this.client.removeEventListener('close', this.onClose);
            this.client.close();
            this.client = null;
        }

        this.room = null;
    }

    /**
     * Create the underlying socket, carrying the stable identity token
     * so the server can restore the user on a reconnection.
     */
    open() {
        const token = this.identity.getToken();
        const client = new Client(
            `${this.protocol}//${this.host}/${this.room}/?token=${encodeURIComponent(token)}`,
            new BinaryEncoder(events)
        );

        // Forward every socket event through the stable emitter.
        this.forward(client);
        client.addEventListener('close', this.onClose);

        this.client = client;
    }

    forward(client) {
        events.forEach(([ name ]) => {
            client.addEventListener(name, event => this.emitter.emit(name, event));
        });

        [ 'open', 'error' ].forEach(name => {
            client.addEventListener(name, event => this.emitter.emit(name, event));
        });
    }

    /**
     * On an unexpected close, retry within the server reconnection window.
     */
    onClose() {
        this.emitter.emit('close');

        if (this.leaving) {
            return;
        }

        this.cancelReconnect();
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;

            if (!this.leaving && this.room) {
                this.open();
            }
        }, RECONNECT_DELAY);
    }

    cancelReconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    play(time) {
        this.client.send('control:play', time);
    }

    pause(time) {
        this.client.send('control:pause', time);
    }

    end() {
        this.client.send('control:end');
    }

    stop() {
        this.client.send('control:stop');
    }

    seek(time) {
        this.client.send('control:seek', time);
    }

    setReady(ready) {
        this.client.send('user:ready', { id: 0, ready });
    }

    loadVideo(source, name, url) {
        this.client.send(`video:${source}`, { url, name });
    }
}
