/**
 * Centralized AI transport + structured action resolution.
 *
 * Two layers live here:
 *   1. Legacy transport helpers (streamAISpeech / aiDecide / validateApiKey).
 *   2. Structured action decisions for votes and night actions.
 *
 * Structured decisions never throw for expected failures (timeout, network,
 * empty response, invalid target, abstention). They always resolve to a plain
 * object the caller can branch on:
 *
 *   {
 *     ok: boolean,          // true only when a legal target was matched
 *     status: string,       // ok | abstain | invalid_target | ambiguous_target |
 *                           // empty_response | timeout | network_error |
 *                           // api_error | cancelled
 *     code: string,         // stable machine-readable code
 *     reason: string,       // human-readable explanation for the game log
 *     targetId: string|null,
 *     targetName: string|null,
 *     rawText: string,      // complete or partial model text
 *     partial: boolean,     // true when the action came from timed-out text
 *     legalTargetNames: string[],
 *   }
 */

const CREDIT_ERRORS = [
  'insufficient_credits',
  'insufficient credits',
  'quota',
  'billing',
  'rate_limit_exceeded',
];

function isCreditError(statusCode, responseText) {
  if (statusCode === 402 || statusCode === 429) return true;
  if (responseText) {
    const lower = responseText.toLowerCase();
    return CREDIT_ERRORS.some(e => lower.includes(e));
  }
  return false;
}

// ── Model timeout heuristics (shared by legacy and structured calls) ─────────

function defaultTimeoutForModel(model) {
  const m = String(model || '').toLowerCase();
  const isLargeMoE = m.includes('qwen3.5-397b') || m.includes('qwen3-coder-480b');
  const isThinkingModel =
    m.includes('kimi-k2') ||
    m.includes('deepseek-r1') ||
    m.includes('deepseek-r2') ||
    m.includes('qwq') ||
    m.includes('qvq') ||
    m.includes('o1') ||
    m.includes('o3') ||
    m.includes('minimax');
  return isLargeMoE ? 90000 : isThinkingModel ? 60000 : 35000;
}

// ── Action normalisation █────────────────────────────────────────────────────

export const ACTION_STATUS = Object.freeze({
  OK: 'ok',
  ABSTAIN: 'abstain',
  INVALID_TARGET: 'invalid_target',
  AMBIGUOUS_TARGET: 'ambiguous_target',
  EMPTY_RESPONSE: 'empty_response',
  TIMEOUT: 'timeout',
  NETWORK_ERROR: 'network_error',
  API_ERROR: 'api_error',
  CANCELLED: 'cancelled',
});

export const ACTION = Object.freeze({
  VOTE: 'vote',
  MAFIA_KILL: 'mafia_kill',
  SHERIFF_INVESTIGATE: 'sheriff_investigate',
  DOCTOR_PROTECT: 'doctor_protect',
});

const ACTION_ALIASES = {
  vote: ACTION.VOTE,
  day_vote: ACTION.VOTE,
  lynch: ACTION.VOTE,
  mafia: ACTION.MAFIA_KILL,
  kill: ACTION.MAFIA_KILL,
  mafia_kill: ACTION.MAFIA_KILL,
  night_mafia: ACTION.MAFIA_KILL,
  night_kill: ACTION.MAFIA_KILL,
  sheriff: ACTION.SHERIFF_INVESTIGATE,
  investigate: ACTION.SHERIFF_INVESTIGATE,
  sheriff_investigate: ACTION.SHERIFF_INVESTIGATE,
  night_sheriff: ACTION.SHERIFF_INVESTIGATE,
  doctor: ACTION.DOCTOR_PROTECT,
  protect: ACTION.DOCTOR_PROTECT,
  doctor_protect: ACTION.DOCTOR_PROTECT,
  night_doctor: ACTION.DOCTOR_PROTECT,
};

export function normalizeAction(action) {
  const key = String(action || '').toLowerCase().trim();
  return ACTION_ALIASES[key] || key;
}

