import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import Server from '@server/core/Server';

describe('Server connection URL parsing', () => {
    let server;

    afterEach(() => {
        if (server) {
            server.server.close();
        }
    });

    test('extracts the stable identity token from the query string', () => {
        server = new Server(0);

        assert.equal(server.parseToken('/room/?token=abc-123'), 'abc-123');
        assert.equal(server.parseToken('/room?token=abc-123'), 'abc-123');
        assert.equal(server.parseToken('/room/?other=1&token=abc'), 'abc');
    });

    test('returns null when no usable token is present', () => {
        server = new Server(0);

        assert.equal(server.parseToken('/room/'), null);
        assert.equal(server.parseToken('/room'), null);
        assert.equal(server.parseToken('/room/?token='), null);
        assert.equal(server.parseToken('/room/?other=1'), null);
    });

    test('the join matcher accepts room urls with and without a token query', () => {
        server = new Server(0);

        for (const url of [ '/room/', '/room', '/room/?token=abc', '/room?token=abc' ]) {
            assert.ok(server.joinMatcher.test(url), `${url} should be accepted`);
        }

        for (const url of [ '/', '/room/extra', '//' ]) {
            assert.equal(server.joinMatcher.test(url), false, `${url} should be rejected`);
        }
    });
});
