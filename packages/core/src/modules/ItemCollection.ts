/** Stable application identity for an item in a collection. */
export type ItemKey = string | number;

/** Extract the stable key of each item. Keys must be unique within a collection. */
export interface ItemCollectionOptions<T> {
    keyOf: (item: T) => ItemKey;
}

/** A successfully applied change, with its dense index at the time of that change. */
export type ItemCollectionChange<T> =
    | { readonly type: "insert"; readonly key: ItemKey; readonly item: T; readonly index: number }
    | {
          readonly type: "update";
          readonly key: ItemKey;
          readonly item: T;
          readonly previous: T;
          readonly index: number;
      }
    | { readonly type: "remove"; readonly key: ItemKey; readonly item: T; readonly index: number };

/**
 * A delivered slice of a collection's change log. `changes` holds only entries
 * after the requested sequence, in occurrence order. `sequence` is the latest
 * delivered sequence, so it can be fed back into `changesSince` as the next
 * cursor without replaying or skipping anything.
 */
export interface ItemCollectionChanges<T> {
    readonly changes: readonly ItemCollectionChange<T>[];
    readonly sequence: number;
}

// A shared symbol also recognizes collections across copies of the core package.
// Arbitrary arrays and iterables never opt into the live-source protocol.
const ITEM_COLLECTION_BRAND: unique symbol = Symbol.for("@canvas-tile-engine/core/ItemCollection");

/**
 * Covariant, read-only view consumed by draw registrations. The array identity
 * stays stable while its contents change through the collection's mutation API.
 * Do not mutate the array or its items directly.
 */
export interface ReadonlyItemCollection<out T> {
    readonly [ITEM_COLLECTION_BRAND]: true;
    readonly items: readonly T[];
    readonly size: number;
    get(key: ItemKey): T | undefined;
    keyAt(index: number): ItemKey | undefined;
    subscribe(listener: (changes: readonly ItemCollectionChange<T>[]) => void): () => void;
    /**
     * Optional change-log reader. `ItemCollection` always implements it; a
     * source that keeps no history may omit it, so consumers should feature
     * check before replaying.
     */
    changesSince?(sequence: number): ItemCollectionChanges<T>;
}

/** A single draw item, an ordinary array, or an explicitly live collection. */
export type DrawItems<T> = T | T[] | ReadonlyItemCollection<T>;

/** Recognize the explicit collection protocol, without treating arbitrary iterables as sources. */
export function isItemCollection<T>(value: DrawItems<T>): value is ReadonlyItemCollection<T>;
export function isItemCollection(value: unknown): value is ReadonlyItemCollection<unknown>;
export function isItemCollection(value: unknown): value is ReadonlyItemCollection<unknown> {
    return (
        value !== null &&
        typeof value === "object" &&
        (value as { [ITEM_COLLECTION_BRAND]?: unknown })[ITEM_COLLECTION_BRAND] === true
    );
}

interface CollectionEntry<T> {
    item: T;
    index: number;
}

interface CollectionSubscriber<T> {
    listener: (changes: readonly ItemCollectionChange<T>[]) => void;
    active: boolean;
    subscribedAfter: number;
}

interface CollectionNotification<T> {
    changes: readonly ItemCollectionChange<T>[];
    subscribers: CollectionSubscriber<T>[];
    lastSequence: number;
}

/**
 * An ordered, keyed source for live draw items. Insertions append, updates keep
 * their position, and removals compact the same backing array. An update always
 * replaces the item with a shallow copy; nested data must also be changed
 * immutably. Mutating an item or the exposed array directly is unsupported.
 *
 * Notifications are synchronous after a mutation (or the outermost batch).
 * Reentrant mutations queue their notifications until the current listeners
 * finish. All listeners run even if one throws; the first error is rethrown
 * after delivery. Successfully applied changes are never rolled back.
 *
 * Every applied change also receives the next sequence number and is retained
 * in a change log, so a host can replay a notification batch from a cursor with
 * `changesSince`. The log is append-only for the lifetime of the collection.
 */
export class ItemCollection<T extends object> implements ReadonlyItemCollection<T> {
    readonly [ITEM_COLLECTION_BRAND] = true;
    private readonly values: T[] = [];
    private readonly keys: ItemKey[] = [];
    private readonly entries = new Map<ItemKey, CollectionEntry<T>>();
    private readonly keyOf: (item: T) => ItemKey;
    private readonly subscribers = new Set<CollectionSubscriber<T>>();
    private pendingChanges: ItemCollectionChange<T>[] = [];
    private readonly notifications: CollectionNotification<T>[] = [];
    private readonly changeLog: ItemCollectionChange<T>[] = [];
    private batchDepth = 0;
    private notifying = false;
    private lastChangeSequence = 0;

