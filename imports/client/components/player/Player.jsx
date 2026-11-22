import { withTracker } from 'meteor/react-meteor-data';
import { Meteor } from 'meteor/meteor'

import React from 'react';

import Tone from 'tone';
import teoria from 'teoria'
import _ from 'lodash'

import styled from 'styled-components';

import { updateSound, removeSound } from './sounds';
import { soundsWatcher } from './soundsWatcher';
import { observeTones } from './tones';
import { resetSoundLifecycle, killPlayerTasks, markSoundApplied } from './lifecycle';

export default class Player extends React.Component {

  constructor(props){
    super(props)
    this.state = {
      codeErrors: false
    }
  }

  componentDidMount () {
    // clean all the meteor collection replication of the window.tones object
    Meteor.call('tones.removeAll')

    // fresh lifecycle state (versions, tombstones) for this player session
    resetSoundLifecycle()

    Tone.Transport.start('+0.1')
    Tone.Transport.loopEnd = '2m'
    Tone.Transport.loop = true
    window.Tone = Tone

    Tone.context.latencyHint = "interactive"

    // keep the observe handle so it can be stopped on unmount
    this.tonesObserver = observeTones()
  }

  // initializeSounds
  componentWillReceiveProps(nextProps) {
    let a =[this.props.sounds, nextProps.sounds]

    soundsWatcher({
      array1: nextProps.sounds,
      array2: this.props.sounds,
      added: s => {
        updateSound(s)
      },
      updated: (s, p) => {
        let result = updateSound(s)
        result.status === 'err' ? this.setState({codeErrors: result.body}) : this.setState({codeErrors: false})
      },
      deleted: s => {
        removeSound(s)
      },
      // no audible change (e.g. only the save version moved): still note the
      // newest version seen so a stale snapshot arriving later is recognized
      nothing: (s, p) => markSoundApplied(s)
    })
  }

  componentWillUnmount () {
    // stop listening to mixer write-backs
    if (this.tonesObserver) {
      this.tonesObserver.stop()
      this.tonesObserver = null
    }
    // invalidate and drop every scheduled start/stop/cleanup task so
    // nothing fires after the player is gone
    killPlayerTasks()
    Tone.Transport.cancel(0)
    Tone.Transport.stop()
  }

	render() {
    let errors = this.state.codeErrors ? this.state.codeErrors : 'no synthax error'

		return (
      <div>
        <Result error={this.state.codeErrors}> {errors} </Result>
      </div>

    )
  }
}

const Result = styled.p`
  color: ${props => props.error ? 'red' : 'green'};
`;
