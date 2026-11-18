import User from '@server/room/User';
import Video from '@server/room/Video';
import TimedEvent from '@server/core/TimedEvent';

/**
 * Delay (in ms) during which a disconnected user is kept around
 * waiting for a reconnection before being removed for good.
 */
export const DEFAULT_RECONNECTION_DELAY = 5000;

const EMPTY_DELAY = 5000;

export default class Room {
    constructor(id, onEmpty, reconnectionDelay = DEFAULT_RECONNECTION_DELAY) {
        this.id = id;
        this.onEmpty = onEmpty;
        this.reconnectionDelay = reconnectionDelay;
        this.users = new Map();
        // Disconnected users waiting for reconnection, keyed by their stable identity token
        this.pending = new Map();
        this.emptyResolver = new TimedEvent(this.checkEmpty.bind(this), EMPTY_DELAY);
        this.video = null;

        this.addClient = this.addClient.bind(this);
        this.removeClient = this.removeClient.bind(this);
        this.onClientReady = this.onClientReady.bind(this);
        this.onClientPlay = this.onClientPlay.bind(this);
        this.onClientPause = this.onClientPause.bind(this);
        this.onClientEnd = this.onClientEnd.bind(this);
        this.onClientStop = this.onClientStop.bind(this);
        this.onClientSeek = this.onClientSeek.bind(this);
        this.onClientVideoFile = this.onClientVideoFile.bind(this);
        this.onClientVideoUrl = this.onClientVideoUrl.bind(this);
        this.onClientVideoYoutube = this.onClientVideoYoutube.bind(this);
        this.onUserReady = this.onUserReady.bind(this);
        this.onVideoPlay = this.onVideoPlay.bind(this);
        this.onVideoPause = this.onVideoPause.bind(this);
        this.onVideoSeek = this.onVideoSeek.bind(this);
        this.onVideoStop = this.onVideoStop.bind(this);
    }

    /**
     * Register a freshly connected client.
     *
     * Depending on the stable identity token it carries, it is either:
     *  - a reconnection of a pending (briefly disconnected) user,
     *  - a duplicate connection replacing a still connected socket,
     *  - a brand new user.
     *
     * @param {Client} client
     */
    addClient(client) {
        const pendingUser = this.findPending(client.token);

        if (pendingUser) {
            this.reconnectClient(client, pendingUser);

            return;
        }

        const activeUser = this.findUser(client.token);

        if (activeUser) {
            this.replaceClient(client, activeUser);

            return;
        }

        this.createUser(client);
    }

    removeClient(client) {
        // Already replaced by a duplicate connection: nothing left to do.
        if (!this.users.has(client)) {
            return;
        }

        this.detachClient(client);

        const user = this.users.get(client);

        this.users.delete(client);

        if (client.token) {
            this.scheduleReconnection(client, user);
        } else {
            // Legacy clients without a stable identity cannot reconnect.
            this.dropUser(user);
        }
    }

    createUser(client) {
        const user = new User(client.id);

        this.attachClient(client);

        this.send('user:add', user.id);
        this.sumUp(client, user);

        this.users.set(client, user);
        user.token = client.token || null;

        user.on('ready', this.onUserReady);

        if (this.video) {
            this.video.pause();
        }
    }

    /**
     * Reuse a pending user entry for a reconnected client.
     *
     * @param {Client} client
     * @param {User} user
     */
    reconnectClient(client, user) {
        const entry = this.pending.get(user.token);

        entry.resolver.clear();
        this.pending.delete(user.token);

        this.attachClient(client);
        this.users.set(client, user);

        // Restore this client's view: identity, members, video source and live progress.
        this.sumUp(client, user);

        if (this.video && this.video.playing) {
            client.send('control:play', this.video.time);
        }

        // Restore the other members' view without re-creating the user.
        this.sendToOther(client, 'user:add', user.id);
        this.sendToOther(client, 'user:ready', user);
    }

    /**
     * Invalidate a still connected socket carrying an already used identity
     * and move its user onto the new connection.
     *
     * @param {Client} client
     * @param {User} user
     */
    replaceClient(client, user) {
        const previous = this.clientOf(user);

        this.users.delete(previous);
        this.detachClient(previous);
        previous.close();

        this.attachClient(client);
        this.users.set(client, user);

        this.sumUp(client, user);

        if (this.video && this.video.playing) {
            client.send('control:play', this.video.time);
        }
    }

    /**
     * Keep a disconnected user around for the reconnection window.
     * No user:remove is broadcast and the video keeps playing.
     *
     * @param {Client} client
     * @param {User} user
     */
    scheduleReconnection(client, user) {
        const resolver = new TimedEvent(() => this.dropPending(client.token), this.reconnectionDelay);

        this.pending.set(client.token, { user, resolver });
        resolver.schedule();
    }

    /**
     * Reconnection window elapsed: finally remove the user.
     *
     * @param {String} token
     */
    dropPending(token) {
        const entry = this.pending.get(token);

        if (!entry) {
            return;
        }

        this.pending.delete(token);
        // dropUser schedules the empty-room check, which now also accounts for pending entries.
        this.dropUser(entry.user);
    }

    /**
     * Actually remove a user and broadcast the removal.
     *
     * @param {User} user
     */
    dropUser(user) {
        user.off('ready', this.onUserReady);

        this.send('user:remove', user.id);

        if (this.video) {
            this.video.pause();
        }

        this.emptyResolver.schedule();
    }

