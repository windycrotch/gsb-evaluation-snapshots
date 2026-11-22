import { act, renderHook } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import useActorController from '@/hooks/useActorController';
import useActorStore from '@/store/actor';
import useStore from '@/store/store';
import type { ActorDataConfig, DiFangType } from '@/types';
import { useBattle } from '../src/pages/Main/pages/shilian/useBattle';

// chuwu.Add 依赖独立的 zustand 存档，测试中改为可断言的 spy，
// 避免在存档 store 与测试 actor 之间产生双份状态。
const chuwuMocks = vi.hoisted(() => ({
  add: vi.fn()
}));

vi.mock('@/utils/chuwu', () => ({
  default: {
    Add: (...args: unknown[]) => chuwuMocks.add(...args)
  }
}));

const DF: DiFangType = {
  name: '试炼之地',
  jingjie: '练气',
  desc: '测试用试炼地点'
};

const ACTOR_ID = 'test-actor';

function buildActor(overrides: Partial<ActorDataConfig> = {}): ActorDataConfig {
  return {
    uuid: ACTOR_ID,
    daohao: '测试修士',
    linggen: '金灵根',
    jingjie: '练气',
    jingjie1: '一阶',
    jingjie2: '初期',
    // 玩家属性碾压：稳定先手、一击秒杀，保证战斗时序确定性
    qixue: 100000,
    gongji: 100000,
    fangyu: 10000,
    sudu: 100000,
    baoji: 0,
    fashu: 0,
    xianyuan: 0,
    xiuwei: 0,
    max_xiuwei: 10000000,
    shenshi: 100,
    max_shenshi: 100,
    shouyuan: 100,
    max_shouyuan: 100,
    zhongzu: '人族',
    lv: 1,
    xiulianbeilv: 10,
    cw: { fb: [], dy: [], qt: [], max: 30 },
    time1: 0,
    xiuxianStartAt: 0,
    xiuxianTimeScale: 1,
    shenshiTime: 0,
    fabao: {},
    addAttr: {
      qixue: 0,
      gongji: 0,
      fangyu: 0,
      sudu: 0,
      baoji: 0,
      fashu: 0
    },
    qiandao: { count: 0, last: '', time: '', streak: 0 },
    zd: { time: 0, df: DF.name },
    xiulian: null,
    dongfu: null,
    liandan: {
      time: 0,
      completeTime: 0,
      chenghao: '',
      danyun: 0,
      exp: 0,
      max_exp: 100,
      danlu: null,
      danyao: null
    },
    danfang: [],
    gongfa: { ls: [], current: null },
    battleCount: 0,
    winStreak: 0,
    ...overrides
  } as ActorDataConfig;
}

function seedActor(overrides?: Partial<ActorDataConfig>) {
  useStore.setState({ current: ACTOR_ID });
  useActorStore.setState((state) => ({
    actors: { ...state.actors, [ACTOR_ID]: buildActor(overrides) }
  }));
}

function useBattleHarness() {
  const controller = useActorController();
  const battle = useBattle(DF, controller.get, controller.set);
  return { ...controller, ...battle };
}

/**
 * 以小步长推进假定时器并在每步刷新 React 提交，
 * 模拟真实环境中定时器逐个触发的行为，避免大块跳时导致的 effect 批处理差异。
 */
async function advance(ms: number, step = 100) {
  const steps = Math.max(1, Math.round(ms / step));
  for (let i = 0; i < steps; i += 1) {
    // 小步推进假定时器是本用例模拟真实 tick 的必要手段
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await vi.advanceTimersByTimeAsync(step);
    });
  }
}

/** 日志节点是 JSX，渲染为静态标记后再做文本断言 */
function logTexts(logs: { text: React.ReactNode }[]): string[] {
  return logs.map((l) => renderToStaticMarkup(<span>{l.text}</span>));
}

