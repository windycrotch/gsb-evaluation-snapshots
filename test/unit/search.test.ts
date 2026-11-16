import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FILMS } from '../../src/discover/catalog.js';
import {
  MAX_QUERY_CHARS,
  MAX_QUERY_TOKENS,
  clip,
  queryTokens,
  resolveFilm,
  scoreFilm,
  searchFilms,
} from '../../src/discover/search.js';

const ids = (q: string) => searchFilms(q).map(f => f.id);

describe('searchFilms', () => {
  it('ranks an exact title first, for every film', () => {
    for (const f of FILMS) {
      assert.equal(searchFilms(f.title)[0]?.id, f.id, f.title);
    }
  });

  it('finds films by tag, mood and genre', () => {
    for (const f of FILMS) {
      for (const tag of f.tags) {
        assert.ok(ids(tag).includes(f.id), `${f.id} not found by its tag "${tag}"`);
      }
      assert.ok(ids(f.genre).includes(f.id), `${f.id} not found by its genre`);
    }
  });

  it('matches plurals and word stems from three letters up', () => {
    assert.equal(ids('dragons')[0], 'sintel'); // tag "dragon"
    assert.equal(ids('elephant')[0], 'elephants-dream'); // title word "Elephants"
  });

  it('does not stretch a prefix into another word', () => {
    // "runner" is not "Run", "bigfoot" is not "Big", "dreamworks" is not "Dream".
    for (const q of ['blade runner', 'the running man', 'bigfoot', 'dreamworks']) {
      assert.deepEqual(ids(q), [], `"${q}" should not match anything`);
    }
  });

  it('keeps results in descending score and catalogue order on ties', () => {
    // "animated" tags ten films equally: every score is identical, so the order
    // must be the catalogue order rather than an arbitrary sort.
    const q = 'animated';
    const results = searchFilms(q);
    const expected = FILMS.filter(f => f.tags.includes('animated'));
    assert.deepEqual(
      results.map(f => f.id),
      expected.map(f => f.id),
      'ties must keep catalogue order',
    );
    const scores = results.map(f => scoreFilm(f, q).total);
    assert.ok(
      scores.every(s => s === scores[0]),
      'the tie is real, not a coincidence',
    );
    // A mixed query still comes out with non-increasing scores.
    const mixed = searchFilms('dragon robot').map(f => scoreFilm(f, 'dragon robot').total);
    assert.ok(
      mixed.every((s, i) => i === 0 || mixed[i - 1]! >= s),
      'scores must descend',
    );
  });

  it('still returns the shared-word film in search, even when the name means another title', () => {
    // resolveFilm must refuse these, but the caller falls back to a search page,
    // and searchFilms owes it the film that shares a word.
    assert.deepEqual(ids('man of steel'), ['tears-of-steel']);
    assert.deepEqual(ids('steel'), ['tears-of-steel']);
    assert.deepEqual(ids('big fish'), ['big-buck-bunny']);
  });

  it('matches a title phrase only from a word start', () => {
    assert.equal(ids('big buck')[0], 'big-buck-bunny');
    for (const q of ['ring', 'ant', 'rat', 'ear', 'tel']) {
      assert.deepEqual(ids(q), [], `"${q}" is a fragment of a title word and should not match`);
    }
  });

  it('ranks the film with a whole multi-word tag above films sharing one of its words', () => {
    assert.equal(ids('live action')[0], 'tears-of-steel');
  });

  it('is case and punctuation insensitive', () => {
    assert.deepEqual(ids('WING IT!'), ids('wing it'));
    assert.deepEqual(ids('Sci-Fi'), ids('scifi'));
  });

  it('returns nothing for blank, stopword-only, or unrelated queries', () => {
    for (const q of [
      '',
      '   ',
      'the',
      'in',
      'show me something',
      'zzqx-no-such-film',
      'the godfather',
      'in the mood for love',
      'a movie about cats',
    ]) {
      assert.deepEqual(ids(q), [], `"${q}" should not match anything`);
    }
  });

  it('does not let short words match as prefixes', () => {
    // "me" must not match "memories", "an" must not match "animated".
    assert.equal(
      scoreFilm(
        FILMS.find(f => f.id === 'coffee-run')!,
        'me',
      ).total,
      0,
    );
    assert.equal(
      scoreFilm(
        FILMS.find(f => f.id === 'sintel')!,
        'an',
      ).total,
      0,
    );
  });

  it('bounds the work per query: text is clipped at a word boundary, words are deduplicated and capped', () => {
    const huge = 'dragon '.repeat(200_000);
    assert.ok(clip(huge).length <= MAX_QUERY_CHARS);
    assert.ok(clip(huge).endsWith('dragon'), 'clipped mid-word');
    assert.equal(clip('a'.repeat(MAX_QUERY_CHARS + 50)).length, MAX_QUERY_CHARS, 'one long word is cut hard');
    assert.equal(queryTokens(huge).length, 1);
    const many = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ');
    assert.equal(queryTokens(many).length, MAX_QUERY_TOKENS);
  });
});

