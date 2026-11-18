import { EventEmitter } from 'node:events';

let sequence = 0;

/**
 * Minimal stand-in for a netcode server Client.
 * Records every outbound message and emits socket lifecycle events.
 */
export default class MockClient extends EventEmitter {
    constructor(token = null, id = sequence++) {
        super();

        this.id = id;
        this.token = token;
        this.sent = [];
        this.closed = false;
    }

    send(name, data = undefined) {
        this.sent.push({ name, data });
    }

    /**
     * Simulate the socket dropping.
     */
    disconnect() {
        this.emit('close', this);
    }

    close() {
        this.closed = true;
        this.emit('close', this);
    }

    /**
     * All messages with the given event name.
     */
    messages(name) {
        return this.sent.filter(message => message.name === name);
    }

    /**
     * Data payloads of the given event name.
     */
    data(name) {
        return this.messages(name).map(message => message.data);
    }

    last(name) {
        const messages = this.messages(name);

        return messages.length ? messages[messages.length - 1].data : undefined;
    }
}
