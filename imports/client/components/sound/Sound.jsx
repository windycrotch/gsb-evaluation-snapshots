import { Meteor } from 'meteor/meteor'
import Songs from '/imports/api/songs'

import React from 'react';
import styled from 'styled-components';

import Icon from '../utils/Icon'
import { getSoundError, subscribeSoundErrors } from '../player/sounds'

import {filter} from 'lodash';

export default class Sound extends React.Component {

  constructor(props){
    super(props)
    this.state = {
      error: getSoundError(props.sound._id)
    }
  }

  componentDidMount () {
    // keep the error marker in sync with the player evaluation results
    this.unsubscribeSoundErrors = subscribeSoundErrors(() => {
      this.setState({ error: getSoundError(this.props.sound._id) })
    })
  }

  componentWillUnmount () {
    this.unsubscribeSoundErrors && this.unsubscribeSoundErrors()
  }

  removeThatSound = () => Meteor.call('sounds.remove', this.props.sound._id);
  selectThatSound = () => Meteor.call('sounds.select', this.props.sound._id);
  toggleThatSound = () => Meteor.call('sounds.toggleMute', this.props.sound._id);
  cloneThatSound = () => Meteor.call('sounds.clone', this.props.sound._id);

  addToSong = () => Meteor.call('songs.addSound', this.props.sound._id);
  removeToSong = () => Meteor.call('songs.removeSound', this.props.sound._id);

  render() {
    let buttons = null
    if (this.props.type === 'songSound') {
      buttons = ([
        <button key='1' onClick={this.toggleThatSound}>
          <Icon name={this.props.sound.muted ? 'volume-off' : 'volume-up'}/>
        </button>,
        <button key='2' onClick={this.removeToSong}>
          <Icon name="times"/>
        </button>
      ])
    } else {
      buttons = ([
        <button key='3' onClick={this.addToSong}>
          <Icon name="plus"/>
        </button>,
        <button key='4' onClick={this.removeThatSound}>
          <Icon name="trash-o"/>
        </button>
      ])
    }

    let error = this.state.error

		return (
      <OneSound onClick={this.selectThatSound} error={!!error}>
        <Name selected={this.props.sound.selected} error={!!error}> {this.props.sound.name} </Name>
        {error &&
          <ErrorMark title={error.message}>
            <Icon name="exclamation-triangle"/>
          </ErrorMark>
        }
        <Buttons>
          <button onClick={this.cloneThatSound}>
            <Icon name="clone"/>
          </button>
          {buttons}
        </Buttons>
      </OneSound>
    )
  }
}

const OneSound = styled.li`
  position: relative;
  min-height: 25px;
  border-left: ${props => props.error ? '3px solid red' : 'none'};
`;

const Name = styled.p`
display: inline-block;
height: 0px;
margin: 0px;
color: ${props => props.error ? 'red' : (props.selected ? 'blue' : 'inherit')};
`;

const ErrorMark = styled.span`
  color: red;
  margin-left: 5px;
`;

const Buttons = styled.p`
  position: absolute;
  top: 0px;
  margin: 0px;
  right: 0px;
`;