/** Case-insensitive, whitespace-trimmed name comparison key. */
export function normalizeName(name) {
  return String(name ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsWholeName(haystack, needle) {
  if (!needle) return false;
  const escaped = escapeRegExp(needle).replace(/\s+/g, '\\s+');
  // \p{L}/\p{N} keep "Bob" from matching inside "Bobby" or "Bobs".
  const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'u');
  return re.test(haystack);
}

/**
 * Return the players a role is allowed to name for an action.
 *
 * Rules:
 *   • vote              — alive, never self; mafia may not vote a teammate.
 *   • mafia_kill        — alive, never self or a mafia teammate.
 *   • sheriff_investigate — alive, never self.
 *   • doctor_protect    — alive, self allowed.
 */
export function getLegalTargets(action, actor, players) {
  const normalizedAction = normalizeAction(action);
  const list = Array.isArray(players) ? players.filter(p => p && p.alive !== false && p.id != null) : [];
  if (!actor || actor.id == null) return [];

  const isMafia = actor.role === 'mafia';

  switch (normalizedAction) {
    case ACTION.VOTE:
      return list.filter(p =>
        p.id !== actor.id && !(isMafia && p.role === 'mafia')
      );
    case ACTION.MAFIA_KILL:
      return list.filter(p => p.id !== actor.id && p.role !== 'mafia');
    case ACTION.SHERIFF_INVESTIGATE:
      return list.filter(p => p.id !== actor.id);
    case ACTION.DOCTOR_PROTECT:
      return list.slice();
    default:
      return [];
  }
}

function findMentionedTargets(text, targets) {
  const haystack = normalizeName(text);
  if (!haystack) return [];
  const found = [];
  const seen = new Set();
  for (const player of targets || []) {
    if (!player || player.id == null || !player.name) continue;
    const needle = normalizeName(player.name);
    if (!needle || seen.has(player.id)) continue;
    if (containsWholeName(haystack, needle)) {
      seen.add(player.id);
      found.push(player);
    }
  }
  return found;
}

/**
 * Prefer an explicitly labelled final answer, e.g. "TARGET: Bob".
 * Returns null when there is no label, so callers can fall back to the
 * full response text.
 */
function findLabelledTarget(text, legalTargets) {
  const re = /(?:^|[\n\r])\s*(?:target|vote|final(?:\s+(?:target|answer|choice))?|choice|choose|protect|investigate)\s*[:=\-]\s*([^\n\r]+)/gi;
  let match;
  let lastValue = null;
  while ((match = re.exec(text)) !== null) lastValue = match[1];
  if (!lastValue) return null;
  const found = findMentionedTargets(lastValue, legalTargets);
  return found.length ? found : null;
}

const ABSTAIN_RE = /\b(?:abstain|abstains|abstained|skip|skipping|pass|passing|no\s+vote|not\s+voting)\b/i;

function isAbstainResponse(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  if (normalizeName(trimmed).replace(/[.!]+$/g, '') === 'abstain') return true;
  return ABSTAIN_RE.test(trimmed);
}

function actionLabel(action) {
  switch (normalizeAction(action)) {
    case ACTION.VOTE: return 'vote';
    case ACTION.MAFIA_KILL: return 'mafia kill';
    case ACTION.SHERIFF_INVESTIGATE: return 'investigation';
    case ACTION.DOCTOR_PROTECT: return 'protection';
    default: return 'action';
  }
}

function statusFromCode(code) {
  const value = String(code || '');
  if (value === 'TIMEOUT' || value.startsWith('TIMEOUT:')) return ACTION_STATUS.TIMEOUT;
  if (value === 'EMPTY_RESPONSE') return ACTION_STATUS.EMPTY_RESPONSE;
  if (value === 'ABSTAIN_REQUESTED') return ACTION_STATUS.ABSTAIN;
  if (value.startsWith('API_ERROR_NETWORK') || value === 'NETWORK_ERROR') return ACTION_STATUS.NETWORK_ERROR;
  if (value === 'CANCELLED') return ACTION_STATUS.CANCELLED;
  if (value.startsWith('API_ERROR') || value === 'INSUFFICIENT_CREDITS' ||
      value === 'INVALID_API_KEY' || value === 'JSON_PARSE_ERROR' ||
      value.startsWith('MODEL_NOT_FOUND')) return ACTION_STATUS.API_ERROR;
  return ACTION_STATUS.INVALID_TARGET;
}

/**
 * Build a non-throwing failure outcome.
 */
export function actionFailure(action, code, reason, extra = {}) {
  const normalizedAction = normalizeAction(action);
  // Callers often spread a partially-built base result into `extra`; the
  // failure code/status must always win over those defaults.
  const { status: _ignoredStatus, code: _ignoredCode, ...rest } = extra;
  return {
    ok: false,
    action: normalizedAction,
    status: statusFromCode(code),
    code: String(code || 'ACTION_FAILED'),
    reason: reason || String(code || 'The action could not be completed.'),
    targetId: null,
    targetName: null,
    rawText: '',
    partial: false,
    legalTargetNames: [],
    ...rest,
  };
}

/**
 * Turn raw model text into a structured, validated action result.
 *
 * Matching is exact after case/whitespace normalisation: a name must equal an
 * alive, role-legal target. Multiple distinct legal names are ambiguous and
 * therefore rejected (the caller downgrades the action).
 *
 * When `errorCode` is a timeout AND some text was streamed before the deadline,
 * the partial text is tried first; a single legal name is accepted as a
 * degraded-but-real action. Otherwise the timeout is reported as a failure.
 */
export function parseActionResponse(rawText, options = {}) {
  const action = normalizeAction(options.action);
  const actor = options.actor || null;
  const players = Array.isArray(options.players) ? options.players : [];
  // knownPlayers (optional) lets the parser explain *why* a real player was
  // rejected (dead / self / teammate) without widening the legal pool.
  const knownPlayers = Array.isArray(options.knownPlayers) && options.knownPlayers.length
    ? options.knownPlayers
    : players;
  const legalTargets = getLegalTargets(action, actor, players);
  const legalTargetNames = legalTargets.map(p => p.name);
  const text = typeof rawText === 'string' ? rawText : String(rawText ?? '');
  const base = {
    ok: false,
    action,
    status: ACTION_STATUS.INVALID_TARGET,
    code: 'INVALID_TARGET',
    reason: '',
    targetId: null,
    targetName: null,
    rawText: text,
    partial: Boolean(options.partial),
    legalTargetNames,
    allPlayers: knownPlayers,
    actorId: actor?.id ?? null,
  };

  const errorCode = options.errorCode ? String(options.errorCode) : '';
  const errorStatus = statusFromCode(errorCode);
  const timedOut = errorStatus === ACTION_STATUS.TIMEOUT;

  if (errorCode) {
    // A timeout (or a misreported empty response) with text attached may still
    // contain a single legal name — try to salvage it before failing.
    const salvageable = timedOut || errorStatus === ACTION_STATUS.EMPTY_RESPONSE;
    const salvaged = salvageable && text.trim()
      ? parseActionText(text, action, legalTargets, base)
      : null;
    if (salvaged?.ok) {
      return {
        ...salvaged,
        partial: true,
        degraded: true,
        code: 'SALVAGED_FROM_PARTIAL',
        reason: `The request did not complete cleanly, but a legal target ("${salvaged.targetName}") was recovered from the partial response.`,
      };
    }
    return actionFailure(action, errorCode, options.reason || defaultErrorReason(errorCode), {
      ...base,
      partial: Boolean(options.partial) || timedOut,
    });
  }

  return parseActionText(text, action, legalTargets, base);
}

function defaultErrorReason(code) {
  switch (statusFromCode(code)) {
    case ACTION_STATUS.TIMEOUT: return 'The model did not answer before the timeout.';
    case ACTION_STATUS.NETWORK_ERROR: return 'A network error interrupted the request.';
    case ACTION_STATUS.EMPTY_RESPONSE: return 'The model returned no text.';
    default: return `The request failed (${code}).`;
  }
}

function parseActionText(text, action, legalTargets, base) {
  if (!text.trim()) {
    return {
      ...base,
      status: ACTION_STATUS.EMPTY_RESPONSE,
      code: 'EMPTY_RESPONSE',
      reason: 'The model returned no text.',
    };
  }

  // A labelled final line wins over the rest of the prose ("TARGET: Bob").
  const labelled = findLabelledTarget(text, legalTargets);
  const mentioned = labelled || findMentionedTargets(text, legalTargets);

  if (mentioned.length === 1) {
    const target = mentioned[0];
    return {
      ...base,
      ok: true,
      status: ACTION_STATUS.OK,
      code: 'OK',
      reason: '',
      targetId: target.id,
      targetName: target.name,
    };
  }

  if (mentioned.length > 1) {
    const names = mentioned.map(p => p.name);
    return {
      ...base,
      status: ACTION_STATUS.AMBIGUOUS_TARGET,
      code: 'AMBIGUOUS_TARGET',
      reason: `Response named more than one legal ${actionLabel(action)} target (${names.join(', ')}).`,
    };
  }

  if (action === ACTION.VOTE && isAbstainResponse(text)) {
    return {
      ...base,
      status: ACTION_STATUS.ABSTAIN,
      code: 'ABSTAIN_REQUESTED',
      reason: 'The model chose to abstain.',
    };
  }

  // Diagnostics: did it name a real player who just is not legal right now
  // (dead, self, or a mafia teammate)? A clearer reason helps the game log.
  const attempted = findMentionedTargets(text, base.allPlayers || []);
  const illegal = attempted.filter(p => !legalTargets.some(legal => legal.id === p.id));
  if (illegal.length === 1) {
    const player = illegal[0];
    const why = player.alive === false
      ? 'that player is not alive'
      : player.id === base.actorId
        ? 'an AI player cannot target itself for this action'
        : 'that player is not a legal target for this action';
    return {
      ...base,
      status: ACTION_STATUS.INVALID_TARGET,
      code: 'TARGET_NOT_LEGAL',
      reason: `"${player.name}" cannot be selected — ${why}.`,
    };
  }
  if (illegal.length > 1) {
    const names = illegal.map(p => p.name);
    return {
      ...base,
      status: ACTION_STATUS.AMBIGUOUS_TARGET,
      code: 'AMBIGUOUS_TARGET',
      reason: `Response named illegal targets (${names.join(', ')}) and no single legal ${actionLabel(action)} target.`,
    };
  }

  return {
    ...base,
    reason: `Response did not contain exactly one legal ${actionLabel(action)} target.`,
  };
}

/**
 * One-shot gate for click handlers / duplicate callbacks.
 * Only the first submission is accepted; later results are ignored.
 */
export function createActionGate() {
  let settled = false;
  let value = null;
  return {
    get settled() { return settled; },
    get value() { return value; },
    submit(nextValue) {
      if (settled) return { accepted: false, duplicate: true, value };
      settled = true;
      value = nextValue;
      return { accepted: true, duplicate: false, value };
    },
  };
}

function normalizeApiErrorCode(raw) {
  const value = String(raw || '');
  if (value === 'INSUFFICIENT_CREDITS' || value === 'INVALID_API_KEY' ||
      value === 'JSON_PARSE_ERROR' || value === 'TIMEOUT' ||
      value === 'NETWORK_ERROR' || value.startsWith('MODEL_NOT_FOUND') ||
      value.startsWith('API_ERROR')) {
    return value;
  }
  if (/failed to fetch|network/i.test(value)) return 'NETWORK_ERROR';
  return `API_ERROR_${value || 'UNKNOWN'}`;
}

function fetchImplFrom(options) {
  if (typeof options.fetchImpl === 'function') return options.fetchImpl;
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
  return null;
}

function eventSourceFactoryFrom(options) {
  if (typeof options.eventSourceFactory === 'function') return options.eventSourceFactory;
  if (typeof globalThis.EventSource === 'function') return globalThis.EventSource;
  return null;
}

/**
 * Request a structured decision through the non-streaming /api/ai-decide route.
 * Never rejects.
 */
export function requestFetchActionDecision(options = {}) {
  const action = normalizeAction(options.action);
  const timeoutMs = Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : defaultTimeoutForModel(options.model);
  const endpoint = options.endpoint || '/api/ai-decide';
  const fetchImpl = fetchImplFrom(options);
  const knownPlayers = Array.isArray(options.knownPlayers) && options.knownPlayers.length
    ? options.knownPlayers
    : options.players;

  if (!fetchImpl) {
    return Promise.resolve(actionFailure(action, 'NETWORK_ERROR', 'No fetch implementation is available.', {
      legalTargetNames: getLegalTargets(action, options.actor, options.players).map(p => p.name),
      allPlayers: knownPlayers,
    }));
  }

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try { controller?.abort(); } catch {}
      finish(actionFailure(action, 'TIMEOUT', 'The model did not answer before the timeout.', {
        legalTargetNames: getLegalTargets(action, options.actor, options.players).map(p => p.name),
        allPlayers: knownPlayers,
      }));
    }, timeoutMs);

    (async () => {
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apiKey: options.apiKey,
            model: options.model,
            systemPrompt: options.systemPrompt,
            userMessage: options.userMessage,
          }),
          signal: controller ? controller.signal : undefined,
        });

        let data = null;
        try {
          data = typeof response?.json === 'function'
            ? await response.json()
            : JSON.parse(await response.text());
        } catch {
          finish(actionFailure(action, 'JSON_PARSE_ERROR', 'The decision endpoint returned an unreadable response.', {
            rawText: '',
          }));
          return;
        }

        if (data?.error) {
          finish(actionFailure(action, normalizeApiErrorCode(data.error), String(data.error), {
            rawText: typeof data.content === 'string' ? data.content : '',
          }));
          return;
        }

        if (response && response.ok === false) {
          finish(actionFailure(action, `API_ERROR_${response.status || 'HTTP'}`, `Decision request failed with HTTP ${response.status || 'error'}.`, {
            rawText: typeof data?.content === 'string' ? data.content : '',
          }));
          return;
        }

        finish(parseActionResponse(data?.content ?? '', {
          action,
          actor: options.actor,
          players: options.players,
          knownPlayers: options.knownPlayers,
        }));
      } catch (e) {
        if (timedOut || e?.name === 'AbortError' || e?.name === 'TimeoutError') {
          finish(actionFailure(action, 'TIMEOUT', 'The model did not answer before the timeout.', {
            rawText: '',
          }));
        } else {
          finish(actionFailure(action, 'NETWORK_ERROR', 'A network error interrupted the decision request.', {
            rawText: '',
          }));
        }
      }
    })();
  });
}

