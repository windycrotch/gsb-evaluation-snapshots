// Local, offline tests for structured AI actions.
// Run with: npm test  (or: node --test test/)
//
// No real API key and no network access is required: both transport paths are
// driven through injected fakes (fetch / EventSource).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION,
  ACTION_STATUS,
  createActionGate,
  describeActionOutcome,
  getLegalTargets,
  parseActionResponse,
  requestFetchActionDecision,
  requestPostStreamActionDecision,
  requestStreamActionDecision,
  requestActionDecision,
} from '../game/ai-agent.js';

import {
  buildVotePrompt,
  buildNightMafiaPrompt,
  buildNightSheriffPrompt,
  buildNightDoctorPrompt,
} from '../game/prompts.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeState(overrides = {}) {
  const players = [
    { id: 'ai_1', name: 'Ada', role: 'mafia', alive: true },
    { id: 'ai_2', name: 'Bob', role: 'mafia', alive: true },
    { id: 'ai_3', name: 'Cleo', role: 'sheriff', alive: true },
    { id: 'ai_4', name: 'Dana', role: 'doctor', alive: true },
    { id: 'ai_5', name: 'Eli', role: 'villager', alive: true },
    { id: 'ai_6', name: 'Fay', role: 'villager', alive: false },
  ];
  return {
    players: players.map(p => ({ ...p })),
    day: 2,
    phase: 'DAY',
    chatLog: [{ name: 'Ada', text: 'Eli is acting strange.', day: 2, phase: 'DAY' }],
    gameLog: ['VOTES: Ada -> Eli'],
    investigationHistory: {},
    ...overrides,
  };
}

function byName(state, name) {
  return state.players.find(p => p.name === name);
}

