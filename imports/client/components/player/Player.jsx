import { withTracker } from 'meteor/react-meteor-data';
import { Meteor } from 'meteor/meteor'

import React from 'react';

import Tone from 'tone';
import teoria from 'teoria'
import _ from 'lodash'

import styled from 'styled-components';

import { updateSound, removeSound, getSoundErrors } from './sounds';
import { soundsWatcher } from './soundsWatcher';
import { observeTones } from './tones';

export default class Player extends React.Component {

  constructor(props){
    super(props)
    this.state = {
      codeErrors: {}
    }
  }

  componentDidMount () {
    // clean all the meteor collection replication of the window.tones object
    Meteor.call('tones.removeAll')

    Tone.Transport.start('+0.1')
    Tone.Transport.loopEnd = '2m'
    Tone.Transport.loop = true
    window.Tone = Tone
    window.teoria = teoria

    Tone.context.latencyHint = "interactive"

    observeTones()
  }

  refreshCodeErrors = () => this.setState({ codeErrors: getSoundErrors() })

  // initializeSounds
  componentWillReceiveProps(nextProps) {
    let a =[this.props.sounds, nextProps.sounds]

    soundsWatcher({
      array1: nextProps.sounds,
      array2: this.props.sounds,
      added: s => {
        updateSound(s)
        this.refreshCodeErrors()
      },
      updated: (s, p) => {
        updateSound(s)
        this.refreshCodeErrors()
      },
      deleted: s => {
        removeSound(s)
        this.refreshCodeErrors()
      },
      nothing: (s, p) => console.log('nothing', p)
    })
  }

  componentWillUnmount () {
    Tone.Transport.stop()
  }

	render() {
    let errors = this.state.codeErrors || {}
    let errorIds = Object.keys(errors)

		return (
      <div>
        {errorIds.length === 0
          ? <Result error={false}>no synthax error</Result>
          : errorIds.map(id =>
              <Result key={id} error={true}>
                {`${errors[id].name || id} => ${errors[id].message}`}
              </Result>
            )
        }
      </div>

    )
  }
}

const Result = styled.p`
  color: ${props => props.error ? 'red' : 'green'};
`;