/**
 * Request a structured decision through the SSE endpoint.
 *
 * If the timeout fires after some tokens arrived, the partial text is parsed
 * exactly like a complete answer. A unique legal name salvages the action;
 * otherwise the result is reported as a timeout failure.
 * Never rejects.
 */
export function requestStreamActionDecision(options = {}) {
  const action = normalizeAction(options.action);
  const timeoutMs = Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : defaultTimeoutForModel(options.model);
  const endpoint = options.endpoint || '/api/ai-speak';
  const EventSourceImpl = options.eventSourceFactory || eventSourceFactoryFrom(options);
  const legalTargetNames = getLegalTargets(action, options.actor, options.players).map(p => p.name);
  if (!EventSourceImpl) {
    return Promise.resolve(actionFailure(action, 'NETWORK_ERROR', 'No EventSource implementation is available.', {
      legalTargetNames,
    }));
  }

  return new Promise((resolve) => {
    let settled = false;
    let fullText = '';
    let source = null;

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      try { source?.close?.(); } catch {}
      resolve({ ...outcome, legalTargetNames });
    };

    const parse = (partial) => parseActionResponse(fullText, {
      action,
      actor: options.actor,
      players: options.players,
      knownPlayers: options.knownPlayers,
      partial,
    });
    const timeoutHandle = setTimeout(() => {
      // Re-use the parser's timeout behaviour: try the partial text first and
      // only fall back to a failure when no unique legal name is present.
      const parsed = parseActionResponse(fullText, {
        action,
        actor: options.actor,
        players: options.players,
        knownPlayers: options.knownPlayers,
        errorCode: 'TIMEOUT',
        partial: true,
      });
      if (parsed.ok) {
        finish({
          ...parsed,
          partial: true,
          source: 'partial',
          degraded: true,
          reason: `Timed out, but a legal target ("${parsed.targetName}") was recovered from ${fullText.length} characters of partial response.`,
        });
      } else {
        finish(parsed);
      }
    }, timeoutMs);

    try {
      source = new EventSourceImpl(endpoint);

      source.onmessage = (event) => {
        if (settled) return;
        let data;
        try { data = JSON.parse(event?.data); } catch { return; }

        if (data?.error) {
          finish(actionFailure(action, normalizeApiErrorCode(data.error), String(data.error), {
            rawText: fullText,
            partial: false,
            legalTargetNames,
          }));
          return;
        }

        if (data?.done) {
          const parsed = parse(false);
          finish({
            ...parsed,
            partial: false,
            source: 'complete',
          });
          return;
        }

        if (typeof data?.token === 'string') {
          fullText += data.token;
        }
      };

      source.onerror = () => {
        if (settled) return;
        finish(actionFailure(action, 'NETWORK_ERROR', 'The SSE connection failed before the decision completed.', {
          rawText: fullText,
          partial: false,
          legalTargetNames,
        }));
      };
    } catch {
      finish(actionFailure(action, 'NETWORK_ERROR', 'Could not open the SSE connection.', {
        rawText: fullText,
        partial: false,
        legalTargetNames,
      }));
    }
  });
}