describe('resolveFilm', () => {
  it('resolves ids and natural phrasings to the right film', () => {
    assert.equal(resolveFilm('big-buck-bunny')?.id, 'big-buck-bunny');
    assert.equal(resolveFilm('the bunny one')?.id, 'big-buck-bunny');
    assert.equal(resolveFilm('the elephant one')?.id, 'elephants-dream');
    assert.equal(resolveFilm('show me something with an elephant')?.id, 'elephants-dream');
    assert.equal(resolveFilm('the dragon film')?.id, 'sintel');
  });

  it('misses instead of guessing when nothing really matches', () => {
    for (const q of ['the godfather', 'a movie about cats', 'in the mood for love', 'the', 'zzqx-no-such-film']) {
      assert.equal(resolveFilm(q), undefined, `"${q}" should not resolve`);
    }
  });

  it('misses on other films that share a word with one in the catalogue', () => {
    for (const q of [
      'blade runner', // Coffee Run
      'big fish', // Big Buck Bunny
      'the big lebowski',
      'man of steel', // Tears of Steel
      'tears of the sun',
      'spring breakers', // Spring
      'dog day afternoon', // Spring's tag "dog"
      'space jam', // Wing It!'s tag "space"
      'agents of shield', // Agent 327
      'sintel with subtitles', // a word the catalogue cannot confirm
    ]) {
      assert.equal(resolveFilm(q), undefined, `"${q}" resolved to ${resolveFilm(q)?.id}`);
    }
  });

  it('misses on a tie rather than pick by catalogue order', () => {
    assert.equal(resolveFilm('animated'), undefined); // nearly every film carries the tag
  });

  it('misses the exact shared-word names named in the brief', () => {
    for (const q of ['blade runner', 'man of steel']) {
      assert.equal(resolveFilm(q), undefined, `"${q}" must not resolve`);
    }
  });

  it('never resolves on a logline-only hit, even when every word matches', () => {
    // "caffeine" appears only in Coffee Run's logline: search finds the film, but
    // a logline hit is not strong enough to resolve a name.
    assert.deepEqual(ids('caffeine'), ['coffee-run']);
    assert.equal(resolveFilm('caffeine'), undefined);
  });

  it('only resolves when every meaningful word lands on the same film', () => {
    // "sintel with subtitles": "sintel" is a title hit, "subtitles" confirms nothing.
    assert.equal(resolveFilm('sintel with subtitles'), undefined);
    // Whereas dropping the unconfirmable word resolves.
    assert.equal(resolveFilm('sintel')?.id, 'sintel');
  });

  it('resolves an exact id but leaves an unknown id to the query fallback', () => {
    assert.equal(resolveFilm('tears-of-steel')?.id, 'tears-of-steel');
    assert.equal(resolveFilm('not-a-real-id'), undefined);
  });
});