class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.closed = false;
    this.onmessage = null;
    this.onerror = null;
    FakeEventSource.instances.push(this);
  }
  emit(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  token(text) { this.emit({ token: text }); }
  done() { this.emit({ done: true }); }
  fail(message = 'connection reset') { this.onerror?.(new Error(message)); }
  close() { this.closed = true; }
  static reset() { FakeEventSource.instances = []; }
  static latest() { return FakeEventSource.instances[FakeEventSource.instances.length - 1]; }
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const silent = () => {};

// ── 1. Legal target matching ────────────────────────────────────────────────

test('vote: exact legal name is matched regardless of case and padding', () => {
  const state = makeState();
  const voter = byName(state, 'Eli');

  const outcome = parseActionResponse('   cLEo  ', {
    action: ACTION.VOTE,
    actor: voter,
    players: state.players,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, ACTION_STATUS.OK);
  assert.equal(outcome.targetId, 'ai_3');
  assert.equal(outcome.targetName, 'Cleo');
});

test('vote: a sentence naming one legal player is accepted', () => {
  const state = makeState();
  const voter = byName(state, 'Dana');

  const outcome = parseActionResponse('I vote for Eli, he has been quiet.', {
    action: ACTION.VOTE,
    actor: voter,
    players: state.players,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.targetId, 'ai_5');
});

test('vote: substring names do not match (Bob is not Bobby)', () => {
  const state = makeState();
  state.players.push({ id: 'ai_7', name: 'Bobby', role: 'villager', alive: true });
  const voter = byName(state, 'Ada');

  const outcome = parseActionResponse('Bobby', {
    action: ACTION.VOTE,
    actor: voter,
    players: state.players,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.targetName, 'Bobby', 'must match the full name, not its prefix');
});

test('explicit abstain is reported as abstain, not invalid', () => {
  const state = makeState();
  const outcome = parseActionResponse('abstain', {
    action: ACTION.VOTE,
    actor: byName(state, 'Eli'),
    players: state.players,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, ACTION_STATUS.ABSTAIN);
  assert.equal(outcome.code, 'ABSTAIN_REQUESTED');
});

// ── 2. Illegal names ────────────────────────────────────────────────────────

test('vote: naming yourself is rejected with a readable reason', () => {
  const state = makeState();
  const outcome = parseActionResponse('Eli', {
    action: ACTION.VOTE,
    actor: byName(state, 'Eli'),
    players: state.players,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, ACTION_STATUS.INVALID_TARGET);
  assert.match(outcome.reason, /Eli/);
  assert.match(outcome.reason, /legal target|itself/i);
});

test('vote: a mafia member may not vote a teammate', () => {
  const state = makeState();
  const outcome = parseActionResponse('Bob', {
    action: ACTION.VOTE,
    actor: byName(state, 'Ada'),
    players: state.players,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, ACTION_STATUS.INVALID_TARGET);
  assert.match(outcome.reason, /Bob/);
});

test('vote: naming a dead player is rejected', () => {
  const state = makeState();
  const outcome = parseActionResponse('Fay', {
    action: ACTION.VOTE,
    actor: byName(state, 'Eli'),
    players: state.players,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, ACTION_STATUS.INVALID_TARGET);
  assert.match(outcome.reason, /not alive/i);
});

test('night mafia kill: self and teammates are excluded from the legal pool', () => {
  const state = makeState();
  const mafia = byName(state, 'Ada');
  const legal = getLegalTargets(ACTION.MAFIA_KILL, mafia, state.players);

  assert.deepEqual(legal.map(p => p.name).sort(), ['Cleo', 'Dana', 'Eli']);

  const outcome = parseActionResponse('Bob', {
    action: ACTION.MAFIA_KILL,
    actor: mafia,
    players: state.players.filter(p => p.alive),
  });
  assert.equal(outcome.ok, false);
});

test('knownPlayers explains rejections when only the alive pool is legal', () => {
  const state = makeState();
  const alivePool = state.players.filter(p => p.alive);

  const dead = parseActionResponse('Fay', {
    action: ACTION.VOTE,
    actor: byName(state, 'Eli'),
    players: alivePool,
    knownPlayers: state.players,
  });
  assert.equal(dead.ok, false);
  assert.match(dead.reason, /Fay/);
  assert.match(dead.reason, /not alive/i);

  const teammate = parseActionResponse('Bob', {
    action: ACTION.VOTE,
    actor: byName(state, 'Ada'),
    players: alivePool,
    knownPlayers: state.players,
  });
  assert.equal(teammate.ok, false);
  assert.match(teammate.reason, /Bob/);
  assert.match(teammate.reason, /not a legal target/i);
});

test('night sheriff: cannot investigate self, but may pick anyone else alive', () => {
  const state = makeState();
  const sheriff = byName(state, 'Cleo');

  const legal = getLegalTargets(ACTION.SHERIFF_INVESTIGATE, sheriff, state.players);
  assert.ok(!legal.some(p => p.id === sheriff.id));
  assert.ok(legal.some(p => p.id === 'ai_1'));

  const self = parseActionResponse('Cleo', {
    action: ACTION.SHERIFF_INVESTIGATE,
    actor: sheriff,
    players: state.players.filter(p => p.alive),
  });
  assert.equal(self.ok, false);
});

test('night doctor: may protect self, and self is the only legal match', () => {
  const state = makeState();
  const doctor = byName(state, 'Dana');

  const legal = getLegalTargets(ACTION.DOCTOR_PROTECT, doctor, state.players);
  assert.ok(legal.some(p => p.id === doctor.id));

  const outcome = parseActionResponse('  dana ', {
    action: ACTION.DOCTOR_PROTECT,
    actor: doctor,
    players: state.players.filter(p => p.alive),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.targetId, doctor.id);
});

test('ambiguous answers naming two legal players are rejected, not guessed', () => {
  const state = makeState();
  const outcome = parseActionResponse('Either Cleo or Eli should go.', {
    action: ACTION.VOTE,
    actor: byName(state, 'Ada'),
    players: state.players,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, ACTION_STATUS.AMBIGUOUS_TARGET);
});

test('an explicit TARGET: line outranks the surrounding discussion', () => {
  const state = makeState();
  const outcome = parseActionResponse(
    'Cleo is suspicious, but Eli is weaker.\nTARGET: Eli',
    { action: ACTION.MAFIA_KILL, actor: byName(state, 'Ada'), players: state.players }
  );

  assert.equal(outcome.ok, true);
  assert.equal(outcome.targetName, 'Eli');
});

// ── 3. Timeout & network failures (fake fetch) ──────────────────────────────

test('fetch: legal reply resolves to an executable target', async () => {
  const state = makeState();
  let seenUrl = '';
  let seenBody = null;
  const fakeFetch = async (url, init) => {
    seenUrl = url;
    seenBody = JSON.parse(init.body);
    return jsonResponse({ content: 'Eli' });
  };

  const outcome = await requestFetchActionDecision({
    action: ACTION.VOTE,
    actor: byName(state, 'Ada'),
    players: state.players.filter(p => p.alive),
    apiKey: 'test-key',
    model: 'fake/model',
    systemPrompt: 'system',
    userMessage: 'vote please',
    timeoutMs: 200,
    fetchImpl: fakeFetch,
  });

  assert.equal(seenUrl, '/api/ai-decide');
  assert.equal(seenBody.apiKey, 'test-key');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.targetId, 'ai_5');
});

test('fetch: timeout resolves with a TIMEOUT outcome instead of throwing', async () => {
  const state = makeState();
  const neverResolves = () => new Promise(() => {});

  const outcome = await requestActionDecision({
    action: ACTION.VOTE,
    actor: byName(state, 'Ada'),
    players: state.players.filter(p => p.alive),
    apiKey: 'test-key',
    model: 'fake/model',
    systemPrompt: 'system',
    userMessage: 'vote please',
    timeoutMs: 25,
    fetchImpl: neverResolves,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, ACTION_STATUS.TIMEOUT);
  assert.equal(outcome.code, 'TIMEOUT');
  assert.equal(outcome.targetId, null);
  assert.match(describeActionOutcome(outcome, {
    action: ACTION.VOTE, actorName: 'Ada', day: 2, phase: 'Day',
  }), /abstention/);
});

test('fetch: a thrown network error resolves with NETWORK_ERROR', async () => {
  const state = makeState();
  const failingFetch = async () => { throw new TypeError('Failed to fetch'); };

  const outcome = await requestFetchActionDecision({
    action: ACTION.SHERIFF_INVESTIGATE,
    actor: byName(state, 'Cleo'),
    players: state.players.filter(p => p.alive),
    apiKey: 'test-key',
    model: 'fake/model',
    systemPrompt: 'system',
    userMessage: 'investigate',
    timeoutMs: 200,
    fetchImpl: failingFetch,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, ACTION_STATUS.NETWORK_ERROR);
  assert.match(describeActionOutcome(outcome, {
    action: ACTION.SHERIFF_INVESTIGATE, actorName: 'Cleo', day: 2, phase: 'Night',
  }), /no night action/);
});

test('fetch: server-reported error is surfaced without retrying forever', async () => {
  const state = makeState();
  const fakeFetch = async () => jsonResponse({ error: 'MODEL_NOT_FOUND:fake/model', content: '' });

  const outcome = await requestFetchActionDecision({
    action: ACTION.DOCTOR_PROTECT,
    actor: byName(state, 'Dana'),
    players: state.players.filter(p => p.alive),
    apiKey: 'test-key',
    model: 'fake/model',
    systemPrompt: 'system',
    userMessage: 'protect',
    timeoutMs: 200,
    fetchImpl: fakeFetch,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, ACTION_STATUS.API_ERROR);
  assert.equal(outcome.code, 'MODEL_NOT_FOUND:fake/model');
});

// ── 4. Timed-out stream: salvage partial text (fake EventSource) ────────────

test('stream: unique legal name in partial text is salvaged after timeout', async () => {
  FakeEventSource.reset();
  const state = makeState();

  const pending = requestStreamActionDecision({
    action: ACTION.DOCTOR_PROTECT,
    actor: byName(state, 'Dana'),
    players: state.players.filter(p => p.alive),
    apiKey: 'test-key',
    model: 'fake/model',
    systemPrompt: 'system',
    userMessage: 'protect',
    timeoutMs: 40,
    eventSourceFactory: FakeEventSource,
  });

  const es = FakeEventSource.latest();
  es.token('Dana');
  // The model never finishes — the deadline fires with 4 characters of text.

  const outcome = await pending;

  assert.equal(es.closed, true, 'the SSE connection must be closed on timeout');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.targetId, 'ai_4');
  assert.equal(outcome.partial, true);
  assert.equal(outcome.degraded, true);
  assert.equal(outcome.code, 'SALVAGED_FROM_PARTIAL');
  assert.match(outcome.reason, /partial response/i);
});

test('stream: partial text without a legal name is a plain timeout', async () => {
  FakeEventSource.reset();
  const state = makeState();

  const pending = requestStreamActionDecision({
    action: ACTION.MAFIA_KILL,
    actor: byName(state, 'Ada'),
    players: state.players.filter(p => p.alive),
    apiKey: 'test-key',
    model: 'fake/model',
    systemPrompt: 'system',
    userMessage: 'kill',
    timeoutMs: 40,
    eventSourceFactory: FakeEventSource,
  });

  FakeEventSource.latest().token('I think the best move tonight is');

  const outcome = await pending;

  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, ACTION_STATUS.TIMEOUT);
  assert.equal(outcome.partial, true);
  assert.equal(outcome.targetId, null);
});

test('stream: a completed reply with an illegal name degrades, not throws', async () => {
  FakeEventSource.reset();
  const state = makeState();

  const pending = requestStreamActionDecision({
    action: ACTION.VOTE,
    actor: byName(state, 'Ada'),
    players: state.players.filter(p => p.alive),
    apiKey: 'test-key',
    model: 'fake/model',
    systemPrompt: 'system',
    userMessage: 'vote',
    timeoutMs: 200,
    eventSourceFactory: FakeEventSource,
  });

  const es = FakeEventSource.latest();
  es.token('Bob'); // teammate — illegal for mafia
  es.done();

  const outcome = await pending;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, ACTION_STATUS.INVALID_TARGET);
});

test('stream: a completed reply with a legal name succeeds', async () => {
  FakeEventSource.reset();
  const state = makeState();

  const pending = requestStreamActionDecision({
    action: ACTION.VOTE,
    actor: byName(state, 'Eli'),
    players: state.players.filter(p => p.alive),
    apiKey: 'test-key',
    model: 'fake/model',
    systemPrompt: 'system',
    userMessage: 'vote',
    timeoutMs: 200,
    eventSourceFactory: FakeEventSource,
  });

  const es = FakeEventSource.latest();
  es.token('Cle');
  es.token('o');
  es.done();

  const outcome = await pending;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.targetId, 'ai_3');
  assert.equal(outcome.partial, false);
});

test('stream: events after completion are ignored (no double resolution)', async () => {
  FakeEventSource.reset();
  const state = makeState();

  const pending = requestStreamActionDecision({
    action: ACTION.VOTE,
    actor: byName(state, 'Eli'),
    players: state.players.filter(p => p.alive),
    apiKey: 'test-key',
    model: 'fake/model',
    systemPrompt: 'system',
    userMessage: 'vote',
    timeoutMs: 5000,
    eventSourceFactory: FakeEventSource,
  });

  const es = FakeEventSource.latest();
  es.token('Cleo');
  es.done();
  es.token('Dana');   // late token — must not alter the result
  es.emit({ error: 'API_ERROR_500' });
  es.done();

  const outcome = await pending;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.targetId, 'ai_3');
});

// ── 5. POST token stream (the route the engine uses for votes) ──────────────

function sseStreamResponse(chunks, { ok = true, status = 200 } = {}) {
  // Each chunk is a JSON object the server would have written as `data: ...\n\n`.
  const encoded = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`);
  let index = 0;
  const body = {
    getReader() {
      return {
        async read() {
          if (index >= encoded.length) return { done: true, value: undefined };
          const value = new TextEncoder().encode(encoded[index++]);
          return { done: false, value };
        },
        async cancel() {},
      };
    },
  };
  return { ok, status, body };
}

test('post stream: legal name streamed then done is applied', async () => {
  const state = makeState();
  const fakeFetch = async () => sseStreamResponse([
    { token: 'El' },
    { token: 'i' },
    { done: true },
  ]);

  const outcome = await requestPostStreamActionDecision({
    action: ACTION.VOTE,
    actor: byName(state, 'Ada'),
    players: state.players.filter(p => p.alive),
    apiKey: 'test-key',
    model: 'fake/model',
    systemPrompt: 'system',
    userMessage: 'vote',
    timeoutMs: 500,
    fetchImpl: fakeFetch,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.targetId, 'ai_5');
  assert.equal(outcome.partial, false);
});

test('post stream: a legal name streamed before the deadline is salvaged', async () => {
  const state = makeState();
  let cancelled = false;
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    body: {
      getReader() {
        let step = 0;
        return {
          async read() {
            if (step++ === 0) {
              return { done: false, value: new TextEncoder().encode('data: {"token":"Dana"}\n\n') };
            }
            // Hang forever — the deadline must cut this off.
            return new Promise(() => {});
          },
          async cancel() { cancelled = true; },
        };
      },
    },
  });

  const outcome = await requestPostStreamActionDecision({
    action: ACTION.DOCTOR_PROTECT,
    actor: byName(state, 'Dana'),
    players: state.players.filter(p => p.alive),
    apiKey: 'test-key',
    model: 'fake/model',
    systemPrompt: 'system',
    userMessage: 'protect',
    timeoutMs: 50,
    fetchImpl: fakeFetch,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.targetId, 'ai_4');
  assert.equal(outcome.partial, true);
  assert.equal(cancelled, true, 'the stream must be cancelled after the deadline');
});

test('post stream: a name streamed but not legal is a timeout, not a vote', async () => {
  const state = makeState();
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    body: {
      getReader() {
        let step = 0;
        return {
          async read() {
            if (step++ === 0) {
              return { done: false, value: new TextEncoder().encode('data: {"token":"Bob"}\n\n') };
            }
            return new Promise(() => {});
          },
          async cancel() {},
        };
      },
    },
  });

  const outcome = await requestPostStreamActionDecision({
    action: ACTION.VOTE,
    actor: byName(state, 'Ada'),
    players: state.players.filter(p => p.alive),
    apiKey: 'test-key',
    model: 'fake/model',
    systemPrompt: 'system',
    userMessage: 'vote',
    timeoutMs: 50,
    fetchImpl: fakeFetch,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, ACTION_STATUS.TIMEOUT);
  assert.equal(outcome.targetId, null);
});

// ── 6. Duplicate submission / duplicate callbacks ───────────────────────────

test('action gate accepts exactly one submission', () => {
  const gate = createActionGate();

  const first = gate.submit('ai_5');
  const second = gate.submit('ai_3');
  const third = gate.submit('skip');

  assert.equal(first.accepted, true);
  assert.equal(second.accepted, false);
  assert.equal(second.duplicate, true);
  assert.equal(third.accepted, false);
  assert.equal(gate.value, 'ai_5');
  assert.equal(gate.settled, true);
});

test('duplicate callbacks produce only one recorded vote', async () => {
  const state = makeState();
  const voter = byName(state, 'Eli');
  const votes = {};
  const gate = createActionGate();

  // Two independent decisions for the same voter (e.g. a double click / retry
  // storm). Both resolve; only the first may write a vote.
  const decision = (content) => requestFetchActionDecision({
    action: ACTION.VOTE,
    actor: voter,
    players: state.players.filter(p => p.alive),
    apiKey: 'test-key',
    model: 'fake/model',
    systemPrompt: 'system',
    userMessage: 'vote',
    timeoutMs: 200,
    fetchImpl: async () => jsonResponse({ content }),
  });

  const applyVote = async (promise) => {
    const outcome = await promise;
    if (gate.settled) return;
    const target = outcome.ok ? outcome.targetId : 'skip';
    const submission = gate.submit(target);
    if (submission.accepted) votes[voter.id] = target;
  };

  await Promise.all([
    applyVote(decision('Cleo')),
    applyVote(decision('Dana')),
  ]);

  assert.equal(gate.settled, true);
  assert.deepEqual(Object.keys(votes), [voter.id]);
  assert.equal(votes[voter.id], 'ai_3', 'the first decision wins; the late one is ignored');
});

// ── 7. Prompt / parser contract ─────────────────────────────────────────────

test('vote prompt asks for exactly one name or abstain and lists legal targets', () => {
  const state = makeState();
  const voter = byName(state, 'Ada');
  const prompt = buildVotePrompt(voter, state);

  assert.match(prompt.user, /"Cleo"/);
  assert.match(prompt.user, /"Eli"/);
  assert.doesNotMatch(prompt.user, /"Ada"/, 'self must not be offered as a target');
  assert.doesNotMatch(prompt.user, /"Bob"/, 'a mafia teammate must not be offered');
  assert.match(prompt.user, /abstain/i);
  assert.match(prompt.user, /Reply with exactly one player name/i);
});

test('night prompts ask for one name and list only legal targets', () => {
  const state = makeState();

  const mafiaPrompt = buildNightMafiaPrompt(byName(state, 'Ada'), state, getLegalTargets(ACTION.MAFIA_KILL, byName(state, 'Ada'), state.players));
  assert.match(mafiaPrompt.user, /"Cleo"/);
  assert.doesNotMatch(mafiaPrompt.user, /"Bob"/);

  const sheriffPrompt = buildNightSheriffPrompt(byName(state, 'Cleo'), state);
  assert.doesNotMatch(sheriffPrompt.user, /"Cleo"/);

  const doctorPrompt = buildNightDoctorPrompt(byName(state, 'Dana'), state);
  assert.match(doctorPrompt.user, /"Dana"/);
  assert.match(doctorPrompt.system, /allowed to protect yourself/i);

  for (const prompt of [mafiaPrompt, sheriffPrompt, doctorPrompt]) {
    assert.match(prompt.user, /Reply with ONLY one name/i);
  }
});

test('game log lines explain why an action was downgraded', () => {
  const voteLine = describeActionOutcome(
    { action: ACTION.VOTE, ok: false, status: ACTION_STATUS.INVALID_TARGET, code: 'TARGET_NOT_LEGAL', reason: '"Bob" cannot be selected — that player is not a legal target for this action.' },
    { action: ACTION.VOTE, actorName: 'Ada', day: 3, phase: 'Day' }
  );
  assert.match(voteLine, /Day 3/);
  assert.match(voteLine, /Ada/);
  assert.match(voteLine, /Bob/);
  assert.match(voteLine, /abstention/i);

  const salvagedLine = describeActionOutcome(
    {
      action: ACTION.DOCTOR_PROTECT, ok: true, targetId: 'ai_4', targetName: 'Dana',
      code: 'SALVAGED_FROM_PARTIAL',
      reason: 'Timed out, but a legal target ("Dana") was recovered from the partial response.',
    },
    { action: ACTION.DOCTOR_PROTECT, actorName: 'Dana', day: 3, phase: 'Night' }
  );
  assert.match(salvagedLine, /applied to Dana/);
  assert.doesNotMatch(salvagedLine, /no night action/i);

  const nightLine = describeActionOutcome(
    { action: ACTION.DOCTOR_PROTECT, ok: false, status: ACTION_STATUS.TIMEOUT, code: 'TIMEOUT', reason: 'The model did not answer before the timeout.' },
    { action: ACTION.DOCTOR_PROTECT, actorName: 'Dana', day: 3, phase: 'Night' }
  );
  assert.match(nightLine, /Night 3/);
  assert.match(nightLine, /no night action/i);
});