/**
 * Request a structured decision through a POSTed token stream.
 *
 * Used for votes: /api/ai-speak requires POST (the prompts are far too long for
 * an EventSource GET URL). Tokens are accumulated as they arrive, so a timeout
 * can still salvage a unique legal name from partial text.
 * Never rejects.
 */
export function requestPostStreamActionDecision(options = {}) {
  const action = normalizeAction(options.action);
  const timeoutMs = Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : defaultTimeoutForModel(options.model);
  const endpoint = options.endpoint || '/api/ai-speak';
  const fetchImpl = fetchImplFrom(options);
  const legalTargetNames = getLegalTargets(action, options.actor, options.players).map(p => p.name);

  if (!fetchImpl) {
    return Promise.resolve(actionFailure(action, 'NETWORK_ERROR', 'No fetch implementation is available.', {
      legalTargetNames,
    }));
  }

  return new Promise((resolve) => {
    let settled = false;
    let fullText = '';
    let reader = null;
    let timedOut = false;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      try { reader?.cancel?.(); } catch {}
      resolve({ ...outcome, legalTargetNames });
    };

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      try { controller?.abort(); } catch {}
      finish(parseActionResponse(fullText, {
        action,
        actor: options.actor,
        players: options.players,
        knownPlayers: options.knownPlayers,
        errorCode: 'TIMEOUT',
        partial: true,
      }));
    }, timeoutMs);

    (async () => {
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apiKey: options.apiKey,
            model: options.model,
            systemPrompt: options.systemPrompt,
            userMessage: options.userMessage,
          }),
          signal: controller ? controller.signal : undefined,
        });

        if (!response?.ok || !response?.body || typeof response.body.getReader !== 'function') {
          finish(actionFailure(action, `API_ERROR_${response?.status || 'STREAM'}`, `Decision stream failed with HTTP ${response?.status || 'error'}.`, {
            rawText: fullText,
            partial: false,
            legalTargetNames,
          }));
          return;
        }

        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            finish(parseActionResponse(fullText, {
              action,
              actor: options.actor,
              players: options.players,
              knownPlayers: options.knownPlayers,
              partial: false,
            }));
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            let data;
            try { data = JSON.parse(line.slice(6)); } catch { continue; }

            if (data?.error) {
              finish(actionFailure(action, normalizeApiErrorCode(data.error), String(data.error), {
                rawText: fullText,
                partial: false,
                legalTargetNames,
              }));
              return;
            }
            if (data?.done) {
              try { await reader.cancel(); } catch {}
              finish(parseActionResponse(fullText, {
                action,
                actor: options.actor,
                players: options.players,
                knownPlayers: options.knownPlayers,
                partial: false,
              }));
              return;
            }
            if (typeof data?.token === 'string') fullText += data.token;
          }
        }
      } catch (e) {
        if (timedOut || e?.name === 'AbortError' || e?.name === 'TimeoutError') {
          finish(parseActionResponse(fullText, {
            action,
            actor: options.actor,
            players: options.players,
            knownPlayers: options.knownPlayers,
            errorCode: 'TIMEOUT',
            partial: true,
          }));
        } else {
          finish(actionFailure(action, 'NETWORK_ERROR', 'A network error interrupted the decision stream.', {
            rawText: fullText,
            partial: false,
            legalTargetNames,
          }));
        }
      }
    })();
  });
}

