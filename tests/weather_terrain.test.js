// 날씨·필드 결산 테스트 (js/mechanics.js)
// 게임 데이터 없이 최소 스텁만으로 mechanics.js를 불러와 settleHit/calcHit를 직접 검증한다.
// 실행: node tests/weather_terrain.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js', 'mechanics.js'), 'utf8');

// ── 최소 스텁: mechanics.js가 참조하는 전역만 흉내낸다 ──
// 타입 번호(원작 그대로): 1 노말, 3 비행, 6 바위, 10 불꽃, 11 물, 12 풀, 13 전기, 14 에스퍼, 15 얼음, 16 드래곤, 18 페어리
const preamble = `
const DATA = {
  species: {},
  moves: {},
  abilities: {},
  chart: Array.from({ length: 18 }, () => Array(18).fill(1)),   // 상성은 모두 1배 (상성이 아니라 날씨·필드를 보는 테스트)
};
const WEATHERS = {
  sun: { n: '쾌청' }, rain: { n: '비' }, sand: { n: '모래바람' }, snow: { n: '설경' }, fog: { n: '안개' },
  hsun: { n: '아주 강한 햇살', base: 'sun' }, hfog: { n: '짙은 안개', base: 'fog' }, wind: { n: '난기류' },
};
const WX_BLOCK = { hsun: 11, hrain: 10 };
const TERRAINS = {
  grassy: { n: '그래스필드', type: 12 },
  misty: { n: '미스트필드', type: 18 },
  electric: { n: '일렉트릭필드', type: 13 },
  psychic: { n: '사이코필드', type: 14 },
};
let CUR_WEATHER = null;
let CUR_TERRAIN = null;
let Dungeon = undefined;   // 날씨 무효화 특성 테스트에서만 채운다
const setWeatherState = w => { CUR_WEATHER = w; };
const setTerrainState = t => { CUR_TERRAIN = t; };
const setDungeonPlayer = c => { Dungeon = c ? { floor: { player: c, mons: [] } } : undefined; };
const ABIL = { 1: { cloudNine: true }, 2: { levitate: true } };   // 1: 날씨부정, 2: 부유
const abilityOf = c => (c && ABIL[c.ability]) || {};
const defAbility = (att, def) => abilityOf(att).moldBreaker ? {} : abilityOf(def);
const abVal = (c, key) => abilityOf(c)[key];
const heldOf = () => ({});
const looksOf = c => c.sp;
const preEvos = () => [];
const defaultAbility = () => 0;
const randomAbility = () => 0;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const applyBoost = (st, b) => Object.assign({ ...st }, b);
const STAT_KO = { maxhp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 };
const SLICING_MOVES = new Set();
const START_LEVEL = 5;
const wxFor = c => weatherNow();
`;

const ctx = vm.createContext({});
vm.runInContext(preamble, ctx, { filename: 'test-stubs.js' });
vm.runInContext(src, ctx, { filename: path.join('js', 'mechanics.js') });
// 결정적 난수: 급소 없음(0.5 >= 1/16), 데미지 난수 보정 0.925 고정, 명중 판정은 항상 성공
vm.runInContext('Math.random = () => 0.5', ctx);

const get = name => vm.runInContext(name, ctx);
const settleHit = get('settleHit'), calcHit = get('calcHit'), weatherNow = get('weatherNow');
const setWeatherState = get('setWeatherState'), setTerrainState = get('setTerrainState'), setDungeonPlayer = get('setDungeonPlayer');

// ── 자체 제작 최소 데이터 ──
const mon = (opts = {}) => Object.assign({
  sp: 1, lv: 50, types: [1], ability: 0, stages: {}, status: null,
  hp: 200, maxhp: 200, atk: 100, def: 80, spa: 100, spd: 80, spe: 100,
}, opts);
const Mv = (id, t, c = 2, p = 40) => ({ id, t, p, a: 100, pp: 10, c, r: 'f', fg: [1] });   // c: 2 물리, 3 특수

const A = mon(), D = mon();
const FIRE = Mv(9001, 10), WATER = Mv(9002, 11), FIRE_SP = Mv(9003, 10, 3);
const GRASS = Mv(9004, 12), ELECTRIC = Mv(9005, 13), DRAGON = Mv(9006, 16);

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok -', name); }
// vm 컨텍스트 안에서 만든 객체는 프로토타입이 달라 deepStrictEqual이 실패하므로 필드별로 비교
function assertHit(actual, expected) {
  for (const k of Object.keys(expected)) assert.equal(actual[k], expected[k], `필드 ${k}`);
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
}

// 기준값(날씨·필드 없음): floor(floor(floor(2*50/5+2)*40*100/80)/50)+2 = 24, ×0.925 → 22
const BASE_DMG = 22, SUN_FIRE = 33, RAIN_FIRE = 11, TERRAIN_BOOST = 27, MISTY_HALF = 12, WX_DEF = 14;

