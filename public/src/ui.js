const POSES = {
  single: '单腿', together: '并立', step: '一前一后', crossed: '交叉',
  tiptoe: '踮脚', point: '足尖点地', pigeon: '内八',
};

const STOCKING_LENGTHS = {
  ankle: '短袜', crew: '中筒袜', knee: '及膝袜', over: '过膝袜', thigh: '大腿袜', tights: '连裤袜',
};

const CUFFS = {
  lace: '蕾丝花边', plain: '纯色宽边', stripes: '双条纹', rib: '罗纹口', bow: '蝴蝶结',
};

const COLORS = {
  ink: ['墨黑', '#141318'], smoke: ['烟灰', '#6c7381'], ivory: ['雪白', '#f4f1f3'],
  nude: ['肤色', '#dba585'], coffee: ['咖啡', '#5a3a2c'], wine: ['酒红', '#6e1b2e'],
  cherry: ['正红', '#c22a3a'], sakura: ['樱粉', '#f3b3c6'], taro: ['香芋紫', '#b49ad6'],
  mist: ['雾蓝', '#8fb4de'], navy: ['藏青', '#1f2a4d'], forest: ['墨绿', '#254a3c'],
};

const MATERIALS = {
  sheer: ['薄丝', '遇水变透'], matte: ['哑光丝', '柔雾质感'], gloss: ['油亮', '水珠更圆更滑'],
  pearl: ['珠光', '沾水更闪'], velvet: ['天鹅绒', '遇水变深'], cotton: ['棉袜', '吸水很快'],
  latex: ['漆皮', '完全不吸水'],
};

const PATTERNS = {
  none: '素面', dots: '波点', argyle: '菱格', net: '网袜', hoops: '横条纹', pins: '竖条纹',
  seam: '后中缝', hearts: '爱心', stars: '星星', paws: '猫爪', lace: '全蕾丝', fade: '渐变',
};

const SECRETS = {none: '无', hearts: '藏爱心', stars: '藏星星', paws: '藏猫爪', words: '藏雨丝'};
const WET_COLORS = {'': '不变', sakura: '变樱粉', mist: '变雾蓝', taro: '变香芋紫', cherry: '变正红'};
const DENIERS = {15: '15D', 40: '40D', 70: '70D', 120: '120D'};
const BACKDROPS = {
  lilac: ['浅紫', '#e4dce8'], sakura: ['樱粉', '#f3d6dd'], mint: ['薄荷', '#cfe7df'],
  cream: ['奶油', '#f0e3c8'], sky: ['天蓝', '#cbdff3'], dusk: ['夜蓝', '#2a2944'],
};
const SCENES = {
  studio: ['影棚', '细雨', '影棚：干净的纸背景，底色可以换，适合拍照。', '#efe9f1'],
  bath: ['浴室', '花洒', '浴室：「细雨」在这里是头顶的花洒，湿地砖会映出腿的倒影。', '#eef1f2'],
  street: ['夜雨街头', '夜雨', '夜雨街头：这里一直下着雨，霓虹的光勾在丝袜上，也映在路面上。', '#141224'],
  pool: ['泳池边', '太阳雨', '泳池边：太阳底下，水面的波光会晃到腿上。', '#e6f3f6'],
};
const TABS = {
  pose: '姿势', preset: '套装', style: '款式', color: '颜色', material: '材质', pattern: '花纹', fun: '彩蛋',
};
const DEFAULT_STOCKING = {
  length: 'thigh', cuff: 'lace', garter: false, material: 'sheer', denier: 40,
  pattern: 'none', color: 'ink', secret: 'none', wetColor: null,
};
const PRESETS = [
  ['经典黑丝', {}],
  ['油亮肉丝', {length: 'tights', material: 'gloss', denier: 15, color: 'nude'}],
  ['纯白过膝', {length: 'over', cuff: 'plain', material: 'velvet', denier: 70, color: 'ivory'}],
  ['蓝白条纹', {length: 'over', cuff: 'plain', material: 'cotton', pattern: 'hoops', color: 'mist'}],
  ['学院及膝', {length: 'knee', cuff: 'stripes', material: 'cotton', color: 'navy'}],
  ['吊带网袜', {garter: true, pattern: 'net'}],
  ['樱粉爱心', {cuff: 'bow', denier: 15, pattern: 'hearts', color: 'sakura'}],
  ['复古后缝', {cuff: 'plain', garter: true, denier: 15, pattern: 'seam', color: 'coffee'}],
  ['黑白不对称', [{}, {color: 'ivory'}]],
  ['漆皮长筒', {cuff: 'plain', material: 'latex', color: 'wine'}],
  ['遇水显形', {cuff: 'plain', material: 'velvet', denier: 70, color: 'ivory', secret: 'hearts'}],
  ['遇水变色', {length: 'over', cuff: 'rib', material: 'cotton', color: 'ivory', wetColor: 'sakura'}],
];

