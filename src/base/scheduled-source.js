import React from 'react';
import RAudioNode from './audio-node.js';

/**
 * Any RAudioNode that can be scheduled to start/end is a RScheduledSource
 *
 * Web Audio source nodes (oscillators, buffer sources, constant sources) are
 * single-use: once they finish playing the browser disconnects them from the
 * graph and they can never be started again. This class keeps the React-level
 * node and the underlying Web Audio node in sync across the whole lifecycle.
 *
 * @class      RScheduledSource (name)
 */
export default class RScheduledSource extends RAudioNode {
  constructor(props) {
    super(props);
    // the source has everything it needs (e.g. a buffer) to be scheduled
    this.readyToPlay = false;
    // "started": start() has already been called on the current node
    this.playbackScheduled = false;
    // stop() has already been scheduled on the current node
    this.stopScheduled = false;

    this.onEnded = this.onEnded.bind(this);
    this.schedule = this.schedule.bind(this);
  }

  /**
   * Fired by Web Audio when the underlying source node finishes playing.
   * The finished node is dead and automatically removed from the graph,
   * so we tear it down, build a fresh underlying node and reconnect every
   * destination, keeping the graph consistent for the next schedule.
   */
  onEnded() {
    const finishedNode = this.node;

    if (finishedNode && typeof finishedNode.disconnect === 'function') {
      try {
        finishedNode.disconnect();
      } catch (e) {
        console.warn(e); // eslint-disable-line no-console
      }
    }

    // force instantiateNode() to create a brand-new underlying node
    this.node = null;
    // the fresh node has neither started nor been stopped yet
    this.playbackScheduled = false;
    this.stopScheduled = false;

    // subclass hook: creates the new source node and re-registers it
    // under the same identifier in context.nodes
    if (typeof this.instantiateNode === 'function') {
      this.instantiateNode();
    }

    // re-establish every downstream connection on the new node
    this.connectToAllDestinations(this.props.destination, this.node);
  }

  /**
   * Applies the start/stop props to the underlying node.
   *
   * Two scheduling states are tracked separately:
   *   - readyToPlay/playbackScheduled distinguish "waiting to start" from "started"
   *   - stopScheduled marks a node whose stop has already been booked
   *
   * Rules:
   *   - start is only called once per underlying node (repeated prop updates
   *     or repeated schedule() calls must never start it twice)
   *   - start is skipped entirely when stop is missing no later than start
   *     (start > stop: empty window; start === stop: zero-length window)
   *   - stop is only called on a node that actually started, and only once,
   *     because stop() on a never-started node throws an InvalidStateError
   */
  schedule() {
    const hasStart = typeof this.props.start === 'number';
    const hasStop = typeof this.props.stop === 'number';

    const shouldScheduleStart =
      hasStart &&
      this.readyToPlay &&
      !this.playbackScheduled &&
      (!hasStop || this.props.start < this.props.stop);

    if (shouldScheduleStart) {
      this.node.start(this.props.start || 0, this.props.offset || 0, this.props.duration);
      this.playbackScheduled = true;
    }

    const shouldScheduleStop =
      hasStop &&
      this.playbackScheduled &&
      !this.stopScheduled;

    if (shouldScheduleStop) {
      this.node.stop(this.props.stop);
      this.stopScheduled = true;
    }
  }
  /**
  Overriding this method enables sources to specify special conditions when playback should be rescheduled.
  e.g. BufferSource should be rescheduled if a new buffer is provided
  **/
  shouldStartWithPropsChange() {
    return false;
  }

  componentDidMount() {
    super.componentDidMount();
    this.schedule();
  }

  componentDidUpdate(prevProps, prevState) {
    super.componentDidUpdate(prevProps, prevState);

    if (prevProps.start !== this.props.start ||
        prevProps.stop !== this.props.stop ||
        this.shouldStartWithPropsChange(prevProps, this.props)) {
      this.schedule();
    }
  }
}