    sumUp(client, user) {
        client.send('user:me', user.id);

        this.users.forEach(member => {
            client.send('user:add', member.id);
            client.send('user:ready', member);
        });

        if (this.video) {
            const { source, url, name } = this.video;

            client.send(`video:${source}`, { url, name });
            // Always resync from the server-side current time, never from 0.
            client.send('control:seek', this.video.time);
        }
    }

    onClientReady(data, client) {
        this.users.get(client).setReady(data.ready);
    }

    onClientPlay(time) {
        if (!this.video) { return; }

        this.video.play(time);
    }

    onClientPause(time) {
        if (!this.video) { return; }

        this.video.pause(time);
    }

    onClientEnd() {
        if (!this.video) { return; }

        this.video.end();
    }

    onClientStop() {
        if (!this.video) { return; }

        this.video.stop();
    }

    onClientSeek(time) {
        if (!this.video) { return; }

        this.video.seek(time);
    }

    onClientVideoFile(data, client) {
        this.setVideo(new Video('file', null, data.name), client);
    }

    onClientVideoUrl(data, client) {
        this.setVideo(new Video('url', data.url, data.name), client);
    }

    onClientVideoYoutube(data, client) {
        this.setVideo(new Video('youtube', data.url, data.name), client);
    }

    unloadVideo() {
        if (this.video) {
            this.video.off('play', this.onVideoPlay);
            this.video.off('pause', this.onVideoPause);
            this.video.off('seek', this.onVideoSeek);
            this.video.off('stop', this.onVideoStop);
        }
    }

    setVideo(video, client) {
        this.unloadVideo();

        video.on('play', this.onVideoPlay);
        video.on('pause', this.onVideoPause);
        video.on('seek', this.onVideoSeek);
        video.on('stop', this.onVideoStop);

        const { source, url, name } = video;

        this.sendToOther(client, `video:${source}`, { url, name });

        this.video = video;

        console.info('Loaded video:', source, url, name);
    }

    onUserReady(event) {
        const user = event.detail;

        this.send('user:ready', user);

        if (!user.ready && this.video) {
            this.video.pause();
        }
    }

    onVideoPlay() {
        this.send('control:play', this.video.time);
    }

    onVideoPause() {
        this.send('control:pause', this.video.time);
    }

    onVideoSeek() {
        this.send('control:seek', this.video.time);
    }

    onVideoStop() {
        this.send('control:stop');
    }

    /**
     * Find a disconnected user waiting for reconnection.
     *
     * @param {String} token
     *
     * @return {User|null}
     */
    findPending(token) {
        const entry = this.pending.get(token);

        return entry ? entry.user : null;
    }

    /**
     * Find a connected user by its stable identity token.
     *
     * @param {String} token
     *
     * @return {User|null}
     */
    findUser(token) {
        if (!token) {
            return null;
        }

        for (const user of this.users.values()) {
            if (user.token === token) {
                return user;
            }
        }

        return null;
    }

    /**
     * Find the client currently bound to a user.
     *
     * @param {User} target
     *
     * @return {Client|null}
     */
    clientOf(target) {
        for (const [ client, user ] of this.users) {
            if (user === target) {
                return client;
            }
        }

        return null;
    }

    attachClient(client) {
        client.on('close', this.removeClient);
        client.on('user:ready', this.onClientReady);
        client.on('control:play', this.onClientPlay);
        client.on('control:pause', this.onClientPause);
        client.on('control:end', this.onClientEnd);
        client.on('control:stop', this.onClientStop);
        client.on('control:seek', this.onClientSeek);
        client.on('video:file', this.onClientVideoFile);
        client.on('video:url', this.onClientVideoUrl);
        client.on('video:youtube', this.onClientVideoYoutube);
    }

    detachClient(client) {
        client.off('close', this.removeClient);
        client.off('user:ready', this.onClientReady);
        client.off('control:play', this.onClientPlay);
        client.off('control:pause', this.onClientPause);
        client.off('control:end', this.onClientEnd);
        client.off('control:stop', this.onClientStop);
        client.off('control:seek', this.onClientSeek);
        client.off('video:file', this.onClientVideoFile);
        client.off('video:url', this.onClientVideoUrl);
        client.off('video:youtube', this.onClientVideoYoutube);
    }

    /**
     * Send data to all clients
     *
     * @param {String} name
     * @param {Object} data
     */
    send(name, data = undefined) {
        this.users.forEach((user, client) => client.send(name, data));
    }

    /**
     * Send data to all other clients
     *
     * @param {User|Client} target
     * @param {String} name
     * @param {Object} data
     */
    sendToOther(target, name, data = undefined) {
        this.users.forEach((user, client) => {
            if (user !== target && target !== client) {
                client.send(name, data);
            }
        });
    }

    /**
     * Check if room is empty
     */
    checkEmpty() {
        if (this.users.size === 0 && this.pending.size === 0) {
            this.onEmpty(this);
        }
    }

    /**
     * Destroy room
     */
    destroy() {
        this.unloadVideo();
        this.emptyResolver.clear();
        this.pending.forEach(entry => entry.resolver.clear());
        this.pending.clear();
        this.users.clear();
        this.onEmpty = null;
        this.video = null;
    }
}