/**
 * Unified entry point used by the game engine.
 * `stream` may be false (JSON), true / 'event-source' (SSE), or 'post'
 * (POSTed token stream). Never rejects.
 *
 * @returns {Promise<object>} structured outcome
 */
export function requestActionDecision(options = {}) {
  const streamMode = options.stream;
  if (streamMode === 'post') return requestPostStreamActionDecision(options);
  if (streamMode) return requestStreamActionDecision(options);
  return requestFetchActionDecision(options);
}

/**
 * Build a game-log line for an action outcome.
 *
 * Two shapes:
 *   • ok (possibly salvaged from partial text)  → applied, with a note on why
 *   • !ok                                      → downgraded, with the reason
 */
export function describeActionOutcome(outcome, { action, actorName, day, phase } = {}) {
  const normalizedAction = normalizeAction(action || outcome?.action);
  const isVote = normalizedAction === ACTION.VOTE;
  const who = actorName || 'The AI player';
  const stamp = day != null ? `${phase || (isVote ? 'Day' : 'Night')} ${day}: ` : '';
  const verb = isVote ? 'vote' : actionLabel(normalizedAction);
  const reason = outcome?.reason || outcome?.code || 'no valid target';

  if (outcome?.ok) {
    const target = outcome.targetName || outcome.targetId || 'the chosen target';
    return `${stamp}${who}'s ${verb} was applied to ${target} — ${reason}`;
  }

  const fallback = isVote ? 'Recorded as an abstention.' : 'Recorded as no night action.';
  return `${stamp}${who}'s ${verb} could not be applied — ${reason} ${fallback}`;
}

