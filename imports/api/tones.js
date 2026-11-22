import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';

import {each} from 'lodash';

import { Sounds } from './sounds';

export const Tones = new Mongo.Collection('tones');

if (Meteor.isServer) {

Meteor.publish('tones', () => Tones.find())

Meteor.methods({
  'tones.insert'(tone) {
    // never persist a record for a sound that no longer exists
    if (!tone || !Sounds.findOne(tone.soundId)) return false;
    Tones.insert(tone);
  },

  'tones.removeFromSoundId'(soundId) {
    Tones.remove({soundId: soundId});
  },

  'tones.removeAll'() {
    Tones.remove({});
  },

  'tones.update'(tone) {
    // parameter write-back for a deleted sound: drop any residual record
    // instead of updating or recreating it
    if (!tone || !Sounds.findOne(tone.soundId)) {
      if (tone) Tones.remove({soundId: tone.soundId});
      return false;
    }
    // the record was removed with the sound: an update must not recreate it
    if (!Tones.findOne(tone._id)) return false;
    Tones.update(tone._id, { $set: tone })
  }
});
}
