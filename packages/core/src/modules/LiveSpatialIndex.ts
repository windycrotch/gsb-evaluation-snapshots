import type { ItemKey, ReadonlyItemCollection } from "./ItemCollection";
import { SpatialIndex, type SpatialIndexToken, type SpatialItem } from "./SpatialIndex";

/**
 * Coordination layer keeping a {@link SpatialIndex} in sync with a live
 * {@link ReadonlyItemCollection}. The constructor indexes the collection's
 * current items; from then on every committed collection change is mirrored
 * into the index synchronously, so bounding-box queries always reflect the
 * latest geometry in the collection's draw (paint) order.
 *
 * Consistency guarantees come from the collection's own semantics: only
 * successfully applied changes are published, so rejected mutations
 * (duplicate keys, unknown keys, key-changing updates) never reach the
 * index. Batched mutations arrive as one merged change list at the end of
 * the outermost batch, so the index is refreshed exactly once per batch.
 * If another subscriber throws, the collection still delivers to every
 * listener before rethrowing, so the index reflects all applied changes
 * even when the mutating call surfaces an error.
 *
 * `destroy()` detaches the subscription. It is idempotent; afterwards
 * collection mutations no longer touch the index, which keeps answering
 * queries against its last synchronized state.
 */
export class LiveSpatialIndex<T extends SpatialItem> {
    private readonly index: SpatialIndex<T>;
    private readonly tokens = new Map<ItemKey, SpatialIndexToken<T>>();
    private unsubscribe: (() => void) | undefined;

    constructor(collection: ReadonlyItemCollection<T>, index?: SpatialIndex<T>) {
        this.index = index ?? new SpatialIndex<T>();
        const tokens = this.index.load(collection.items);
        for (let i = 0; i < tokens.length; i++) {
            // keyAt mirrors the loaded array position for position.
            this.tokens.set(collection.keyAt(i)!, tokens[i]);
        }
        this.unsubscribe = collection.subscribe((changes) => {
            for (const change of changes) {
                if (change.type === "insert") {
                    this.tokens.set(change.key, this.index.insert(change.item));
                    continue;
                }
                const token = this.tokens.get(change.key);
                if (token === undefined) {
                    continue;
                }
                if (change.type === "update") {
                    // The token keeps its registration order; only the
                    // bounding box and item move to the new geometry.
                    this.index.update(token, change.item);
                } else {
                    this.index.remove(token);
                    this.tokens.delete(change.key);
                }
            }
        });
    }

    /** Number of indexed entries; tracks the collection's size while attached. */
    get size(): number {
        return this.tokens.size;
    }

    /** All items whose bounds intersect the rectangle, in collection draw order. */
    query(minX: number, minY: number, maxX: number, maxY: number): T[] {
        return this.index.query(minX, minY, maxX, maxY);
    }

    /**
     * Stop synchronizing. Idempotent: later collection mutations leave the
     * index untouched and nothing is dispatched to this subscription.
     */
    destroy(): void {
        const unsubscribe = this.unsubscribe;
        if (!unsubscribe) {
            return;
        }
        this.unsubscribe = undefined;
        unsubscribe();
    }
}
