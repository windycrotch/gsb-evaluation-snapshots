import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import roomReducer, { me, userAdd, userRemove, userReady } from '@client/store/room';

describe('room reducer reconnection idempotency', () => {
    test('a re-sent user:me does not duplicate a member that was never removed', () => {
        let state = roomReducer(undefined, me(7));
        state = roomReducer(state, userAdd(8));

        assert.equal(state.me, 7);
        assert.deepEqual(state.users.map(user => user.id), [ 7, 8 ]);

        // Simulate reconnection: server re-sends user:me and user:add without a prior user:remove.
        state = roomReducer(state, me(7));
        state = roomReducer(state, userAdd(7));

        assert.equal(state.me, 7);
        assert.deepEqual(state.users.map(user => user.id), [ 7, 8 ], 'the member list has no duplicate');
    });

    test('user:add is idempotent across reconnects while user:remove still drops the member', () => {
        let state = roomReducer(undefined, userAdd(3));
        state = roomReducer(state, userAdd(3));
        assert.deepEqual(state.users.map(user => user.id), [ 3 ]);

        state = roomReducer(state, userReady({ id: 3, ready: true }));
        assert.equal(state.users[0].ready, true);

        state = roomReducer(state, userRemove(3));
        assert.deepEqual(state.users, []);
    });
});