// 1. 쾌청 ↔ 비 전환: 전환 즉시 현재 날씨만 반영되고 이전 효과가 남지 않는다
test('쾌청·비 전환 (불꽃 1.5/0.5, 물 0.5/1.5)', () => {
  setWeatherState(null); setTerrainState(null);
  assert.equal(settleHit(A, D, FIRE).dmg, BASE_DMG);
  setWeatherState('sun');
  assert.equal(settleHit(A, D, FIRE).dmg, SUN_FIRE);
  assert.equal(settleHit(A, D, WATER).dmg, RAIN_FIRE);
  setWeatherState('rain');
  assert.equal(settleHit(A, D, FIRE).dmg, RAIN_FIRE);
  assert.equal(settleHit(A, D, WATER).dmg, SUN_FIRE);
  setWeatherState('sun');   // 다시 쾌청으로 — 비 효과가 남아 있으면 안 된다
  assert.equal(settleHit(A, D, FIRE).dmg, SUN_FIRE);
  setWeatherState(null);
  assert.equal(settleHit(A, D, FIRE).dmg, BASE_DMG);
});

// 2. 날씨 무효화 특성(날씨부정): 위력·방어 보정이 모두 사라진다
test('날씨부정 특성이면 날씨 효과 전부 무효', () => {
  setTerrainState(null);
  setDungeonPlayer(mon({ ability: 1 }));
  setWeatherState('sun');
  assert.equal(weatherNow(), null);
  assert.equal(settleHit(A, D, FIRE).dmg, BASE_DMG);   // 쾌청인데도 불꽃 1.5배 없음
  setWeatherState('sand');
  const rock = mon({ types: [6] });
  assert.equal(settleHit(A, rock, FIRE_SP).dmg, BASE_DMG);   // 바위 특방 1.5배도 없음
  setWeatherState('snow');
  const ice = mon({ types: [15] });
  assert.equal(settleHit(A, ice, FIRE).dmg, BASE_DMG);   // 얼음 방어 1.5배도 없음
  setDungeonPlayer(null);   // 특성이 사라지면 날씨 효과가 돌아온다
  assert.equal(settleHit(A, ice, FIRE).dmg, WX_DEF);
  setWeatherState('sand');
  assert.equal(settleHit(A, rock, FIRE_SP).dmg, WX_DEF);
  setWeatherState(null);
});

// 3. 필드 덮어쓰기: 새 필드만 적용되고 이전 필드 효과는 사라진다
test('필드 덮어쓰기면 이전 필드 효과 소멸', () => {
  setWeatherState(null);
  setTerrainState('grassy');
  assert.equal(settleHit(A, D, GRASS).dmg, TERRAIN_BOOST);
  setTerrainState('electric');   // 덮어쓰기
  assert.equal(settleHit(A, D, GRASS).dmg, BASE_DMG);   // 그래스필드 보정 소멸
  assert.equal(settleHit(A, D, ELECTRIC).dmg, TERRAIN_BOOST);   // 새 필드만 적용
  setTerrainState(null);   // 해제
  assert.equal(settleHit(A, D, ELECTRIC).dmg, BASE_DMG);
});

// 4. 떠 있는 포켓몬(비행 타입·부유 특성)은 필드 효과를 주지도 받지도 않는다
test('이탈 포켓몬은 필드 보정 제외', () => {
  setWeatherState(null);
  const flyer = mon({ types: [3] });
  setTerrainState('electric');
  assert.equal(settleHit(flyer, D, ELECTRIC).dmg, BASE_DMG);   // 뜬 공격자: 1.3배 없음
  assert.equal(settleHit(A, D, ELECTRIC).dmg, TERRAIN_BOOST);   // 땅의 공격자: 1.3배
  setTerrainState('misty');
  assert.equal(settleHit(A, D, DRAGON).dmg, MISTY_HALF);   // 땅의 상대: 드래곤 절반
  assert.equal(settleHit(A, flyer, DRAGON).dmg, BASE_DMG);   // 비행 타입 상대: 절반 없음
  assert.equal(settleHit(A, mon({ ability: 2 }), DRAGON).dmg, BASE_DMG);   // 부유 특성 상대: 절반 없음
  setTerrainState(null);
});

// 5. 날씨·필드가 없으면 데미지가 변경 전 공식과 같다 (독립 계산으로 검증)
test('날씨·필드 없을 때 데미지 불변', () => {
  setWeatherState(null); setTerrainState(null);
  const base = Math.floor(Math.floor(Math.floor(2 * 50 / 5 + 2) * 40 * 100 / 80) / 50) + 2;   // 24
  const expected = Math.max(1, Math.floor(base * (0.85 + 0.5 * 0.15)));   // 난수 보정 0.925 → 22
  assert.equal(expected, BASE_DMG);
  assertHit(settleHit(A, D, FIRE), { hit: true, dmg: expected, eff: 1, crit: false });
});

// 6. 기존 진입점 calcHit는 새 결산 settleHit와 항상 같은 결과
test('calcHit === settleHit (모든 날씨·필드 조합)', () => {
  for (const [w, t] of [[null, null], ['sun', null], ['rain', 'grassy'], ['sand', 'misty'], ['snow', 'electric'], [null, 'psychic']]) {
    setWeatherState(w); setTerrainState(t);
    const c1 = calcHit(A, D, FIRE), s1 = settleHit(A, D, FIRE);
    const c2 = calcHit(A, D, DRAGON), s2 = settleHit(A, D, DRAGON);
    assertHit(c1, { ...s1 });
    assertHit(c2, { ...s2 });
  }
  setWeatherState(null); setTerrainState(null);
});

console.log(`\n${passed}개 테스트 모두 통과`);