describe('useBattle 战斗会话生命周期', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    chuwuMocks.add.mockClear();
    useActorStore.setState({ actors: {} });
    useStore.setState({ current: '' });
  });

  it('每次探索生成新会话标识，连续快速点击探索只生效一次且只扣一次神识', () => {
    seedActor();
    const { result } = renderHook(() => useBattleHarness());

    expect(result.current.battleSessionId).toBe(0);

    act(() => {
      result.current.handleSearchYaoShou();
      result.current.handleSearchYaoShou();
      result.current.handleSearchYaoShou();
    });

    expect(result.current.battleSessionId).toBe(1);
    expect(result.current.YaoShouInstance).not.toBeNull();
    expect(result.current.ActorInstance).not.toBeNull();
    expect(result.current.HuiheState.end).toBe(false);
    expect(result.current.get('shenshi')).toBe(99);

    // 战斗未结束时再次探索必须被拒绝
    act(() => {
      result.current.handleSearchYaoShou();
    });
    expect(result.current.battleSessionId).toBe(1);
    expect(result.current.get('shenshi')).toBe(99);
  });

  it('同一会话胜利只结算一次：重复点击战斗不会重复发放奖励与成就计数', async () => {
    seedActor();
    const { result } = renderHook(() => useBattleHarness());

    act(() => {
      result.current.handleSearchYaoShou();
    });
    expect(result.current.YaoShouInstance?.name).toBeTruthy();

    act(() => {
      result.current.handleStartZD();
      result.current.handleStartZD();
      result.current.handleStartZD();
    });

    // 开战即一击致命，但胜利结算在首个 800ms 回合回调中完成
    expect(result.current.HuiheState.can).toBe(true);
    await advance(800);
    expect(result.current.HuiheState.end).toBe(true);
    expect(result.current.get('battleCount')).toBe(1);
    expect(result.current.get('winStreak')).toBe(1);
    expect(result.current.guajiStats.wins).toBe(0); // 手动战斗不计挂机统计

    // 胜利日志（材料/灵石/战斗结束）只出现一份
    const texts = logTexts(result.current.HuiheState.logs);
    expect(texts.filter((t) => t.includes('战斗结束'))).toHaveLength(1);
    expect(texts.filter((t) => t.includes('你获得材料'))).toHaveLength(1);
    expect(texts.filter((t) => t.includes('获得灵石'))).toHaveLength(1);

    // 战利品调用：材料与灵石各恰好一次；升灵石为概率掉落，允许出现但不可重复
    const addCalls = chuwuMocks.add.mock.calls.map((call) => call[0].name);
    const materialNames = addCalls.filter(
      (n) => n !== '灵石' && n !== '升灵石'
    );
    expect(materialNames).toHaveLength(1);
    expect(addCalls.filter((n) => n === '灵石')).toHaveLength(1);
    expect(addCalls.filter((n) => n === '升灵石').length).toBeLessThanOrEqual(
      1
    );

    // 战后延迟清理回调不得影响“已结束”状态，且不会二次结算
    await advance(2000);
    expect(result.current.YaoShouInstance).toBeNull();
    expect(result.current.ActorInstance).toBeNull();
    expect(result.current.get('battleCount')).toBe(1);
    expect(result.current.get('winStreak')).toBe(1);
    const callsAfterCleanup = chuwuMocks.add.mock.calls.length;
    expect(callsAfterCleanup).toBeGreaterThanOrEqual(2);
    expect(callsAfterCleanup).toBeLessThanOrEqual(3);
  });

  it('胜利结算瞬间点击遁逃：遁逃被拦截，不扣神识、不发第二份奖励', async () => {
    seedActor();
    const { result } = renderHook(() => useBattleHarness());

    act(() => {
      result.current.handleSearchYaoShou();
    });
    const shenshiAfterSearch = result.current.get('shenshi');

    act(() => {
      result.current.handleStartZD(); // 一击致命
    });
    await advance(800); // 等待回合回调完成胜利结算
    expect(result.current.HuiheState.end).toBe(true);

    act(() => {
      result.current.handleEscape(); // 结算瞬间遁逃
    });

    expect(result.current.get('shenshi')).toBe(shenshiAfterSearch);
    expect(result.current.get('battleCount')).toBe(1);
    // 仍是同一会话，遁逃不会新建会话
    expect(result.current.battleSessionId).toBe(1);
    const callsAtSettled = chuwuMocks.add.mock.calls.length;
    expect(callsAtSettled).toBeGreaterThanOrEqual(2);
    expect(callsAtSettled).toBeLessThanOrEqual(3);
  });

  it('遁逃扣除神识并清理双方实例，不发战利品、不计胜负，之后可立即重新探索', async () => {
    seedActor();
    const { result } = renderHook(() => useBattleHarness());

    act(() => {
      result.current.handleSearchYaoShou();
    });
    act(() => {
      result.current.handleStartZD();
    });
    // 已开战但首个 800ms 回合回调尚未触发，战斗仍在进行
    expect(result.current.HuiheState.can).toBe(true);
    expect(result.current.HuiheState.end).toBe(false);

    const shenshiBeforeEscape = result.current.get('shenshi');
    act(() => {
      result.current.handleEscape();
    });

    // 遁逃扣神识（基础消耗 2~10）
    const escapeCost = shenshiBeforeEscape - result.current.get('shenshi');
    expect(escapeCost).toBeGreaterThanOrEqual(2);
    expect(escapeCost).toBeLessThanOrEqual(10);
    expect(chuwuMocks.add).not.toHaveBeenCalled();
    expect(result.current.guajiStats.wins).toBe(0);
    expect(result.current.guajiStats.losses).toBe(0);
    expect(result.current.guajiStats.history).toHaveLength(0);

    // 立即重新探索：干净的新会话
    act(() => {
      result.current.handleSearchYaoShou();
    });
    expect(result.current.battleSessionId).toBe(2);
    expect(result.current.YaoShouInstance).not.toBeNull();
    expect(result.current.ActorInstance).not.toBeNull();
    expect(result.current.HuiheState.end).toBe(false);
    expect(result.current.HuiheState.huihe).toBe(0);

    // 上一场遁逃的延迟清理回调绝不能清掉新会话的妖兽
    await advance(2000);
    expect(result.current.YaoShouInstance).not.toBeNull();
    expect(result.current.HuiheState.end).toBe(false);
  });

  it('过期会话的定时回调不得修改新会话的气血与实例', async () => {
    seedActor();
    const { result } = renderHook(() => useBattleHarness());

    // 会话 1：探索 → 开战 → 在首个回合回调前遁逃（800ms 后有延迟清理）
    act(() => {
      result.current.handleSearchYaoShou();
    });
    act(() => {
      result.current.handleStartZD();
    });
    act(() => {
      result.current.handleEscape();
    });
    await advance(200); // 遁逃的 800ms 清理回调尚未触发

    // 会话 2：立刻重新探索（不开战），新会话建立时旧延迟任务整体作废
    act(() => {
      result.current.handleSearchYaoShou();
    });
    expect(result.current.battleSessionId).toBe(2);
    const sessionTwoMonster = result.current.YaoShouInstance;
    const sessionTwoHp = sessionTwoMonster?.qixue;
    expect(sessionTwoMonster).not.toBeNull();

    // 跨过会话 1 遗留清理时间点（800ms）以及更久
    await advance(2000);

    expect(result.current.battleSessionId).toBe(2);
    expect(result.current.YaoShouInstance).not.toBeNull();
    expect(result.current.YaoShouInstance?.name).toBe(sessionTwoMonster?.name);
    // 新会话妖兽既没被旧回调清理，也没被旧回调扣血
    expect(result.current.YaoShouInstance?.qixue).toBe(sessionTwoHp);
    expect(result.current.HuiheState.end).toBe(false);
  });

  it('挂机中重复探索不会产生重复妖兽或重复奖励，整轮挂机只按真实结束的战斗计数', async () => {
    // 每场挂机战斗约 3s（探索→800ms 自动开战→1600ms 结算→下个调度边界再探索）
    seedActor({ shenshi: 5 });
    const { result } = renderHook(() => useBattleHarness());

    act(() => {
      result.current.setGuaji(true);
    });
    // 5 点神识探索 5 场，第 6 次调度时神识耗尽停止挂机；预留充足时间
    await advance(1500 * 12);

    expect(result.current.isGuaji).toBe(false);
    expect(result.current.get('shenshi')).toBe(0);
    expect(result.current.guajiStats.wins).toBe(5);
    expect(result.current.guajiStats.losses).toBe(0);
    expect(result.current.guajiStats.history).toHaveLength(5);
    expect(result.current.get('battleCount')).toBe(5);
    expect(result.current.get('winStreak')).toBe(5);

    // 每场胜利固定发 1 份材料 + 1 次灵石（升灵石为概率掉落，不计入重复奖励判断）
    const allNames = chuwuMocks.add.mock.calls.map((call) => call[0].name);
    expect(allNames.filter((n) => n !== '灵石' && n !== '升灵石')).toHaveLength(
      5
    );
    expect(allNames.filter((n) => n === '灵石')).toHaveLength(5);
    expect(allNames.filter((n) => n === '升灵石').length).toBeLessThanOrEqual(
      5
    );
    expect(chuwuMocks.add.mock.calls.length).toBeLessThanOrEqual(15);

    // 最后一场结束后实例被正常清理，没有残留妖兽
    expect(result.current.YaoShouInstance).toBeNull();
    expect(result.current.ActorInstance).toBeNull();
  });

  it('神识耗尽时先让当前战斗正常收尾再停止挂机，奖励与统计照常保留', async () => {
    // 仅剩 1 点神识：探索后即为 0，战斗仍须正常打完
    seedActor({ shenshi: 1 });
    const { result } = renderHook(() => useBattleHarness());

    act(() => {
      result.current.setGuaji(true);
    });
    await advance(300);
    expect(result.current.get('shenshi')).toBe(0);
    expect(result.current.isGuaji).toBe(true); // 战斗进行中不能提前停挂
    expect(result.current.YaoShouInstance).not.toBeNull();

    // 自动开战 + 回合推进直至胜利收尾，之后调度发现神识耗尽才停挂
    await advance(3000);

    expect(result.current.isGuaji).toBe(false);
    expect(result.current.guajiStats.wins).toBe(1);
    expect(result.current.guajiStats.history).toHaveLength(1);
    expect(result.current.get('battleCount')).toBe(1);
    const rewardCalls = chuwuMocks.add.mock.calls.map((call) => call[0].name);
    expect(rewardCalls.filter((n) => n === '灵石')).toHaveLength(1);
    expect(
      rewardCalls.filter((n) => n !== '灵石' && n !== '升灵石')
    ).toHaveLength(1);
  });

  it('失败不发放战利品，挂机统计记录败场且连胜清零', async () => {
    // 玩家极弱且速度低于妖兽，敌方先手，约 2400ms 后玩家倒下
    seedActor({
      qixue: 10,
      gongji: 1,
      fangyu: 0,
      sudu: 0,
      baoji: 0,
      fashu: 0
    });
    const { result } = renderHook(() => useBattleHarness());

    act(() => {
      result.current.setGuaji(true);
    });
    await advance(3000);

    expect(result.current.guajiStats.losses).toBe(1);
    expect(result.current.guajiStats.wins).toBe(0);
    expect(result.current.guajiStats.history[0]?.result).toBe('负');
    expect(chuwuMocks.add).not.toHaveBeenCalled();
    expect(result.current.get('battleCount')).toBe(1);
    expect(result.current.get('winStreak')).toBe(0);
    expect(result.current.isGuaji).toBe(true);

    // 败场约在 2400ms 结算；3000ms 调度边界挂机已开启干净的新一场
    expect(result.current.battleSessionId).toBe(2);
    expect(result.current.guajiStats.history[0]?.result).toBe('负');
    expect(result.current.HuiheState.huihe).toBe(0);
    expect(result.current.YaoShouInstance).not.toBeNull();
    expect(result.current.ActorInstance).not.toBeNull();
  });

  it('挂机历史不超过 50 条上限，日志不超过 100 条上限', async () => {
    seedActor({ shenshi: 60 });
    const { result } = renderHook(() => useBattleHarness());

    act(() => {
      result.current.setGuaji(true);
    });
    // 60 场 × 约 3s，末场结束后的下一个调度边界停挂
    await advance(1500 * 122);

    expect(result.current.get('shenshi')).toBe(0);
    expect(result.current.guajiStats.history).toHaveLength(50);
    expect(result.current.guajiStats.wins).toBe(60); // 计数不受上限影响
    expect(result.current.HuiheState.logs.length).toBeLessThanOrEqual(100);
  });

  it('手动探索后开启挂机：挂机接手进行中的会话，不重复探索、不重复扣神识', async () => {
    seedActor({ shenshi: 3 });
    const { result } = renderHook(() => useBattleHarness());

    // 手动探索一场（不手动开战），随后直接开挂机
    act(() => {
      result.current.handleSearchYaoShou();
    });
    expect(result.current.battleSessionId).toBe(1);
    const monsterName = result.current.YaoShouInstance?.name;
    expect(result.current.get('shenshi')).toBe(2);

    act(() => {
      result.current.setGuaji(true);
    });
    await advance(9000);

    // 挂机自动接手会话 1 并打赢，再探索会话 2、3；3 点神识全部用于真实战斗
    expect(result.current.guajiStats.wins).toBe(3);
    expect(result.current.get('shenshi')).toBe(0);
    expect(result.current.isGuaji).toBe(false);
    const foughtNames = result.current.guajiStats.history.map((h) => h.name);
    expect(foughtNames[0]).toBe(monsterName);
    expect(new Set(foughtNames).size).toBe(3);
  });

  it('组件卸载后所有定时器被清理，不再触发任何状态修改或奖励发放', async () => {
    seedActor();
    const { result, unmount } = renderHook(() => useBattleHarness());

    act(() => {
      result.current.setGuaji(true);
    });
    await advance(3000);
    const callsAtUnmount = chuwuMocks.add.mock.calls.length;
    expect(callsAtUnmount).toBeGreaterThan(0);

    unmount();
    // 卸载后推进任意长时间都不应有新的回调/奖励
    await advance(10000);
    expect(chuwuMocks.add).toHaveBeenCalledTimes(callsAtUnmount);
  });
});