// ── Legacy transport: SSE speech stream ─────────────────────────────────────

/**
 * Stream an AI speech response via SSE
 * @param {Object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} opts.systemPrompt
 * @param {string} opts.userMessage
 * @param {function} opts.onToken  - called with each token string
 * @param {function} opts.onDone   - called when response complete, receives full text
 * @param {function} opts.onError  - called with error type string
 * @param {number}   opts.timeout  - ms before timeout (default 30000)
 * @returns {function} cancel - call to abort
 */
export function streamAISpeech({ apiKey, model, systemPrompt, userMessage, onToken, onDone, onError, timeout }) {
  let fullText = '';
  let done = false;
  let es = null;

  const timeoutMs = timeout || defaultTimeoutForModel(model);

  console.log(`[streamAISpeech] Using timeout ${timeoutMs}ms for model: ${model}`);

  const url = `/api/ai-speak?apiKey=${enc(apiKey)}&model=${enc(model)}&systemPrompt=${enc(systemPrompt)}&userMessage=${enc(userMessage)}`;

  const timeoutHandle = setTimeout(() => {
    if (!done) {
      done = true;
      if (es) es.close();
      if (fullText) {
        console.log(`[streamAISpeech] Timeout reached but delivering partial response (${fullText.length} chars)`);
        onDone(fullText);
      } else {
        console.log(`[streamAISpeech] Timeout reached with no response`);
        onError('TIMEOUT');
      }
    }
  }, timeoutMs);

  try {
    es = new EventSource(url);

    es.onmessage = (e) => {
      if (done) return;
      let data;
      try { data = JSON.parse(e.data); } catch { return; }

      if (data.error) {
        done = true;
        es.close();
        clearTimeout(timeoutHandle);
        if (data.error === 'INSUFFICIENT_CREDITS') {
          onError('INSUFFICIENT_CREDITS');
        } else {
          // Still deliver partial text if we have any
          if (fullText) onDone(fullText);
          else onError(data.error);
        }
        return;
      }

      if (data.done) {
        done = true;
        es.close();
        clearTimeout(timeoutHandle);
        onDone(fullText);
        return;
      }

      if (data.token) {
        fullText += data.token;
        onToken(data.token, fullText);
      }
    };

    es.onerror = () => {
      if (!done) {
        done = true;
        es.close();
        clearTimeout(timeoutHandle);
        if (fullText) onDone(fullText);
        else onError('SSE_ERROR');
      }
    };
  } catch (e) {
    done = true;
    clearTimeout(timeoutHandle);
    onError('NETWORK_ERROR');
  }

  // Return cancel function
  return () => {
    if (!done) {
      done = true;
      clearTimeout(timeoutHandle);
      if (es) es.close();
    }
  };
}

