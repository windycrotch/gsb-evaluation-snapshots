<script setup lang="ts">
import { VideoPlayer } from '@vue-player/vue'
import { ref } from 'vue'

const testTracks = [
  {
    src: '/subtitles-en.vtt',
    label: 'English',
    language: 'en',
    kind: 'subtitles' as const,
    default: true,
  },
  {
    src: '/subtitles-ru.vtt',
    label: 'Русский',
    language: 'ru',
    kind: 'subtitles' as const,
  },
]

const sources = [
  {
    label: 'HLS (VOD)',
    src: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
  },
  {
    label: 'MP4',
    src: 'https://www.papytane.com/mp4/lessapin.mp4',
  },
  {
    label: 'Live HLS',
    src: 'http://sample.vodobox.com/skate_phantom_flex_4k/skate_phantom_flex_4k.m3u8',
  },
]

const testChapters = [
  { time: 0, label: 'Intro' },
  { time: 30, label: 'Act I' },
  { time: 90, label: 'Act II' },
  { time: 180, label: 'Act III' },
  { time: 300, label: 'Finale' },
]

const active = ref(sources[0])

// Thumbnail configuration options for manual verification.
// The HLS stream is ~635s long; the sample VTTs only cover the first
// 100 seconds on purpose, so hovering past the last cue exercises the
// "nearest valid frame" / hidden-preview boundary paths.
const thumbnailOptions = [
  {
    label: '关闭缩略图',
    url: '',
    hint: '无预览框，时间与章节提示照常显示',
  },
  {
    label: '远程单图（原有入口）',
    url: '/thumbnails.vtt',
    hint: '逐 cue 远程图片，跨源图片加载失败时显示「缩略图不可用」',
  },
  {
    label: '本地雪碧图 · 合法/非法混合',
    url: '/thumbnails-mixed.vtt',
    hint: '合法坐标裁切对应分块；非法/缺失坐标退化为整图；缺失图片显示失败提示',
  },
  {
    label: 'VTT 地址不可达',
    url: 'https://thumbnails.invalid/thumbnails.vtt',
    hint: '域名保留不可解析（或跨域被拦截）：fetch 失败，预览区隐藏，进度条与章节提示照常工作',
  },
  {
    label: 'VTT 内容为空',
    url: '/thumbnails-empty.vtt',
    hint: '返回空内容：预览区隐藏，播放与拖动不受影响',
  },
  {
    label: '全部片段非法',
    url: '/thumbnails-invalid.vtt',
    hint: '无任何可用 cue：预览区隐藏',
  },
  {
    label: '区间从 20s 开始（前段空白）',
    url: '/thumbnails-shifted.vtt',
    hint: '0–20s 落在首个片段之前：隐藏预览；进入区间后正常显示',
  },
]

const activeThumbnail = ref(thumbnailOptions[2])
</script>

<template>
  <div class="layout">
    <header class="header">
      <div class="header-inner">
        <span class="logo">
          <span class="logo-icon">▶</span>
          vue-player
        </span>
        <span class="badge">playground</span>
      </div>
    </header>

    <main class="main">
      <div class="player-section">
        <div class="player-wrap">
          <VideoPlayer
            :src="active.src"
            :chapters="testChapters"
            :tracks="testTracks"
            :thumbnails="activeThumbnail.url || undefined"
            :keyboard="true"
            @error="console.error('player error', $event)"
          />
        </div>

        <section class="card verify-card">
          <h3 class="card-title">手动验收要点</h3>
          <ul class="verify-list">
            <li>
              <strong>混合样例</strong>
              ：在进度条 0–30s 悬停，预览依次为雪碧图分块 1/2/3；30–60s 三段非法坐标均显示
              <strong>整张雪碧图</strong>
              而非错位裁切。
            </li>
            <li>
              60–70s 的图片不存在，预览区显示
              <strong>失败提示</strong>
              ，播放与拖动不中断。
            </li>
            <li>
              恰好悬停在 10s / 20s 等片段
              <strong>结束时刻</strong>
              时，命中下一个片段。
            </li>
            <li>
              100s 之后（视频约 635s）无缩略图区间，预览回退到
              <strong>最近有效片段</strong>
              （分块 8），不出现越界空白。
            </li>
            <li>
              切换到 VTT 不可达 / 空内容 / 全非法后，
              <strong>预览区隐藏</strong>
              ，时间与章节提示、拖动照常工作。
            </li>
          </ul>
        </section>
      </div>

      <aside class="sidebar">
        <section class="card">
          <h3 class="card-title">Source</h3>
          <div class="source-list">
            <button
              v-for="s in sources"
              :key="s.src"
              class="source-btn"
              :class="{ active: active.src === s.src }"
              @click="active = s"
            >
              {{ s.label }}
            </button>
          </div>
        </section>

        <section class="card">
          <h3 class="card-title">Thumbnails</h3>
          <div class="source-list">
            <button
              v-for="opt in thumbnailOptions"
              :key="opt.url || 'none'"
              class="source-btn"
              :class="{ active: activeThumbnail.label === opt.label }"
              @click="activeThumbnail = opt"
            >
              {{ opt.label }}
            </button>
          </div>
          <p class="card-hint">{{ activeThumbnail.hint }}</p>
        </section>

        <section class="card">
          <h3 class="card-title">Theme tokens</h3>
          <p class="card-hint">
            Override CSS variables on
            <code>.vp-player</code>
            to customise the player.
          </p>
          <code class="code-block">
            .my-player {
            <br />
            &nbsp;&nbsp;--vp-primary: #ff6b6b;
            <br />
            &nbsp;&nbsp;--vp-radius: 0px;
            <br />
            }
          </code>
        </section>
      </aside>
    </main>
  </div>
