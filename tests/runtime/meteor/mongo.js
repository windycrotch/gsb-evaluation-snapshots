// Mongo.Collection facade for the harness, backed by the real mingo
// MongoDB query/update engine (selectors, $set/$inc modifiers) and
// implementing Meteor's observeChanges protocol (added/changed/removed)
// that the player's write-back chain relies on.

import { Query, update as applyUpdate } from 'mingo'
import _ from 'lodash'
import { wireClone } from '../ejson.js'

const { isEqual } = _

let counter = 0
const genId = () => `h${(++counter).toString(36)}${Math.random().toString(36).slice(2, 10)}`

const normalize = selector => {
  if (selector === undefined || selector === null) return {}
  if (typeof selector === 'string') return { _id: selector }
  return selector
}

class Cursor {
  constructor(collection, selector, options) {
    this._collection = collection
    this._selector = selector
    this._options = options || {}
  }
  fetch() { return this._collection._fetch(this._selector, this._options) }
  count() { return this.fetch().length }
  forEach(fn) { this.fetch().forEach(fn) }
  map(fn) { return this.fetch().map(fn) }
  observeChanges(callbacks) { return this._collection._observe(this._selector, callbacks) }
}

export class Collection {
  constructor(name) {
    this._name = name
    this._docs = new Map()
    this._observers = new Set()
  }

  _fetch(selector, options = {}) {
    const query = new Query(normalize(selector))
    let docs = [...this._docs.values()].filter(d => query.test(d))
    if (options.sort) {
      const [field, dir] = Object.entries(options.sort)[0]
      docs = docs.sort((a, b) => (a[field] > b[field] ? 1 : a[field] < b[field] ? -1 : 0) * dir)
    }
    return docs.map(d => wireClone(d))
  }

  find(selector, options) { return new Cursor(this, selector, options) }

  findOne(selector, options) { return this._fetch(selector, options)[0] }

  insert(doc) {
    doc = wireClone(doc)
    if (!doc._id) doc._id = genId()
    this._docs.set(doc._id, doc)
    this._notify()
    return doc._id
  }

  update(selector, modifier, options = {}) {
    const query = new Query(normalize(selector))
    let n = 0
    for (const doc of this._docs.values()) {
      if (!query.test(doc)) continue
      // Meteor/Mongo allow $set with an unchanged _id; mingo rejects it outright
      let effective = modifier
      if (modifier.$set && '_id' in modifier.$set && isEqual(modifier.$set._id, doc._id)) {
        effective = { ...modifier, $set: { ...modifier.$set } }
        delete effective.$set._id
      }
      // mingo>=6.7 accepts only one operator per call; Mongo combines them
      for (const [op, spec] of Object.entries(effective)) applyUpdate(doc, { [op]: spec })
      n++
      if (typeof selector === 'string') break
    }
    if (n) this._notify()
    return n
  }

  remove(selector) {
    const query = new Query(normalize(selector))
    let n = 0
    for (const [id, doc] of [...this._docs]) {
      if (query.test(doc)) { this._docs.delete(id); n++ }
    }
    if (n) this._notify()
    return n
  }

  _observe(selector, callbacks) {
    const observer = { query: new Query(normalize(selector)), callbacks, last: new Map() }
    for (const doc of this._docs.values()) {
      if (observer.query.test(doc)) {
        observer.last.set(doc._id, wireClone(doc))
        if (callbacks.added) callbacks.added(doc._id, wireClone(doc))
      }
    }
    this._observers.add(observer)
    return { stop: () => this._observers.delete(observer) }
  }

  _notify() {
    for (const observer of this._observers) {
      const now = new Map()
      for (const doc of this._docs.values()) {
        if (observer.query.test(doc)) now.set(doc._id, doc)
      }
      for (const [id, doc] of now) {
        const prev = observer.last.get(id)
        if (!prev) {
          if (observer.callbacks.added) observer.callbacks.added(id, wireClone(doc))
        } else if (!isEqual(prev, doc)) {
          const fields = {}
          for (const key of new Set([...Object.keys(prev), ...Object.keys(doc)])) {
            if (!isEqual(prev[key], doc[key])) fields[key] = wireClone(doc[key])
          }
          if (observer.callbacks.changed) observer.callbacks.changed(id, fields)
        }
      }
      for (const id of observer.last.keys()) {
        if (!now.has(id) && observer.callbacks.removed) observer.callbacks.removed(id)
      }
      observer.last = new Map([...now].map(([id, d]) => [id, wireClone(d)]))
    }
  }
}

export const Mongo = { Collection }
export default Mongo
