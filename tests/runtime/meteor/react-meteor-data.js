// meteor/react-meteor-data for the harness: a functional withTracker built
// on the runtime Tracker, matching the atmosphere package's behavior.

import React from 'react'
import { Tracker } from './tracker.js'

export const withTracker = getMeteorData => Component => {
  return class WithTracker extends React.Component {
    constructor(props) {
      super(props)
      this.state = { data: {} }
    }
    componentDidMount() {
      this.computation = Tracker.autorun(() => {
        this.setState({ data: getMeteorData(this.props) })
      })
    }
    componentWillUnmount() {
      if (this.computation) this.computation.stop()
    }
    render() {
      return React.createElement(Component, Object.assign({}, this.props, this.state.data))
    }
  }
}

export const createContainer = withTracker
export const ReactMeteorData = {}
export default { withTracker, createContainer }