</template>

<style>
/* ─── Reset ─── */
*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

/* ─── Base ─── */
:root {
  --pg-bg: #0b0b0f;
  --pg-surface: #111118;
  --pg-border: rgba(255, 255, 255, 0.07);
  --pg-text-1: #efefef;
  --pg-text-2: rgba(255, 255, 255, 0.5);
  --pg-text-3: rgba(255, 255, 255, 0.28);
  --pg-accent: #3dd68c;
  --pg-radius: 12px;
  --pg-font: ui-sans-serif, system-ui, -apple-system, sans-serif;
}

body {
  background: var(--pg-bg);
  color: var(--pg-text-1);
  font-family: var(--pg-font);
  font-size: 14px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

/* ─── Header ─── */
.header {
  position: sticky;
  top: 0;
  z-index: 50;
  border-bottom: 1px solid var(--pg-border);
  background: rgba(11, 11, 15, 0.8);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

.header-inner {
  max-width: 1200px;
  margin: 0 auto;
  padding: 0 24px;
  height: 56px;
  display: flex;
  align-items: center;
  gap: 12px;
}

.logo {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--pg-text-1);
}

.logo-icon {
  color: var(--pg-accent);
  font-size: 12px;
}

.badge {
  padding: 2px 8px;
  background: rgba(61, 214, 140, 0.12);
  color: var(--pg-accent);
  border: 1px solid rgba(61, 214, 140, 0.2);
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
}

/* ─── Layout ─── */
.main {
  max-width: 1200px;
  margin: 0 auto;
  padding: 40px 24px;
  display: grid;
  grid-template-columns: 1fr 280px;
  gap: 32px;
  align-items: start;
}

@media (max-width: 800px) {
  .main {
    grid-template-columns: 1fr;
  }
}

/* ─── Player ─── */
.player-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.player-wrap {
  width: 100%;
  border-radius: var(--pg-radius);
  overflow: hidden;
  box-shadow:
    0 0 0 1px var(--pg-border),
    0 24px 64px rgba(0, 0, 0, 0.6);
}

/* ─── Sidebar ─── */
.sidebar {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ─── Card ─── */
.card {
  background: var(--pg-surface);
  border: 1px solid var(--pg-border);
  border-radius: var(--pg-radius);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.card-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--pg-text-3);
}

.card-hint {
  font-size: 13px;
  color: var(--pg-text-2);
  line-height: 1.5;
}

.card-hint code {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 5px;
  border-radius: 4px;
}

/* ─── Source buttons ─── */
.source-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.source-btn {
  display: block;
  width: 100%;
  padding: 9px 12px;
  background: none;
  border: 1px solid var(--pg-border);
  border-radius: 8px;
  color: var(--pg-text-2);
  font-size: 13px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    color 0.15s ease,
    background 0.15s ease;
}

.source-btn:hover {
  border-color: rgba(255, 255, 255, 0.16);
  color: var(--pg-text-1);
}

.source-btn.active {
  border-color: rgba(61, 214, 140, 0.4);
  background: rgba(61, 214, 140, 0.08);
  color: var(--pg-accent);
}

/* ─── Verification checklist ─── */
.verify-card {
  gap: 10px;
}

.verify-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-left: 18px;
  color: var(--pg-text-2);
  font-size: 13px;
  line-height: 1.6;
}

.verify-list strong {
  color: var(--pg-text-1);
  font-weight: 600;
}

/* ─── Code block ─── */
.code-block {
  display: block;
  font-family: ui-monospace, monospace;
  font-size: 12px;
  line-height: 1.7;
  color: var(--pg-text-2);
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--pg-border);
  border-radius: 8px;
  padding: 12px 14px;
}
</style>
