// The cauldron overlay. The 3D view owns the left 58 % of the screen (the game handles stirring
// there), so this layer lets pointer events through and only its panel on the right takes them.
import { h, setText, setClass, setShown, setStyle, clamp01, numberWord, mixHex, actionsOf } from './dom.js';
import { createChart } from './chart.js';
import { readout, NO_MATCH } from '../game/brewlogic.js';

const cap = (str) => (str ? str[0].toUpperCase() + str.slice(1) : str);
const R3 = (v) => (Math.round(v * 1000) / 1000).toFixed(3);

/** The word the Magistra would use for a heat band. */
export function heatWord(band) {
  if (!band) return '';
  const c = (band[0] + band[1]) / 2;
  if (c < 0.2) return 'dying embers';
  if (c < 0.4) return 'a gentle heat';
  if (c < 0.56) return 'a steady fire';
  if (c < 0.66) return 'a strong fire';
  if (c < 0.76) return 'a hot fire';
  return 'a roaring fire';
}

export function createBrew(game, icons) {
  const D = game.data;
  const A = actionsOf(game);
  const chart = createChart(game);
  const el = h('div', { class: 'tp-layer tp-brew' });

  // ---- header: what is in the pot ---------------------------------------------------------------
  const pips = h('div', { class: 'tp-pips' });
  const pipEls = [];
  for (let i = 0; i < D.BREW.capacity; i++) {
    const p = h('i');
    pipEls.push(p);
    pips.append(p);
  }
  const head = h('div', { class: 'tp-brew-head' }, h('div', { class: 'tp-label', text: 'The cauldron' }), pips);

  // ---- status under the chart -----------------------------------------------------------------
  const stName = h('div', { class: 'tp-brew-name' });
  const markEls = [h('i'), h('i'), h('i')];
  const stMarks = h('div', { class: 'tp-marks' }, markEls);
  const stSub = h('div', { class: 'tp-brew-sub' });
  const status = h('div', { class: 'tp-brew-status' }, h('div', { class: 'tp-brew-nameline' }, stName, stMarks), stSub);

  // the Great Work: four colours instead of a region
  const stageEls = D.OPUS.stages.map((sg) => h('div', { class: 'tp-stage', style: { '--c': sg.id === 'nigredo' ? '#8a8690' : sg.color } }, h('i'), h('span', { class: 'tp-label', text: sg.name })));
  const stages = h('div', { class: 'tp-stages' }, stageEls);

  // ---- heat gauge -----------------------------------------------------------------------------
  const band = h('div', { class: 'tp-gauge-band' });
  const bandWord = h('div', { class: 'tp-gauge-word' });
  const fire = h('div', { class: 'tp-gauge-fire' });
  const heat = h('div', { class: 'tp-gauge-heat' });
  const ticks = h('div', { class: 'tp-gauge-ticks' });
  for (let i = 0; i <= 10; i++) ticks.append(h('i', { style: { left: i * 10 + '%' } }));
  const gauge = h(
    'div',
    { class: 'tp-gauge' },
    bandWord,
    h('div', { class: 'tp-gauge-rail' }, h('div', { class: 'tp-gauge-line' }), ticks, band, fire, heat),
    h(
      'div',
      { class: 'tp-gauge-ends' },
      h('span', { class: 'tp-label', text: 'Embers' }),
      h('span', { class: 'tp-gauge-legend' }, h('i', { class: 'tp-gauge-key-heat' }), h('span', { class: 'tp-label', text: 'The pot' }), h('i', { class: 'tp-gauge-key-fire' }), h('span', { class: 'tp-label', text: 'The fire' })),
      h('span', { class: 'tp-label', text: 'Roaring' })
    )
  );

  // ---- the reading: mixture, fire against the band, the binding ---------------------------------
  // One small table under the chart. It is filled from game.brew through the same rules module the
  // cauldron uses, so the numbers a player reads are the numbers the pour obeys. The mixture takes
  // the whole width; the rest share a second row, so it stays legible down to 900 x 600.
  const rdMix = h('span', { class: 'tp-rd-num' });
  const rdMatch = h('span', { class: 'tp-rd-name' });
  const rdHeatState = h('span', { class: 'tp-rd-state' });
  const rdHeat = h('span', { class: 'tp-rd-num' }, rdHeatState);
  const rdBand = h('span', { class: 'tp-rd-sub' });
  const rdBind = h('span', { class: 'tp-rd-num' });
  const rdBindBar = h('i');
  const cell = (label, cls, ...kids) => h('div', { class: 'tp-rd-cell' + (cls ? ' ' + cls : '') }, h('span', { class: 'tp-label', text: label }), ...kids);
  const rd = h(
    'div',
    { class: 'tp-reading' },
    cell('Mixture', 'is-wide', rdMix),
    cell('Mark', '', rdMatch),
    cell('Fire', '', rdHeat, rdBand),
    cell('Binding', '', h('span', { class: 'tp-rd-line' }, h('span', { class: 'tp-rd-bar' }, rdBindBar), rdBind))
  );

  // ---- the shelf ------------------------------------------------------------------------------
  const shelf = h('div', { class: 'tp-shelf' });
  const info = h('div', { class: 'tp-shelf-info' });
  const infoName = h('span', { class: 'tp-shelf-info-name' });
  const infoText = h('span', { class: 'tp-shelf-info-text' });
  info.append(infoName, infoText);

  // ---- keys -----------------------------------------------------------------------------------
  function keyBtn(key, label, opts) {
    const b = h('button', { class: 'tp-keybtn', type: 'button' }, h('span', { class: 'tp-key', text: key }), h('span', { class: 'tp-label', text: label }));
    if (opts.hold) {
      const up = () => {
        if (b.__down) {
          b.__down = false;
          b.classList.remove('is-down');
          opts.hold(false);
        }
      };
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        b.__down = true;
        b.classList.add('is-down');
        try {
          b.setPointerCapture(e.pointerId);
        } catch (err) {
          /* not capturable: pointerleave still releases */
        }
        opts.hold(true);
      });
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('lostpointercapture', up);
    } else b.addEventListener('click', () => opts.click());
    return b;
  }
  const kBellows = keyBtn('Space', 'Bellows', { hold: (on) => A.brewPump(on) });
  const kDamper = keyBtn('C', 'Damper', { hold: (on) => A.brewDamp(on) });
  const kBottle = keyBtn('B', 'Bottle', { click: () => A.brewBottle() });
  const kEmpty = keyBtn('X', 'Empty', { click: () => A.brewEmpty() });
  const kLeave = keyBtn('Esc', 'Leave', { click: () => A.brewLeave() });
  const keys = h('div', { class: 'tp-keys' }, kBellows, kDamper, kBottle, kEmpty, kLeave);

  const panel = h('div', { class: 'tp-brew-panel' }, head, chart.el, status, stages, gauge, rd, shelf, info, keys);
  const stir = h('div', { class: 'tp-brew-stir' });
  el.append(h('div', { class: 'tp-brew-veil' }), stir, panel);

  // ---- shelf building -------------------------------------------------------------------------
  let shelfKey = '',
    shelfItems = [],
    hoverId = null,
    on = false;

  function setHover(id) {
    hoverId = id;
    chart.setHover(id && D.INGREDIENTS[id] ? id : null);
    if (id && D.INGREDIENTS[id]) {
      setText(infoName, D.INGREDIENTS[id].name);
      setText(infoText, D.INGREDIENTS[id].latin);
    } else if (id && id.startsWith('prime:')) {
      const p = D.PRIME_ITEMS[id.slice(6)];
      setText(infoName, p ? p.name : '');
      setText(infoText, p ? p.desc : '');
    } else {
      setText(infoName, '');
      setText(infoText, '');
    }
  }

  function buildShelf(list) {
    shelfItems = list.map(([id, n]) => {
      const prime = id.startsWith('prime:');
      const count = h('span', { class: 'tp-shelf-n' });
      const b = h('button', { class: 'tp-shelf-item' + (prime ? ' is-prime' : ''), type: 'button', 'aria-label': prime ? D.PRIME_ITEMS[id.slice(6)].name : D.INGREDIENTS[id].name }, prime ? icons.make('prime', id.slice(6)) : icons.make('ingredient', id), count);
      b.addEventListener('pointerenter', () => setHover(id));
      b.addEventListener('pointerleave', () => hoverId === id && setHover(null));
      b.addEventListener('click', () => A.brewAdd(id));
      void n;
      return { id, el: b, count, prime };
    });
    shelf.replaceChildren(...shelfItems.map((it) => it.el));
    if (!shelfItems.length) shelf.append(h('div', { class: 'tp-shelf-empty', text: 'You carry nothing to put in the pot.' }));
    if (hoverId && !shelfItems.some((it) => it.id === hoverId)) setHover(null);
  }

  // ---- per-frame ------------------------------------------------------------------------------
  function update(dt) {
    const st = game.state,
      b = game.brew;
    chart.draw(dt);

    // pips
    const n = b.contents.length;
    for (let i = 0; i < pipEls.length; i++) setClass(pipEls[i], 'is-on', i < n);

    const primesIn = b.contents.some((x) => String(x).startsWith('prime:'));
    const opus = b.opus || null;
    const work = !!opus || primesIn;

    // status. The name shown is the readout's own: the potion a pour would give, whether or not
    // the player has inked that region yet. "No match" is shown as plainly as a name.
    const ro = readout(b);
    let name = '',
      sub = '',
      marks = 0,
      color = '';
    const inked = (id) => !!(st.known.charted[id] || st.known.potions[id]);
    if (opus) {
      if (opus.done) {
        name = 'The Stone';
        sub = 'It is finished. Take it from the pot.';
        color = D.OPUS.stages[3].color;
      } else {
        const sg = D.OPUS.stages[Math.min(3, opus.stage)];
        name = sg.name;
        sub = cap(sg.sub) + '. ' + (b.fit < 0 ? 'The fire is too low.' : b.fit > 0 ? 'The fire is too high.' : 'Do not stop stirring.');
      }
    } else if (primesIn) {
      const have = b.contents.filter((x) => String(x).startsWith('prime:')).length;
      name = 'The Great Work';
      sub = have < 3 ? 'All three Primes must go into the pot.' : 'Begin with the embers almost out.';
    } else if (ro.bound) {
      const p = D.POTIONS[ro.output];
      name = p ? p.full : '';
      marks = b.ready.stars;
      color = p ? p.color : '';
      sub = cap(numberWord(ro.count)) + (ro.count === 1 ? ' phial.' : ' phials.') + ' Bottle it.';
    } else if (ro.region) {
      const p = D.POTIONS[ro.region];
      name = p.name;
      marks = b.region.stars;
      color = p.color;
      sub = ro.fit < 0 ? 'The fire is too low.' : ro.fit > 0 ? 'The fire is too high.' : ro.progress > 0.01 ? 'It is binding. Keep stirring.' : 'Stir until it binds.';
      if (!inked(ro.region)) sub += ' Unwritten.';
    } else if (!n) {
      name = '';
      sub = 'The pot is empty.';
    } else {
      name = NO_MATCH;
      sub = 'It lies outside every region. No potion can be poured from it.';
    }
    if (b.hint && !(opus && opus.done)) sub = b.hint;
    setText(stName, name);
    setShown(stName, !!name);
    // the name of a match carries its potion's colour; "No match" stays plain bone
    setClass(stName, 'is-miss', n > 0 && !opus && !primesIn && !ro.region);
    setStyle(stName, 'color', color ? mixHex(color, '#ddd5c4', 0.45) : '');
    setShown(stMarks, marks > 0);
    for (let i = 0; i < 3; i++) setClass(markEls[i], 'is-on', i < marks);
    setText(stSub, sub);
    setClass(status, 'is-ready', !!ro.bound || !!(opus && opus.done));

    // the reading: the same numbers the pour obeys
    setText(rdMix, ro.mix ? ro.mix.map(R3).join(' · ') : '—');
    setText(rdMatch, opus ? 'the Work' : ro.matched ? ro.name : n ? NO_MATCH : '—');
    setClass(rdMatch, 'is-miss', n > 0 && !opus && !ro.matched);
    setText(rdHeat, ro.heat.toFixed(2));
    setText(rdBand, ro.band ? ro.band[0].toFixed(2) + '–' + ro.band[1].toFixed(2) : '');
    setClass(rdHeatState, 'is-in', ro.fit === 0);
    setClass(rdHeatState, 'is-out', !!ro.band && ro.fit !== 0);
    setText(rdHeatState, opus ? (ro.fit === 0 ? 'in band' : ro.fit < 0 ? 'too cold' : 'too hot') : !ro.band ? 'no band' : ro.fit === 0 ? 'in band' : ro.fit < 0 ? 'too cold' : 'too hot');
    setText(rdBind, Math.round(ro.progress * 100) + '%');
    setStyle(rdBindBar, 'transform', 'scaleX(' + clamp01(ro.progress).toFixed(3) + ')');

    // the four stages
    setShown(stages, work);
    if (work) {
      for (let i = 0; i < stageEls.length; i++) {
        const done = !!opus && (opus.done || i < opus.stage);
        const now = !!opus && !opus.done && i === opus.stage;
        setClass(stageEls[i], 'is-done', done);
        setClass(stageEls[i], 'is-now', now);
      }
    }

    // gauge
    const pct = (v) => (Math.round(clamp01(v) * 1000) / 10).toFixed(1) + '%';
    setStyle(heat, 'left', pct(b.heat));
    setStyle(fire, 'left', pct(b.fire));
    const bd = ro.band;
    setShown(band, !!bd);
    setShown(bandWord, !!bd);
    if (bd) {
      setStyle(band, 'left', pct(bd[0]));
      setStyle(band, 'width', pct(bd[1] - bd[0]));
      setStyle(bandWord, 'left', pct((bd[0] + bd[1]) / 2));
      setText(bandWord, heatWord(bd));
    }
    setClass(gauge, 'is-in', ro.fit === 0);
    setClass(gauge, 'is-cold', ro.fit === -1);
    setClass(gauge, 'is-hot', ro.fit === 1);

    // shelf
    let key = '';
    const list = [];
    for (const id of D.INGREDIENT_ORDER) {
      const c = st.inv.ingredients[id] || 0;
      if (c > 0) {
        list.push([id, c]);
        key += id + ',';
      }
    }
    for (const id of ['salt', 'mercury', 'sulfur']) {
      if (st.inv.primes[id] && b.contents.indexOf('prime:' + id) < 0) {
        list.push(['prime:' + id, 1]);
        key += 'p' + id + ',';
      }
    }
    if (key !== shelfKey) {
      shelfKey = key;
      buildShelf(list);
    }
    const full = n >= D.BREW.capacity || !!b.ready || !!opus;
    for (const it of shelfItems) {
      if (!it.prime) setText(it.count, st.inv.ingredients[it.id] || 0);
      // herbs and Primes do not share a pot
      const blocked = full || (it.prime ? n > 0 && !primesIn : primesIn);
      if (it.el.disabled !== blocked) it.el.disabled = blocked;
    }
    // under the shelf: the thing under the pointer, or the first instruction while the pot is empty
    if (!hoverId) {
      setText(infoName, '');
      setText(infoText, !n && !opus && shelfItems.length ? 'Choose what goes into the pot.' : '');
    }

    // keys. Bottle is offered whenever the pot holds anything: a pour that cannot be made says why.
    const canBottle = (n > 0 && !opus) || !!(opus && opus.done);
    if (kBottle.disabled === canBottle) kBottle.disabled = !canBottle;
    setClass(kBottle, 'is-call', !!ro.bound || !!(opus && opus.done));
    setText(kBottle.lastChild, opus && opus.done ? 'Take' : 'Bottle');
    const canEmpty = n > 0 && !(opus && opus.done);
    if (kEmpty.disabled === canEmpty) kEmpty.disabled = !canEmpty;

    // the line over the pot
    const stirLine = ro.bound || (opus && opus.done) ? '' : (ro.region || opus) && ro.fit === 0 && b.stir < 0.25 ? 'Circle the mouse over the pot to stir.' : '';
    setText(stir, stirLine);
    setClass(stir, 'is-on', !!stirLine);
  }

  return {
    el,
    update,
    chart,
    setOn(v) {
      if (v === on) return;
      on = v;
      if (v) {
        chart.invalidate();
        shelfKey = '';
      } else setHover(null);
    },
  };
}