const WATER_HINT = '点丝袜任意位置泼水 · 按住拖动连续浇';
const isHex = value => /^#[0-9a-f]{6}$/i.test(value);
const get = selector => document.querySelector(selector);

function element(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

function button(label, attributes = {}) {
  return element('button', {type: 'button', ...attributes}, [label]);
}

function choices(key, options) {
  return element('div', {class: 'chips', 'data-key': key}, Object.entries(options).map(
    ([value, label]) => button(label, {'data-v': value}),
  ));
}

function swatches(key, options, customLabel) {
  const built = Object.entries(options).map(([value, [label, color]]) => button('', {
    class: 'swatch', 'data-v': value, 'aria-label': label, title: label, style: '--c:' + color,
  }));
  built.push(element('label', {class: 'swatch custom', title: customLabel}, [
    element('input', {type: 'color', value: '#7fb9c9', 'aria-label': customLabel}),
  ]));
  return element('div', {class: 'chips swatches', 'data-key': key}, built);
}

function cards(key, options) {
  return element('div', {class: 'cards', 'data-key': key}, Object.entries(options).map(
    ([value, label]) => element('button', {type: 'button', class: 'card', 'data-v': value}, [
      element('canvas', {width: 180, height: 240, 'aria-hidden': 'true'}),
      element('span', {}, [label]),
    ]),
  ));
}

function row(label, control) {
  return element('div', {class: 'row'}, [element('span', {class: 'label'}, [label]), control]);
}

function note(text, className = 'pane-hint') {
  return element('p', {class: className}, [text]);
}

function presetLegs(index) {
  const outfit = PRESETS[index][1];
  const legs = Array.isArray(outfit) ? outfit : [outfit, outfit];
  return legs.map(leg => ({...DEFAULT_STOCKING, ...leg}));
}

function engineMaterial(legs, target) {
  return {
    target,
    legs: legs.map(leg => ({
      ...leg,
      color: COLORS[leg.color]?.[1] ?? leg.color,
      wetColor: COLORS[leg.wetColor]?.[1] ?? leg.wetColor,
    })),
  };
}

function encodeColor(value) {
  return isHex(value) ? 'x' + value.slice(1).toLowerCase() : value;
}

function decodeColor(value, options) {
  if (/^x[0-9a-f]{6}$/i.test(value)) return '#' + value.slice(1).toLowerCase();
  return Object.hasOwn(options, value) ? value : null;
}

function serializeLook(state) {
  const legs = state.legs.map(leg => [
    leg.length, leg.cuff, Number(leg.garter), leg.material, leg.denier, leg.pattern,
    encodeColor(leg.color), leg.secret, encodeColor(leg.wetColor) || '-',
  ].join('.'));
  return ['1', state.pose, state.scene, encodeColor(state.backdrop), ...legs].join('~');
}

function deserializeLook(hash) {
  const serialized = new URLSearchParams(hash.slice(1)).get('look');
  if (!serialized) return null;
  const [version, pose, scene, backdrop, left, right = left] = serialized.split('~');
  if (version !== '1') return null;

  const readLeg = value => {
    const [length, cuff, garter, material, denier, pattern, color, secret, wetColor] =
      (value || '').split('.');
    return {
      length: Object.hasOwn(STOCKING_LENGTHS, length) ? length : 'thigh',
      cuff: Object.hasOwn(CUFFS, cuff) ? cuff : 'lace',
      garter: garter === '1',
      material: Object.hasOwn(MATERIALS, material) ? material : 'sheer',
      denier: Object.hasOwn(DENIERS, denier) ? Number(denier) : 40,
      pattern: Object.hasOwn(PATTERNS, pattern) ? pattern : 'none',
      color: decodeColor(color, COLORS) || 'ink',
      secret: Object.hasOwn(SECRETS, secret) ? secret : 'none',
      wetColor: decodeColor(wetColor, COLORS),
    };
  };

  return {
    pose: Object.hasOwn(POSES, pose) ? pose : 'step',
    scene: Object.hasOwn(SCENES, scene) ? scene : 'studio',
    backdrop: decodeColor(backdrop, BACKDROPS) || 'lilac',
    legs: [readLeg(left), readLeg(right)],
  };
}

export function initUI(engine) {
  const state = {
    pose: 'step', scene: 'studio', backdrop: 'lilac', target: '-1', tab: 'pose',
    mode: 'water', rain: false, slow: false, sound: true, legs: presetLegs(0),
  };
  const body = document.body;
  const view = get('#view');
  const hint = get('#hint');
  const hasFinePointer = matchMedia('(hover: hover) and (pointer: fine)');
  const materials = get('#materials');
  const scenes = get('#scenes');
  const photo = get('#photo');
  const sceneChoices = cards('scene', Object.fromEntries(
    Object.entries(SCENES).map(([key, [label]]) => [key, label]),
  ));
  const presetChoices = cards('preset', PRESETS.map(([label]) => label));
  const backdropRow = row('底色', swatches('backdrop', BACKDROPS, '自选底色'));
  const sceneNote = note('');
  scenes.replaceChildren(sceneChoices, backdropRow, sceneNote);

  const materialNote = note('');
  const targets = element('div', {
    class: 'seg', 'data-key': 'target', role: 'radiogroup', 'aria-label': '穿在哪条腿上',
  }, [['-1', '双腿'], ['0', '左腿'], ['1', '右腿']].map(
    ([value, label]) => button(label, {'data-v': value, role: 'radio'}),
  ));
  const foot = element('div', {class: 'sheet-foot'}, [
    targets,
    element('div', {class: 'foot-actions'}, [
      button('随机一双', {id: 'randomBtn', class: 'pill'}),
      button('复制链接', {
        id: 'shareBtn', class: 'pill', title: '把这一双连同姿势和场景生成一个链接',
      }),
    ]),
  ]);
  const tabContents = {
    pose: [choices('pose', POSES), note('键盘数字键 1 到 7 也能换姿势。', 'pane-hint keys')],
    preset: [presetChoices],
    style: [
      row('长度', choices('length', STOCKING_LENGTHS)),
      row('袜口', choices('cuff', CUFFS)),
      row('吊带', choices('garter', {'0': '不要', '1': '要（大腿袜）'})),
    ],
    color: [swatches('color', COLORS, '自选颜色')],
    material: [
      row('材质', choices('material', Object.fromEntries(
        Object.entries(MATERIALS).map(([key, [label]]) => [key, label]),
      ))),
      row('厚度', choices('denier', DENIERS)),
      materialNote,
    ],
    pattern: [choices('pattern', PATTERNS)],
    fun: [
      row('显形', choices('secret', SECRETS)),
      row('变色', choices('wetColor', WET_COLORS)),
      note('平时看不出来，泼上水才显出来。选好以后往腿上泼水试试。'),
    ],
  };
  const tabs = element('div', {class: 'tabs', role: 'tablist', 'aria-label': '衣橱分类'},
    Object.entries(TABS).map(([id, label]) => button(label, {role: 'tab', 'data-tab': id})),
  );
  const panes = element('div', {class: 'panes'}, Object.keys(TABS).map(id => element('div', {
    class: 'pane', role: 'tabpanel', 'data-pane': id,
  }, tabContents[id])));
  materials.replaceChildren(tabs, panes, foot);

  let hintTimeout;
  let sceneThumbState;
  let presetThumbPose;
  let sceneTransition;
  let rainStartedByScene = false;
  const thumbnailRequests = new WeakMap();

  function showHint(text, delay = 3200) {
    clearTimeout(hintTimeout);
    hint.textContent = text;
    hint.classList.remove('hide');
    hintTimeout = setTimeout(() => hint.classList.add('hide'), delay);
  }

  function syncChoices(parent, key, selected) {
    const group = parent.querySelector('[data-key="' + key + '"]');
    if (!group) return;
    for (const option of group.querySelectorAll('button')) {
      const isSelected = option.dataset.v === String(selected ?? '');
      option.classList.toggle('on', isSelected);
      if (option.getAttribute('role') === 'radio') {
        option.setAttribute('aria-checked', String(isSelected));
      }
    }
    const custom = group.querySelector('.custom');
    if (custom) {
      const selectedCustom = isHex(selected);
      custom.classList.toggle('on', selectedCustom);
      if (selectedCustom) {
        custom.style.setProperty('--c', selected);
        custom.querySelector('input').value = selected;
      }
    }
  }

  function syncWardrobe() {
    const leg = state.legs[state.target === '1' && state.pose !== 'single' ? 1 : 0];
    for (const [key, value] of Object.entries(leg)) {
      syncChoices(materials, key, key === 'garter' ? Number(value) : value);
    }
    syncChoices(materials, 'pose', state.pose);
    syncChoices(materials, 'target', state.pose === 'single' ? '-1' : state.target);
    foot.classList.toggle('no-target', state.pose === 'single' || state.tab === 'pose');
    const inactive = ['velvet', 'cotton', 'latex'].includes(leg.material);
    materials.querySelector('[data-key="denier"]').classList.toggle('idle', inactive);
    const [label, explanation] = MATERIALS[leg.material];
    materialNote.textContent = label + '：' + explanation + (inactive ? '。这种料子不透，厚度不起作用。' : '。');
    materials.querySelector('[data-key="cuff"]').classList.toggle('idle', leg.length === 'tights');
    materials.querySelector('[data-key="garter"]').classList.toggle('idle', leg.length !== 'thigh');
    for (const option of tabs.children) option.setAttribute('aria-selected', String(state.tab === option.dataset.tab));
    for (const pane of panes.children) pane.hidden = state.tab !== pane.dataset.pane;
  }

  function syncScenes() {
    syncChoices(scenes, 'scene', state.scene);
    syncChoices(scenes, 'backdrop', state.backdrop);
    backdropRow.hidden = state.scene !== 'studio';
    const [, rainName, description, fade] = SCENES[state.scene];
    sceneNote.textContent = description;
    get('#rainBtn span').textContent = rainName;
    const backdropColor = BACKDROPS[state.backdrop]?.[1] || state.backdrop;
    const rgb = backdropColor.slice(1).match(/../g).map(hex => parseInt(hex, 16));
    const brightness = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    body.classList.toggle('dim', state.scene === 'street' || (state.scene === 'studio' && brightness < 0.3));
    document.documentElement.style.setProperty('--stage', state.scene === 'studio' ? backdropColor : fade);
  }

  function drawThumbnail(card, config, previewName) {
    const canvas = card.querySelector('canvas');
    thumbnailRequests.set(canvas, config);
    if (!previewName) {
      engine.thumbnail?.(canvas, config);
      return;
    }
    const image = new Image();
    image.onload = () => {
      if (thumbnailRequests.get(canvas) === config) {
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      }
    };
    image.onerror = () => {
      if (thumbnailRequests.get(canvas) === config) engine.thumbnail?.(canvas, config);
    };
    image.src = new URL('../assets/previews/' + previewName + '.png', import.meta.url).href;
  }

  function drawThumbnails() {
    const material = engineMaterial(state.legs, state.target);
    const sceneKey = JSON.stringify([state.pose, state.backdrop, material.legs]);
    if (body.classList.contains('scene-open') && sceneThumbState !== sceneKey) {
      sceneThumbState = sceneKey;
      const matchesOriginal = state.pose === 'step' && state.backdrop === 'lilac' &&
        JSON.stringify(state.legs) === JSON.stringify(presetLegs(0));
      for (const card of sceneChoices.children) {
        drawThumbnail(card, {
          scene: card.dataset.v, backdrop: state.backdrop, pose: state.pose, material,
        }, matchesOriginal && 'scenes-' + card.dataset.v);
      }
    }
    if (body.classList.contains('mat-open') && state.tab === 'preset' && presetThumbPose !== state.pose) {
      presetThumbPose = state.pose;
      for (const card of presetChoices.children) {
        drawThumbnail(card, {
          scene: 'studio', backdrop: 'lilac', pose: state.pose,
          material: engineMaterial(presetLegs(Number(card.dataset.v)), '-1'),
        }, state.pose === 'step' && 'materials-' + card.dataset.v);
      }
    }
  }

  function readInsets() {
    const wide = body.classList.contains('wide');
    const dock = get('.dock');
    const open = body.classList.contains('mat-open') ? materials : body.classList.contains('scene-open') ? scenes : null;
    const rightPanel = body.classList.contains('roomy') ? get('.side') : open;
    const left = wide ? dock.offsetLeft + dock.offsetWidth + 10 : 0;
    const right = wide && open ? innerWidth - rightPanel.offsetLeft + 10 : 0;
    const style = document.documentElement.style;
    style.setProperty('--inset-l', left + 'px');
    style.setProperty('--inset-r', right + 'px');
    style.setProperty('--stage-x', wide ? (innerWidth + left - right) / 2 + 'px' : '50%');
  }

  function syncPanels() {
    const wardrobe = body.classList.contains('mat-open');
    const scene = body.classList.contains('scene-open');
    const about = body.classList.contains('about-open');
    body.classList.toggle('sheet-open', wardrobe || scene);
    get('#matBtn').setAttribute('aria-pressed', String(wardrobe));
    get('#sceneBtn').setAttribute('aria-pressed', String(scene));
    get('#aboutBtn').setAttribute('aria-expanded', String(about));
    get('#about').setAttribute('aria-hidden', String(!about));
    readInsets();
    drawThumbnails();
  }

  function setPanel(panel) {
    if (body.classList.contains('roomy')) {
      if (panel === 'mat' || panel === 'scene') body.classList.toggle(panel + '-open');
      body.classList.toggle('about-open', panel === 'about');
    } else {
      const currentOpen = panel && body.classList.contains(panel + '-open');
      for (const type of ['mat', 'scene', 'about']) {
        body.classList.toggle(type + '-open', !currentOpen && panel === type);
      }
    }
    syncPanels();
  }

  function resize() {
    const wide = matchMedia('(min-aspect-ratio: 1/1) and (min-width: 600px)').matches;
    const roomy = wide && matchMedia('(min-width: 1000px) and (min-height: 600px)').matches;
    const previouslyRoomy = body.classList.contains('roomy');
    body.classList.toggle('wide', wide);
    body.classList.toggle('roomy', roomy);
    body.classList.toggle('short', wide && innerHeight < 560);
    body.classList.toggle('fine', hasFinePointer.matches);
    if (roomy !== previouslyRoomy) {
      body.classList.toggle('mat-open', roomy);
      body.classList.toggle('scene-open', roomy);
      body.classList.remove('about-open');
    }
    syncPanels();
  }

  function setMode(mode, feedback = true) {
    state.mode = mode;
    body.classList.toggle('view-mode', mode === 'view');
    get('#modeWater').setAttribute('aria-checked', String(mode === 'water'));
    get('#modeView').setAttribute('aria-checked', String(mode === 'view'));
    view.style.cursor = mode === 'view' ? 'grab' : 'crosshair';
    engine.setMode(mode);
    if (feedback) {
      showHint(mode === 'view' ? '视角模式：拖动旋转 · 双指或滚轮缩放 · 轻点放大'
        : '泼水模式：点丝袜泼水 · 按住拖动连续浇');
    }
  }

  function setRain(enabled) {
    state.rain = enabled;
    rainStartedByScene = false;
    get('#rainBtn').setAttribute('aria-pressed', String(enabled));
    engine.setRain(enabled);
  }

  function setSlow() {
    state.slow = !state.slow;
    get('#slowBtn').setAttribute('aria-pressed', String(state.slow));
    engine.setSlow(state.slow);
    if (state.slow) showHint('慢动作 0.2× · 再泼一次看看水花', 2600);
  }

  function setScene(scene, backdrop = state.backdrop) {
    const switchedScene = state.scene !== scene;
    state.scene = scene;
    state.backdrop = backdrop;
    engine.setScene(scene, backdrop);
    if (switchedScene && scene === 'street' && !state.rain) {
      setRain(true);
      rainStartedByScene = true;
    } else if (switchedScene && scene !== 'street' && rainStartedByScene) {
      setRain(false);
    }
    syncScenes();
    drawThumbnails();
  }

  function setPose(pose) {
    state.pose = pose;
    engine.setPose(pose);
    syncWardrobe();
    drawThumbnails();
  }

  function applyMaterial(legs = state.legs, temporary = false) {
    if (!temporary) state.legs = legs;
    engine.setMaterial(engineMaterial(legs, state.target), {temporary});
    if (temporary) return;
    syncWardrobe();
    drawThumbnails();
  }

  function editMaterial(key, value) {
    const target = state.pose === 'single' ? '-1' : state.target;
    const legs = state.legs.map((leg, index) => {
      if (target !== '-1' && Number(target) !== index) return leg;
      const next = {...leg, [key]: value};
      if (key === 'garter' && value) next.length = 'thigh';
      return next;
    });
    applyMaterial(legs);
  }

  function applyLook() {
    const look = deserializeLook(location.hash);
    if (look) {
      state.target = '-1';
      setPose(look.pose);
      setScene(look.scene, look.backdrop);
      applyMaterial(look.legs);
    }
  }

  function linkForLook() {
    const url = new URL(location.href);
    url.hash = 'look=' + serializeLook(state);
    return url.href;
  }

  async function shareLook() {
    const url = linkForLook();
    try {
      await navigator.clipboard.writeText(url);
      showHint('链接已复制 · 别人打开就是这一双、这个姿势和场景', 3400);
    } catch {
      let copy = get('#copybox');
      if (!copy) {
        const dismiss = button('好', {class: 'pill'});
        copy = element('div', {id: 'copybox', class: 'copybox'}, [
          element('span', {}, ['复制下面的链接，别人打开就是这一双、这个姿势和场景：']),
          element('input', {'aria-label': '复制链接', readonly: ''}),
          dismiss,
        ]);
        dismiss.addEventListener('click', () => { copy.hidden = true; });
        body.append(copy);
      }
      copy.hidden = false;
      const input = copy.querySelector('input');
      input.value = url;
      input.focus();
      input.select();
    }
  }

  function setPhoto(open) {
    body.classList.toggle('photo-open', open);
    photo.setAttribute('aria-hidden', String(!open));
  }

  async function takePhoto() {
    const src = await engine.photo();
    if (!src) return;
    get('#photoImg').src = src;
    get('#photoSave').href = src;
    get('#photoTip').textContent = hasFinePointer.matches
      ? '点「保存图片」下载，或在图片上点右键另存为' : '长按图片可以保存';
    setPhoto(true);
  }

  function bucket() {
    engine.bucket();
    if (hint.textContent === WATER_HINT) showHint(WATER_HINT, 1600);
  }

  tabs.addEventListener('click', event => {
    const tab = event.target.closest('[data-tab]');
    if (!tab) return;
    state.tab = tab.dataset.tab;
    syncWardrobe();
    tab.scrollIntoView?.({block: 'nearest', inline: 'nearest'});
    drawThumbnails();
  });
  materials.addEventListener('click', event => {
    const item = event.target.closest('button[data-v]');
    if (!item) return;
    const {key} = item.closest('[data-key]').dataset;
    const {v: value} = item.dataset;
    if (key === 'pose') {
      setPose(value);
    } else if (key === 'target') {
      state.target = value;
      syncWardrobe();
    } else if (key === 'preset') {
      state.target = '-1';
      applyMaterial(presetLegs(Number(value)));
    } else {
      const next = key === 'denier' ? Number(value) : key === 'garter' ? value === '1' : value;
      editMaterial(key, next || (key === 'wetColor' ? null : next));
    }
  });
  materials.querySelector('input[type="color"]').addEventListener('input', event => {
    editMaterial('color', event.target.value);
  });
  presetChoices.addEventListener('pointerover', event => {
    const card = event.target.closest('.card');
    if (event.pointerType === 'mouse' && card && !card.contains(event.relatedTarget)) {
      applyMaterial(presetLegs(Number(card.dataset.v)), true);
    }
  });
  presetChoices.addEventListener('pointerleave', event => {
    if (event.pointerType === 'mouse') applyMaterial(state.legs, true);
  });
  scenes.addEventListener('click', event => {
    const item = event.target.closest('button[data-v]');
    if (!item) return;
    if (item.closest('[data-key]').dataset.key !== 'scene') {
      setScene(state.scene, item.dataset.v);
      return;
    }
    const next = item.dataset.v;
    clearTimeout(sceneTransition);
    body.classList.remove('scene-in');
    if (next === state.scene) {
      body.classList.remove('scene-out');
      return;
    }
    body.classList.add('scene-out');
    sceneTransition = setTimeout(() => {
      setScene(next);
      body.classList.add('scene-in');
      body.classList.remove('scene-out');
      sceneTransition = setTimeout(() => body.classList.remove('scene-in'), 450);
    }, 220);
  });
  scenes.querySelector('input[type="color"]').addEventListener('input', event => {
    setScene('studio', event.target.value);
  });

  const actions = {
    modeWater: () => { if (state.mode !== 'water') setMode('water'); },
    modeView: () => { if (state.mode !== 'view') setMode('view'); },
    bucketBtn: bucket, rainBtn: () => setRain(!state.rain), slowBtn: setSlow,
    dryBtn: () => engine.dry(), sceneBtn: () => setPanel('scene'), matBtn: () => setPanel('mat'),
    sound: () => {
      state.sound = !state.sound;
      get('#sound').setAttribute('aria-pressed', String(state.sound));
      engine.setSound(state.sound);
    },
    zoomIn: () => engine.zoom(1), zoomOut: () => engine.zoom(-1), viewReset: () => engine.resetCamera(),
    aboutBtn: () => setPanel(body.classList.contains('about-open') ? null : 'about'),
    aboutClose: () => setPanel(null), photoBtn: takePhoto, photoClose: () => setPhoto(false),
    shareBtn: shareLook, photoShare: shareLook,
    randomBtn: () => {
      const index = Math.trunc(Math.random() * PRESETS.length);
      const selection = presetLegs(index);
      const keys = Object.keys(COLORS);
      const color = keys[Math.trunc(Math.random() * keys.length)];
      state.target = '-1';
      applyMaterial(selection.map(leg => ({...leg, color})));
    },
  };
  for (const [id, action] of Object.entries(actions)) {
    document.getElementById(id).addEventListener('click', action);
  }

  photo.addEventListener('click', event => { if (event.target === photo) setPhoto(false); });
  view.addEventListener('pointerdown', () => {
    if (body.classList.contains('about-open')) setPanel(null);
    if (state.mode === 'water' && hint.textContent === WATER_HINT) showHint(WATER_HINT, 1600);
  });
  window.addEventListener('click', event => {
    if (event.detail && document.activeElement?.tagName === 'BUTTON') document.activeElement.blur();
  }, true);

  const hotkeys = {
    ' ': bucket, r: actions.rainBtn, s: setSlow, d: actions.dryBtn, p: takePhoto,
    v: () => setMode(state.mode === 'water' ? 'view' : 'water'), c: actions.sceneBtn, w: actions.matBtn,
    arrowleft: () => engine.orbit(14, 0), arrowright: () => engine.orbit(-14, 0),
    arrowup: () => engine.orbit(0, 16), arrowdown: () => engine.orbit(0, -16),
    '+': actions.zoomIn, '=': actions.zoomIn, '-': actions.zoomOut, home: actions.viewReset, 0: actions.viewReset,
  };
  window.addEventListener('keydown', event => {
    const key = event.key.toLowerCase();
    if (key === 'escape') {
      setPanel(null);
      setPhoto(false);
      const copy = get('#copybox');
      if (copy) copy.hidden = true;
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || body.classList.contains('photo-open') ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) ||
        (key === ' ' && event.target.tagName === 'BUTTON')) return;
    if (/^[1-7]$/.test(key)) {
      setPose(Object.keys(POSES)[Number(key) - 1]);
      return;
    }
    if (Object.hasOwn(hotkeys, key)) {
      event.preventDefault();
      hotkeys[key]();
    }
  });

  window.addEventListener('resize', resize);
  hasFinePointer.addEventListener('change', resize);
  window.addEventListener('hashchange', applyLook);
  engine.setScene(state.scene, state.backdrop);
  engine.setPose(state.pose);
  applyMaterial();
  setMode(state.mode, false);
  syncScenes();
  applyLook();
  resize();
}
