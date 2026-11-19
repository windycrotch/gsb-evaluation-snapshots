import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';

import {each} from 'lodash';

export const Tones = new Mongo.Collection('tones');

if (!Meteor.isServer) return false

Meteor.publish('tones', () => Tones.find())

Meteor.methods({
  'tones.insert'(tone) {
    Tones.insert(tone);
  },

  // One persisted record per sound track: re-evaluating code replaces the
  // previous record instead of stacking duplicates.
  'tones.upsert'(tone) {
    Tones.upsert(
      { soundId: tone.soundId },
      { $set: tone }
    );
  },

  'tones.removeFromSoundId'(soundId) {
    Tones.remove({soundId: soundId});
  },

  'tones.removeAll'() {
    Tones.remove({});
  },

  'tones.update'(tone) {
    Tones.update(tone._id, { $set: tone })
  }
});