/**
 * Make a one-shot AI decision (vote, night action)
 * @param {Object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} opts.systemPrompt
 * @param {string} opts.userMessage
 * @param {function} [opts.fetchImpl] - injectable fetch (tests)
 * @param {number}   [opts.timeoutMs] - override default timeout
 * @returns {Promise<{content: string, error: string|null}>}
 */
export async function aiDecide({ apiKey, model, systemPrompt, userMessage, fetchImpl, timeoutMs: explicitTimeout }) {
  const timeoutMs = explicitTimeout || defaultTimeoutForModel(model);
  const doFetch = fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  if (!doFetch) return { content: '', error: 'NETWORK_ERROR' };

  try {
    console.log(`[aiDecide] Using timeout ${timeoutMs}ms for model: ${model}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const res = await doFetch('/api/ai-decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, model, systemPrompt, userMessage }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const data = await res.json();

    if (data.error === 'INSUFFICIENT_CREDITS') {
      return { content: '', error: 'INSUFFICIENT_CREDITS' };
    }
    if (data.error) {
      return { content: '', error: data.error };
    }
    return { content: data.content || '', error: null };
  } catch (e) {
    if (e.name === 'AbortError') {
      return { content: '', error: 'TIMEOUT' };
    }
    return { content: '', error: e.message };
  }
}

/**
 * Validate an API key
 * @param {string} apiKey
 * @returns {Promise<{valid: boolean, error: string|null}>}
 */
export async function validateApiKey(apiKey) {
  if (!apiKey || apiKey.trim().length < 8) {
    return { valid: false, error: 'Please enter your Commonstack API key.' };
  }
  try {
    const res = await fetch('/api/validate-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    });
    const data = await res.json();
    return data;
  } catch (e) {
    return { valid: false, error: 'Network error. Is the server running?' };
  }
}

function enc(str) {
  return encodeURIComponent(str || '');
}
