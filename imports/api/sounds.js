import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { check } from 'meteor/check';
import {random, each, filter} from 'lodash';

import {Songs} from './songs';

export const Sounds = new Mongo.Collection('sounds');

if (Meteor.isServer) {

Meteor.publish('sounds', () => Sounds.find())

Meteor.methods({
  'sounds.insert'(code) {

    check(code, String);

    Sounds.insert({
      'name': `sound-${random(10000)}`,
      'tags': ``,
      'selected': false,
      'muted': false,
      'code': code,
      'version': 0,
      'createdAt': new Date(),
      'updatedAt': new Date()
    });
  },
  'sounds.remove'(soundId) {
    check(soundId, String);

    Sounds.remove(soundId);

    // Clean orphan sounds id in songs
    Meteor.call('songs.cleanSoundsSongs')
  },
  'sounds.clone'(soundId) {
    check(soundId, String);
    let sound = Sounds.findOne(soundId)
    Sounds.insert({
      'name': `${sound.name}-clone`,
      'tags': sound.tags,
      'selected': sound.selected,
      'muted': sound.muted,
      'code': sound.code,
      'version': 0,
      'createdAt': new Date(),
      'updatedAt': new Date()
    });
  },
  //
  // UPDATERS
  //
  'sounds.select'(soundId) {
    check(soundId, String);

    Sounds.update({ selected: true }, { $set: { selected: false } })
    Sounds.update(soundId, { $set: { selected: true } })
  },
  'sounds.toggleMute'(soundId) {
    check(soundId, String);
    let sound = Sounds.findOne(soundId)
    // bump a version so every player can tell the order of mute operations
    Sounds.update(soundId, { $set: { muted: !sound.muted, updatedAt: new Date() }, $inc: { version: 1 } })
  },
  'sounds.updateCode'(soundId, code) {
    check(soundId, String);
    // bump a version so a stale save (rapid saves, other window) never
    // overwrites a newer result on the players
    Sounds.update(soundId, { $set: { code: code, updatedAt: new Date() }, $inc: { version: 1 } })
  },
  'sounds.updateName'(soundId, name) {
    check(soundId, String);
    Sounds.update(soundId, { $set: { name: name } })
  },
  'sounds.updateTags'(soundId, tags) {
    check(soundId, String);
    Sounds.update(soundId, { $set: { tags: tags } })
  }
});
}