    constructor(items: readonly T[], options: ItemCollectionOptions<T>) {
        this.keyOf = options.keyOf;
        for (const item of items) {
            const key = this.readKey(item);
            if (this.entries.has(key)) {
                throw new Error(`ItemCollection: duplicate key ${String(key)}`);
            }
            this.entries.set(key, { item, index: this.values.length });
            this.values.push(item);
            this.keys.push(key);
        }
    }

    get items(): readonly T[] {
        return this.values;
    }

    get size(): number {
        return this.values.length;
    }

    get(key: ItemKey): T | undefined {
        return this.entries.get(key)?.item;
    }

    keyAt(index: number): ItemKey | undefined {
        return this.keys[index];
    }

    /** Append an item. Duplicate or invalid keys throw before the collection changes. */
    insert(item: T): void {
        const key = this.readKey(item);
        if (this.entries.has(key)) {
            throw new Error(`ItemCollection: duplicate key ${String(key)}`);
        }
        const index = this.values.length;
        this.entries.set(key, { item, index });
        this.values.push(item);
        this.keys.push(key);
        this.record({ type: "insert", key, item, index });
    }

    /**
     * Apply a shallow patch or an immutable updater, preserving order and key.
     * Unknown keys and key-changing updates throw before applying the update.
     * The updater must not mutate the previous item or its nested values.
     */
    update(key: ItemKey, change: Partial<T> | ((item: Readonly<T>) => T)): T {
        const entry = this.entries.get(key);
        if (!entry) {
            throw new Error(`ItemCollection: unknown key ${String(key)}`);
        }
        const previous = entry.item;
        const item = typeof change === "function" ? { ...change(previous) } : { ...previous, ...change };
        const nextKey = this.readKey(item);
        // Map equality intentionally accepts both NaN and the equivalent 0/-0 keys.
        if (this.entries.get(nextKey) !== entry) {
            throw new Error(`ItemCollection: update cannot change key ${String(key)} to ${String(nextKey)}`);
        }
        if (entry.item !== previous) {
            throw new Error(`ItemCollection: item ${String(key)} changed while its updater was running`);
        }
        entry.item = item;
        this.values[entry.index] = item;
        this.record({ type: "update", key: this.keys[entry.index], item, previous, index: entry.index });
        return item;
    }

    /** Remove one item and compact the array. Returns false for an unknown key. */
    remove(key: ItemKey): boolean {
        const entry = this.entries.get(key);
        if (!entry) {
            return false;
        }
        const { item, index } = entry;
        const storedKey = this.keys[index];
        this.entries.delete(key);
        this.values.splice(index, 1);
        this.keys.splice(index, 1);
        for (let i = index; i < this.keys.length; i++) {
            this.entries.get(this.keys[i])!.index = i;
        }
        this.record({ type: "remove", key: storedKey, item, index });
        return true;
    }

    /**
     * Replace every item in one update. All new keys are validated before
     * anything changes: an invalid key throws a TypeError and a repeated key
     * throws the same duplicate-key error as `insert`, leaving the collection,
     * its log, and its subscribers untouched.
     *
     * On success the backing array keeps its identity. Existing items are
     * recorded as removals from the end, then the new items are appended in
     * the supplied order, and subscribers receive one batch containing all of
     * those changes. The change log records the same entries in sequence.
     * Nested inside `batch`, everything merges into that batch's notification.
     */
    replaceAll(items: readonly T[]): void {
        const next: Array<{ key: ItemKey; item: T }> = [];
        const nextKeys = new Set<ItemKey>();
        for (const item of items) {
            const key = this.readKey(item);
            if (nextKeys.has(key)) {
                throw new Error(`ItemCollection: duplicate key ${String(key)}`);
            }
            nextKeys.add(key);
            next.push({ key, item });
        }
        this.batchDepth++;
        try {
            for (let index = this.values.length - 1; index >= 0; index--) {
                const key = this.keys[index];
                const item = this.values[index];
                this.entries.delete(key);
                this.values.pop();
                this.keys.pop();
                this.record({ type: "remove", key, item, index });
            }
            for (const { key, item } of next) {
                const index = this.values.length;
                this.entries.set(key, { item, index });
                this.values.push(item);
                this.keys.push(key);
                this.record({ type: "insert", key, item, index });
            }
        } finally {
            this.batchDepth--;
            this.flush();
        }
    }

