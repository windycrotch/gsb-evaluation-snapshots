import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import Room from '@server/room/Room';
import Video from '@server/room/Video';
import MockClient from './MockClient.js';

const RECONNECT_DELAY = 50;
const sleep = delay => new Promise(resolve => setTimeout(resolve, delay));

describe('Room reconnection', () => {
    let room;
    let emptied;

    beforeEach(() => {
        emptied = 0;
        room = new Room('room', () => { emptied += 1; }, RECONNECT_DELAY);
    });

    afterEach(() => {
        room.destroy();
    });

    test('reconnects within the window: reuses id and ready state, no user:remove, video keeps playing', async () => {
        const alice = new MockClient('token-alice', 1);
        const bob = new MockClient('token-bob', 2);

        room.addClient(alice);
        room.addClient(bob);
        alice.sent.length = 0;
        bob.sent.length = 0;

        // Alice is ready and a video is playing before she drops.
        room.users.get(alice).setReady(true);
        const video = new Video('url', 'http://example.test/v.mp4', 'v');
        room.setVideo(video, bob);
        video.play(10);
        alice.sent.length = 0;
        bob.sent.length = 0;

        // Brief disconnect: entry is kept, no removal broadcast, video not paused.
        alice.disconnect();

        assert.equal(room.users.size, 1, 'only the still-connected member remains active');
        assert.equal(room.pending.size, 1, 'user is held in the pending state');
        assert.deepEqual(bob.data('user:remove'), [], 'no user:remove is broadcast during the window');
        assert.equal(video.playing, true, 'the video is not paused when a user briefly disconnects');

        // Reconnect with the same stable identity.
        const aliceAgain = new MockClient('token-alice', 3);
        room.addClient(aliceAgain);

        assert.equal(room.pending.size, 0, 'pending entry is consumed on reconnection');
        assert.equal(room.users.size, 2, 'the user is active again alongside the other member');

        const restored = room.users.get(aliceAgain);
        assert.equal(restored.id, 1, 'the original user id is reused');
        assert.equal(restored.ready, true, 'the original ready state is reused');

        // The reconnected client gets its identity, the members and the video back.
        assert.equal(aliceAgain.last('user:me'), 1, 'user:me is re-sent with the original id');
        assert.deepEqual(aliceAgain.data('user:add'), [ 2, 1 ], 'existing members are re-listed');
        assert.deepEqual(aliceAgain.last('user:ready'), restored, 'ready state is re-sent');
        assert.deepEqual(aliceAgain.last('video:url'), { url: 'http://example.test/v.mp4', name: 'v' });
        const resumedAt = aliceAgain.last('control:seek');
        assert.ok(resumedAt >= 10, 'progress comes from the live video time, not 0');
        assert.ok(Math.abs(resumedAt - video.time) < 0.05, 'the seek matches the current server video time');
        assert.equal(aliceAgain.messages('control:play').length, 1, 'a playing video is resumed on reconnection');

        // Other members get their view restored without ever seeing a removal.
        assert.deepEqual(bob.data('user:remove'), [], 'other members never see user:remove');
        assert.deepEqual(bob.data('user:add'), [ 1 ], 'other members get user:add again');
        assert.equal(bob.data('user:ready').at(-1).id, 1, 'other members get user:ready again');
        assert.equal(video.playing, true, 'the video kept playing throughout');
    });

    test('window expires without reconnection: removes the user, broadcasts user:remove and pauses', async () => {
        const bob = new MockClient('token-bob', 2);
        const carol = new MockClient('token-carol', 9);
        room.addClient(bob);
        room.addClient(carol);
        carol.sent.length = 0;

        const video = new Video('url', 'http://example.test/v.mp4', 'v');
        room.setVideo(video, carol);
        video.play(5);

        bob.disconnect();
        assert.equal(room.pending.size, 1);
        assert.deepEqual(carol.data('user:remove'), [], 'no removal before the window elapses');

        await sleep(RECONNECT_DELAY + 30);

        assert.equal(room.pending.size, 0, 'the pending entry is cleaned up after the window');
        assert.equal(room.users.size, 1, 'only Carol remains connected');
        assert.deepEqual(carol.data('user:remove'), [ 2 ], 'user:remove is broadcast once the window expires');
        assert.equal(video.playing, false, 'the video is paused on the real removal');

        // A late reconnection with the same token starts a brand new user.
        const late = new MockClient('token-bob', 4);
        room.addClient(late);
        const lateUser = room.users.get(late);
        assert.notEqual(lateUser.id, 2, 'an expired identity cannot claim the old user id');
        assert.equal(lateUser.ready, false, 'the new user starts not ready');
    });

    test('duplicate identity while connected: the old connection is invalidated, no duplicate member', () => {
        const alice = new MockClient('token-alice', 1);
        const bob = new MockClient('token-bob', 2);
        room.addClient(alice);
        room.addClient(bob);
        room.users.get(alice).setReady(true);
        alice.sent.length = 0;
        bob.sent.length = 0;

        // Same stable identity opens a second socket without the first one closing.
        const aliceDuplicate = new MockClient('token-alice', 5);
        room.addClient(aliceDuplicate);

        assert.equal(room.users.size, 2, 'only two members exist: no duplicate user is created');
        assert.equal(alice.closed, true, 'the old connection is closed by the server');
        assert.ok(!room.users.has(alice), 'the old client is no longer bound to the room');

        const user = room.users.get(aliceDuplicate);
        assert.equal(user.id, 1, 'the user id is preserved on the new connection');
        assert.equal(user.ready, true, 'the ready state is preserved on the new connection');
        assert.equal(aliceDuplicate.last('user:me'), 1);
        assert.deepEqual(aliceDuplicate.data('user:add'), [ 2, 1 ], 'the new connection receives the member list');

        // Nothing is broadcast to other members: from their view the user never left.
        assert.deepEqual(bob.data('user:remove'), []);
        assert.deepEqual(bob.data('user:add'), []);

        // The stale socket closing later must not remove the surviving user.
        alice.disconnect();
        assert.equal(room.users.size, 2, 'a stale close event does not evict the new connection');
        assert.equal(room.pending.size, 0, 'no pending entry is created from the stale connection');
    });

    test('resyncs from the server current time when the video changed during the disconnection', async () => {
        const alice = new MockClient('token-alice', 1);
        const bob = new MockClient('token-bob', 2);
        room.addClient(alice);
        room.addClient(bob);

        const first = new Video('url', 'http://example.test/old.mp4', 'old');
        room.setVideo(first, bob);
        first.play(0);

        alice.disconnect();

        // While Alice is away, Bob switches to another video and seeks it forward.
        const second = new Video('url', 'http://example.test/new.mp4', 'new');
        room.setVideo(second, bob);
        second.seek(42);

        const aliceAgain = new MockClient('token-alice', 3);
        room.addClient(aliceAgain);

        assert.deepEqual(aliceAgain.last('video:url'), { url: 'http://example.test/new.mp4', name: 'new' });
        assert.equal(aliceAgain.last('control:seek'), 42, 'the seek points at the current server video time, not 0');
        assert.ok(!aliceAgain.data('video:url').some(payload => payload.url === 'http://example.test/old.mp4'));
    });

    test('destroying the room clears pending entries so their timers never fire', async () => {
        const alice = new MockClient('token-alice', 1);
        room.addClient(alice);
        alice.disconnect();

        assert.equal(room.pending.size, 1);

        room.destroy();
        await sleep(RECONNECT_DELAY + 30);

        assert.equal(room.pending.size, 0, 'pending entries are cleared with the room');
        assert.equal(emptied, 0, 'the expired timer does not fire after destruction');
    });
});