    /**
     * Group synchronous mutations into one notification. Nested batches merge.
     * This is not a transaction: if the callback throws, successful changes
     * still notify subscribers before its error is rethrown.
     */
    batch<R>(callback: () => R): R {
        this.batchDepth++;
        let result!: R;
        let callbackError: unknown;
        let callbackThrew = false;
        try {
            result = callback();
        } catch (error) {
            callbackError = error;
            callbackThrew = true;
        } finally {
            this.batchDepth--;
        }
        try {
            this.flush();
        } catch (error) {
            if (!callbackThrew) {
                throw error;
            }
        }
        if (callbackThrew) {
            throw callbackError;
        }
        return result;
    }

    subscribe(listener: (changes: readonly ItemCollectionChange<T>[]) => void): () => void {
        const subscriber = { listener, active: true, subscribedAfter: this.lastChangeSequence };
        this.subscribers.add(subscriber);
        return () => {
            subscriber.active = false;
            this.subscribers.delete(subscriber);
        };
    }

    /**
     * Read the change log after the given sequence. Sequence 0 means "before
     * the first change"; each applied change occupies the next sequence, so
     * changes are numbered 1..N and `sequence` in the result is N.
     *
     * The returned records are the same frozen entries that were delivered to
     * subscribers, in occurrence order, and the array is frozen as well.
     * Mutating the result never changes the collection or its log. A cursor
     * newer than the log returns no changes and the current sequence, so the
     * result's `sequence` is always safe to use as the next cursor.
     *
     * A negative, fractional, NaN, or non-numeric sequence throws a TypeError
     * before reading anything.
     */
    changesSince(sequence: number): ItemCollectionChanges<T> {
        if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 0) {
            throw new TypeError("ItemCollection: sequence must be a non-negative integer");
        }
        return Object.freeze({
            changes: Object.freeze(this.changeLog.slice(sequence)),
            sequence: this.lastChangeSequence,
        });
    }

    private readKey(item: T): ItemKey {
        const key = this.keyOf(item);
        if (typeof key !== "string" && typeof key !== "number") {
            throw new TypeError("ItemCollection: keys must be strings or numbers");
        }
        return key;
    }

    private record(change: ItemCollectionChange<T>): void {
        this.lastChangeSequence++;
        const frozen = Object.freeze(change);
        // Applied changes are logged immediately, before delivery, so a host
        // replaying from a cursor sees exactly the changes that took effect,
        // including ones whose listeners throw and replaceAll entries.
        this.changeLog.push(frozen);
        this.pendingChanges.push(frozen);
        this.flush();
    }

    private flush(): void {
        if (this.batchDepth > 0 || this.pendingChanges.length === 0) {
            return;
        }
        this.notifications.push({
            changes: Object.freeze(this.pendingChanges),
            lastSequence: this.lastChangeSequence,
            // Capture subscribers when publishing, not when a queued batch is
            // delivered, so later subscribers do not replay earlier changes.
            subscribers: [...this.subscribers],
        });
        this.pendingChanges = [];
        if (this.notifying) {
            return;
        }
        this.notifying = true;
        let firstError: unknown;
        let listenerThrew = false;
        try {
            // An index avoids shifting a growing queue when listeners mutate.
            for (let i = 0; i < this.notifications.length; i++) {
                const notification = this.notifications[i];
                for (const subscriber of notification.subscribers) {
                    if (!subscriber.active) {
                        continue;
                    }
                    // A subscriber may have captured the current items halfway
                    // through an open batch. Deliver only its later changes,
                    // rather than replaying mutations already in that snapshot.
                    const offset = Math.max(
                        0,
                        subscriber.subscribedAfter - (notification.lastSequence - notification.changes.length),
                    );
                    if (offset >= notification.changes.length) {
                        continue;
                    }
                    const changes =
                        offset === 0 ? notification.changes : Object.freeze(notification.changes.slice(offset));
                    try {
                        subscriber.listener(changes);
                    } catch (error) {
                        if (!listenerThrew) {
                            firstError = error;
                            listenerThrew = true;
                        }
                    }
                }
            }
        } finally {
            this.notifications.length = 0;
            this.notifying = false;
        }
        if (listenerThrew) {
            throw firstError;
        }
    }
}
