const CONFIG = {
  STORAGE_KEYS: {
    RECENT: "recentVideos",
    WATCH_TIME: "watchTime",
    VOLUME: "volume",
    MUTED: "muted",
  },

  LIMITS: {
    RECENT_SIZE: 30,
    SKIP_THRESHOLD: 60,
    TITLE_MAX_LENGTH: 24,
    RECENT_TITLE_RATIO: 11,
    COMPLETED_PERCENT: 97,
    VOLUME_STEP: 0.1,
  },

  FILES: {
    EXPORT_DEFAULT_NAME: "neovid-recent.json",
    EXPORT_TYPE: "application/json"
  },

  MESSAGES: {
    CONFIRM_REMOVE: "Are you sure you want to remove this video?",
    CONFIRM_REMOVE_ALL: "Are you sure you want to remove all videos? This action cannot be undone.",
    CONFIRM_RESET_WATCH_TIME: "Reset total watch time?",
    EXPORT_EMPTY: "No recent data to export.",
    IMPORT_CONFIRM: "Importing will REPLACE current recent data.\nThis action is NOT reversible.\n\nContinue?",
    IMPORT_SUCCESS: "Recent data imported successfully.",
    IMPORT_ERROR: "Invalid recent data file.",
    WATCH_LATER_ADDED: "Video added to list.",
    SELECT_VIDEO: "Please enter a video URL.",
    SELECT_LOCAL_VIDEO: "Please select a local video file.",
    RESELECT_LOCAL_VIDEO: "Please reselect the local video to resume playback.",
    RESELECT_LOCAL_SUBTITLE: "Please reselect the local subtitle file.",
    REOPEN_LOCAL_ERROR: "The local file could not be opened. Please try again.",
    UPDATE_AVAILABLE: "A new version is available. Reload now?"
  },

};


const DOM = {
  form: document.getElementById("video-form"),
  videoUrl: document.getElementById("video-url"),
  videoFile: document.getElementById("video-file"),
  videoLoadSelect: document.getElementById("video-load-type"),
  watchLaterButton: document.getElementById("watch-later-button"),
  resumeButton: document.getElementById("resume-button"),
  downloadVideoButton: document.getElementById("download-video-button"),
  downloadSubtitleButton: document.getElementById("download-subtitle-button"),
  skipButton: document.getElementById("skip-button"),
  exportButton: document.getElementById("export-button"),
  importButton: document.getElementById("import-button"),
  installButton: document.getElementById("install-button"),
  closeInstallButton: document.getElementById("close-install"),
  installBanner: document.getElementById("install-banner"),
  recentFile: document.getElementById("recent-file"),
  removeAllButton: document.getElementById("remove-all-button"),
  recentNotice: document.getElementById("recent-notice"),
  subtitleUrl: document.getElementById("subtitle-url"),
  subtitleFile: document.getElementById("subtitle-file"),
  subtitleLoadSelect: document.getElementById("subtitle-load-type"),
  player: document.getElementById("video-player"),
  recentItems: document.getElementById("recent-items"),
  watchTime: document.getElementById("watch-time"),
  resetWatchTimeButton: document.getElementById("reset-watch-time-button"),
}

function createTag(className, icon) {
  const tag = document.createElement("span");
  tag.className = className;
  tag.innerHTML = icon;
  return tag;
}

function showAlert(text, options = {}) {
  return Swal.fire({
    icon: options.icon || "info",
    text,
    confirmButtonText: options.confirmText || "OK",
  });
}

function showConfirm(text, options = {}) {
  return Swal.fire({
    icon: options.icon || "warning",
    text,
    showCancelButton: true,
    confirmButtonText: options.confirmText || "OK",
    cancelButtonText: options.cancelText || "Cancel"
  });
}

function showPrompt(title, defaultValue = "", options = {}) {
  return Swal.fire({
    title,
    input: "text",
    inputValue: defaultValue,
    showCancelButton: true,
    confirmButtonText: options.confirmText || "OK",
    cancelButtonText: options.cancelText || "Cancel"
  });
}

function getRecent() {
  let parsed = [];
  try {
    parsed = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.RECENT) || "[]");
  } catch {
    parsed = [];
  }
  if (!Array.isArray(parsed)) return [];
  // Normalize defensively: corrupted/legacy rows are dropped instead of
  // breaking rendering, and internal handle-key fields are merged back from
  // the raw row so IndexedDB lookups keep working.
  return parsed
    .map(raw => {
      const item = RecentStore.normalizeRecentItem(raw);
      if (!item) return null;
      return { ...item, ...preserveHandleFields(raw) };
    })
    .filter(Boolean);
}

// Normalization strips internal handle-key fields; copy them back when the
// raw row actually contains usable string keys.
function preserveHandleFields(raw) {
  const preserved = {};
  if (!raw || typeof raw !== "object") return preserved;
  Object.values(RecentStore.HANDLE_KEYS).forEach(key => {
    if (typeof raw[key] === "string" && raw[key]) {
      preserved[key] = raw[key];
    }
  });
  return preserved;
}

function setRecent(data) {
  localStorage.setItem(CONFIG.STORAGE_KEYS.RECENT, JSON.stringify(data));
}

function getWatchTime() {
  return parseInt(localStorage.getItem(CONFIG.STORAGE_KEYS.WATCH_TIME) || "0", 10);
}

function setWatchTime(value) {
  localStorage.setItem(CONFIG.STORAGE_KEYS.WATCH_TIME, value);
}

function getVolume() {
  const volume = parseFloat(
    localStorage.getItem(CONFIG.STORAGE_KEYS.VOLUME)
  );

  if (!Number.isFinite(volume)) {
    return 1;
  }

  return Math.max(0, Math.min(1, volume));
}

function setVolume(value) {
  const volume = Number(value);

  if (!Number.isFinite(volume)) {
    return;
  }

  localStorage.setItem(CONFIG.STORAGE_KEYS.VOLUME, Math.max(0, Math.min(1, volume)));
}

function getMuted() {
  return localStorage.getItem(CONFIG.STORAGE_KEYS.MUTED) === "true";
}

function setMuted(value) {
  localStorage.setItem(CONFIG.STORAGE_KEYS.MUTED, Boolean(value));
}

function restoreAudioSettings() {
  DOM.player.volume = getVolume();
  DOM.player.muted = getMuted();
}

const state = {
  currentVideo: null,
  currentVideoType: "url",
  currentSubtitle: "",
  currentSubtitleType: "url",
  currentTitle: "",
  videoLastTime: null,
  totalWatchTime: getWatchTime(),
  accumulatedWatchTime: 0
}

function formatTime(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return (
    String(hours).padStart(2, "0") + ":" +
    String(minutes).padStart(2, "0") + ":" +
    String(seconds).padStart(2, "0")
  );
}

function downloadFile(src) {
  const a = document.createElement("a");
  a.href = src;
  a.target = "_blank";
  a.rel = "noopener";
  a.click();
}

function updateDownloadButtons() {
  if (!state.currentVideo || state.currentVideoType === "local") {
    DOM.downloadVideoButton.disabled = true;
  } else {
    DOM.downloadVideoButton.disabled = false;
  }

  if (!state.currentSubtitle || state.currentSubtitleType === "local") {
    DOM.downloadSubtitleButton.disabled = true;
  } else {
    DOM.downloadSubtitleButton.disabled = false;
  }
}

function updateResumeButton() {
  DOM.resumeButton.disabled = getRecent().length === 0;
}

function updateWatchTime() {
  const videoCurrentTime = DOM.player.currentTime;
  if (state.videoLastTime !== null) {
    const diff = videoCurrentTime - state.videoLastTime;
    if (diff > 0 && diff < 5) {
      state.accumulatedWatchTime += diff;
      while (state.accumulatedWatchTime >= 1) {
        state.totalWatchTime += 1;
        state.accumulatedWatchTime -= 1;
        setWatchTime(state.totalWatchTime);
        DOM.watchTime.textContent = formatTime(state.totalWatchTime);
        
      }
    }
  }
  state.videoLastTime = videoCurrentTime;
}

function handleSkipButton() {
  if (DOM.player.duration && DOM.player.currentTime) {
    const remaining = DOM.player.duration - DOM.player.currentTime;
    if (DOM.player.duration > 3 * CONFIG.LIMITS.SKIP_THRESHOLD && remaining <= CONFIG.LIMITS.SKIP_THRESHOLD && !DOM.player.ended) {
      DOM.skipButton.style.display = "block";
    } else {
      DOM.skipButton.style.display = "none";
    }
  }   
}

function getProgressBackground(progress) {
  const p = Math.max(0, Math.min(progress, 100));
  return  `linear-gradient(to right, #c3fcc3, #41fc41) 0 0 / ${p}% 100% no-repeat`;
}

function loadFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const videoUrlQuery = params.get("video");
  const subtitleUrlQuery = params.get("subtitle");
  if (videoUrlQuery) {
    DOM.videoUrl.value = videoUrlQuery;
  }
  if (subtitleUrlQuery) {
    DOM.subtitleUrl.value = subtitleUrlQuery;
  }
}

function truncateTitle(title, maxLength = CONFIG.LIMITS.TITLE_MAX_LENGTH) {
  if (!title) return "";
  return title.length > maxLength ? title.slice(0, maxLength - 3) + "..." : title;
}

function playVideo(video, subtitle = "", title = null, videoType = "url", subtitleType = "url") {
  revokeCurrentMedia();
  DOM.player.innerHTML = "";

  const sourceElement = document.createElement("source");
  sourceElement.src = video;
  DOM.player.appendChild(sourceElement);

  if(subtitle) {
    const track = document.createElement("track");
    track.src = subtitle;
    track.kind = "subtitles";
    track.srclang = "en";
    track.label = "English";
    track.default = true;
    DOM.player.appendChild(track);
    DOM.player.textTracks[0].mode = "showing";
  }

  DOM.player.load();
  DOM.player.play().catch(() => {});

  state.currentVideo = video;
  state.currentVideoType = videoType;
  state.currentTitle = title || (videoType==="url"? video.split("/").pop(): title);
  state.currentSubtitle = subtitle;
  state.currentSubtitleType = subtitleType;
  updateDownloadButtons();
}


function saveRecent(title, video, videoType, subtitle = "", subtitleType = "url", extra = null) {
  const recent = getRecent();
  const entry = {
    title,
    video,
    videoType,
    subtitle,
    subtitleType,
    progress: 0,
  };
  if (extra && typeof extra === "object") {
    Object.assign(entry, extra);
  }
  // Same title -> replace reference, preserve saved progress, move to front,
  // keep the 30-entry cap and most-recent-first ordering.
  setRecent(RecentStore.upsertRecent(recent, entry));
  renderRecent();
}

function removeRecent(title) {
  showConfirm(CONFIG.MESSAGES.CONFIRM_REMOVE, {
    confirmText: "Remove"
  }).then((result) => {
      if (result.isConfirmed) {
        const recent = getRecent();
        const removed = recent.find(item => item.title === title);
        if (removed) {
          FsHandles.deleteHandle(removed[RecentStore.HANDLE_KEYS.VIDEO]);
          FsHandles.deleteHandle(removed[RecentStore.HANDLE_KEYS.SUBTITLE]);
        }
        setRecent(recent.filter(item => !(item.title === title)));
        renderRecent();
      }
    });
}

function removeAllVideos() {
  showConfirm(CONFIG.MESSAGES.CONFIRM_REMOVE_ALL)
  .then(result => {
    if (result.isConfirmed) {
      getRecent().forEach(item => {
        FsHandles.deleteHandle(item[RecentStore.HANDLE_KEYS.VIDEO]);
        FsHandles.deleteHandle(item[RecentStore.HANDLE_KEYS.SUBTITLE]);
      });
      setRecent([]);
      renderRecent();
    }
  });
}

function updateProgress() {
  if(!state.currentVideo || !DOM.player.duration) return;
  const percent = RecentStore.calculateProgress(DOM.player.currentTime, DOM.player.duration);
  let recent = getRecent();
  const idx = recent.findIndex(item => item.video===state.currentVideo);
  if(idx!==-1) {
    recent[idx].progress = percent;
    setRecent(recent);
    renderRecent();
  }
}

function loadPlayerTime() {
  if(!state.currentVideo || !DOM.player.duration) return;
  let recent = getRecent();
  const idx = recent.findIndex(item => item.video===state.currentVideo);
  if(idx!==-1) {
    // Keep the original percentage-based resume logic.
    const currentTime = (recent[idx].progress / 100) * DOM.player.duration
    DOM.player.currentTime = currentTime;

  }
}

function createRecentItem(item, maxLimit) {
  const li = document.createElement("li");
  const spanTitle = document.createElement("span");
  const spanRemove = document.createElement("span");
  li.style.background = getProgressBackground(item.progress);
  spanTitle.textContent = truncateTitle(item.title, maxLimit);
  spanTitle.className = "recent-title";
  spanRemove.innerHTML = '<i class="fa-solid fa-trash"></i>';
  spanRemove.className = "recent-remove";
  if(item.videoType==="url") {
    spanTitle.appendChild(createTag("url-tag", '<i class="fa-solid fa-globe"></i>'));
  }
  if(item.videoType==="local") {
    spanTitle.appendChild(createTag("local-tag", '<i class="fa-solid fa-hard-drive"></i>'));
  }
  if(item.subtitle && item.subtitleType==="local") {
    spanTitle.appendChild(createTag("local-tag", '<i class="fa-regular fa-file-lines"></i>'));
  }
  if(item.subtitle && item.subtitleType==="url") {
    spanTitle.appendChild(createTag("url-tag", '<i class="fa-solid fa-closed-captioning"></i>'));
  }
  const spanProgress = document.createElement("span");
  spanProgress.className="recent-progress";
  spanProgress.textContent = `${item.progress||0}%`;

  if(item.progress>=CONFIG.LIMITS.COMPLETED_PERCENT) {
    spanProgress.innerHTML = '<i class="fa-solid fa-check"></i>';
  }

  li.appendChild(spanRemove);
  li.appendChild(spanTitle);
  li.appendChild(spanProgress);

  return { li, spanTitle, spanRemove };
}

function attachRecentEvents(item, spanTitle, spanRemove) {
  spanRemove.addEventListener("click", () => {
    removeRecent(item.title);
  });

  spanTitle.addEventListener("click", () => {
    if (item.videoType === "local") {
      // Reopen via the stored File System handle when the browser supports
      // it, otherwise guide the user through re-picking the file and then
      // resume with the original progress/subtitle instead of just alerting.
      reselectLocalEntry(item);
      return;
    }

    DOM.videoUrl.value = item.video;
    if (item.subtitle) {
      if (item.subtitleType === "url") {
        DOM.subtitleUrl.value = item.subtitle;
      } else {
        // URL video with a local subtitle: only the subtitle needs re-picking.
        DOM.subtitleUrl.value = "";
        showAlert(CONFIG.MESSAGES.RESELECT_LOCAL_SUBTITLE, { icon: "info" });
      }
    }
    DOM.form.scrollIntoView({ behavior: "smooth" });
  });
}


function renderRecent() {
  const recent = getRecent();
  DOM.recentItems.innerHTML="";
  let maxLimit = DOM.recentItems.offsetWidth  / CONFIG.LIMITS.RECENT_TITLE_RATIO;
  recent.forEach(item => {
    const { li, spanTitle, spanRemove } = createRecentItem(item, maxLimit);
    attachRecentEvents(item, spanTitle, spanRemove);
    DOM.recentItems.appendChild(li);
  });

  DOM.exportButton.style.display = recent.length ? "inline-block" : "none";
  DOM.recentNotice.style.display = recent.length ? "block" : "none";
  DOM.removeAllButton.style.display = recent.length ? "inline-block" : "none";
  updateResumeButton()
}

function getFormData() {
  let videoSrc = "", videoTitle = "", videoType = DOM.videoLoadSelect.value;
  if(videoType==="url") {
    const url = DOM.videoUrl.value.trim();
    if(!url) {
      showAlert(CONFIG.MESSAGES.SELECT_VIDEO, {icon: "warning"});
      return;
    }
    videoSrc = url;
    videoTitle = url.split("/").pop();
  } else {
    const file = DOM.videoFile.files[0];
    if(!file) {
      showAlert(CONFIG.MESSAGES.SELECT_LOCAL_VIDEO, {icon: "warning"});
      return;
    }
    videoSrc = URL.createObjectURL(file);
    videoTitle = file.name;
  }


  let subtitleSrc = "", subtitleType = DOM.subtitleLoadSelect.value;
  if(subtitleType==="url") {
    subtitleSrc = DOM.subtitleUrl.value.trim();
  } else {
    const subtitleFile = DOM.subtitleFile.files[0];
    if(subtitleFile) subtitleSrc = URL.createObjectURL(subtitleFile);
  }
  return {
    videoSrc,
    videoTitle,
    videoType,
    subtitleSrc,
    subtitleType
  };
}

function revokeCurrentMedia() {
  if (state.currentVideoType === "local" && state.currentVideo) {
    URL.revokeObjectURL(state.currentVideo);
  }

  if (state.currentSubtitleType === "local" && state.currentSubtitle) {
    URL.revokeObjectURL(state.currentSubtitle);
  }
}

/* ------------------------------------------------------------------ */
/* Local file reopening: File System Access handles + manual fallback */
/* ------------------------------------------------------------------ */

function supportsFileSystemAccess() {
  return (
    typeof window !== "undefined" &&
    typeof window.showOpenFilePicker === "function" &&
    typeof window.FileSystemFileHandle !== "undefined" &&
    FsHandles.isAvailable()
  );
}

async function queryHandlePermission(handle) {
  if (!handle.queryPermission) return "prompt";
  try {
    return await handle.queryPermission({ mode: "read" });
  } catch {
    return "prompt";
  }
}

async function requestHandlePermission(handle) {
  if (!handle.requestPermission) return "denied";
  try {
    return await handle.requestPermission({ mode: "read" });
  } catch {
    return "denied";
  }
}

async function showFileSystemPicker(options) {
  const pickerTypes =
    options.kind === "subtitle"
      ? [{ description: "Subtitles", accept: { "text/vtt": [".vtt"], "application/x-subrip": [".srt"] } }]
      : [{ description: "Videos", accept: { "video/*": [] } }];

  const [handle] = await window.showOpenFilePicker({
    types: pickerTypes,
    excludeAcceptAllOption: false,
    id: options.id,
  });
  if (!handle) return null;
  const file = await handle.getFile();
  // Surface the handle on the file so the caller can persist it without
  // a second getFile() round trip.
  try {
    Object.defineProperty(file, "handle", { value: handle, configurable: true });
  } catch {
    /* Non-writable file object: handle is simply unavailable. */
  }
  return file;
}

// Fallback used when the File System Access API is unavailable: a plain
// <input type="file"> picker. Resolves null when the user cancels.
function showInputFilePicker(options) {
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = options.kind === "subtitle" ? ".vtt,.srt" : "video/*";
    input.style.display = "none";

    let settled = false;
    const cleanup = () => {
      window.setTimeout(() => input.remove(), 0);
      document.removeEventListener("focus", onFocus, true);
    };
    const finish = file => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(file || null);
    };
    // Cancelling a native file dialog fires no "change" event; the window
    // regaining focus is the signal that no file was selected.
    const onFocus = () => window.setTimeout(() => {
      if (!settled && input.files.length === 0) finish(null);
    }, 300);

    input.addEventListener("change", () => finish(input.files[0] || null), { once: true });
    document.addEventListener("focus", onFocus, true);
    document.body.appendChild(input);
    input.click();
  });
}

// Services object consumed by RecentStore.resolveLocalEntry().
const localFileServices = {
  supportsFsAccess: supportsFileSystemAccess,
  getHandle: key => FsHandles.getHandle(key),
  queryPermission: queryHandlePermission,
  requestPermission: requestHandlePermission,
  openPicker: options =>
    supportsFileSystemAccess()
      ? showFileSystemPicker(options)
      : showInputFilePicker(options),
  notify: kind => {
    if (kind === "subtitle") {
      showAlert(CONFIG.MESSAGES.RESELECT_LOCAL_SUBTITLE, { icon: "info" });
    } else {
      showAlert(CONFIG.MESSAGES.RESELECT_LOCAL_VIDEO, { icon: "info" });
    }
  },
};

// Re-open a local recent entry: stored handle first (when supported),
// otherwise guide the user through re-picking the file(s), then resume
// playback with the original record's progress and subtitle.
async function reselectLocalEntry(item) {
  try {
    const resolved = await RecentStore.resolveLocalEntry(item, localFileServices);
    if (!resolved || !resolved.video) return;

    const videoFile = resolved.video.file;
    const subtitleFile = resolved.subtitle ? resolved.subtitle.file : null;

    const videoUrl = URL.createObjectURL(videoFile);
    const subtitleUrl = subtitleFile ? URL.createObjectURL(subtitleFile) : "";

    // Persist handles when the picker produced new ones; keys are derived
    // from the (unique) title and never written into exported JSON.
    const handleKeys = {};
    const videoHandleKey = RecentStore.handleKeyFor(item.title, "video");
    const videoHandle =
      resolved.video.handle ||
      (supportsFileSystemAccess() && videoFile && videoFile.handle) ||
      null;
    if (videoHandle) {
      await FsHandles.saveHandle(videoHandleKey, videoHandle);
      handleKeys.video = videoHandleKey;
    }

    if (subtitleFile) {
      const subtitleHandleKey = RecentStore.handleKeyFor(item.title, "subtitle");
      const subtitleHandle =
        (resolved.subtitle && resolved.subtitle.handle) ||
        (supportsFileSystemAccess() && subtitleFile.handle) ||
        null;
      if (subtitleHandle) {
        await FsHandles.saveHandle(subtitleHandleKey, subtitleHandle);
        handleKeys.subtitle = subtitleHandleKey;
      }
    }

    const record = RecentStore.buildResolvedRecord(
      item,
      { videoUrl, subtitleUrl },
      handleKeys
    );

    // Same-title entry is replaced by the fresh, usable reference and moved
    // to the front; the 30-entry cap and ordering remain enforced.
    setRecent(RecentStore.upsertRecent(getRecent(), record));
    renderRecent();

    DOM.videoLoadSelect.value = "local";
    DOM.videoUrl.style.display = "none";
    DOM.videoFile.style.display = "block";
    if (record.subtitle && record.subtitleType === "local") {
      DOM.subtitleLoadSelect.value = "local";
      DOM.subtitleUrl.style.display = "none";
      DOM.subtitleFile.style.display = "block";
    }

    playVideo(
      record.video,
      record.subtitle,
      record.title,
      "local",
      record.subtitle ? record.subtitleType : "url"
    );
    // loadedmetadata -> loadPlayerTime() restores the saved percentage.
  } catch (error) {
    showAlert(CONFIG.MESSAGES.REOPEN_LOCAL_ERROR, { icon: "error" });
  }
}



DOM.videoLoadSelect.addEventListener("change", () => {
  const isLocal = DOM.videoLoadSelect.value === "local";
  DOM.videoUrl.style.display = isLocal ? "none" : "block";
  DOM.videoFile.style.display = isLocal ? "block" : "none";
});

DOM.subtitleLoadSelect.addEventListener("change", () => {
  const isLocal = DOM.subtitleLoadSelect.value === "local";
  DOM.subtitleUrl.style.display = isLocal ? "none" : "block";
  DOM.subtitleFile.style.display = isLocal ? "block" : "none";
});


DOM.form.addEventListener("submit", function(e) {
  e.preventDefault();
  const data = getFormData();
  if (!data) return;
  playVideo(data.videoSrc, data.subtitleSrc, data.videoTitle, data.videoType, data.subtitleType);
  saveRecent(data.videoTitle, data.videoSrc, data.videoType, data.subtitleSrc, data.subtitleType);
});

DOM.watchLaterButton.addEventListener("click", () => {
  const data = getFormData();
  if (!data) return;
  saveRecent(
    data.videoTitle,
    data.videoSrc,
    data.videoType,
    data.subtitleSrc,
    data.subtitleType
  );
  showAlert(CONFIG.MESSAGES.WATCH_LATER_ADDED, {icon: "success"});
});

DOM.player.addEventListener("timeupdate", () => {
  updateProgress();
  updateWatchTime();
  handleSkipButton();
});
DOM.player.addEventListener("loadedmetadata", loadPlayerTime);
window.addEventListener("DOMContentLoaded", () => {
  DOM.watchTime.textContent = formatTime(state.totalWatchTime);
  loadFromQuery();
  renderRecent();
  updateDownloadButtons();
  updateResumeButton();
  restoreAudioSettings();
});
DOM.player.addEventListener("ended", () => {
  DOM.skipButton.style.display = "none";
});
DOM.player.addEventListener("volumechange", () => {
  setVolume(DOM.player.volume);
  setMuted(DOM.player.muted);
});
DOM.skipButton.addEventListener("click", () => {
  DOM.player.currentTime = Math.max(DOM.player.duration - 0.1, 0);
  DOM.skipButton.style.display = "none";
});
DOM.exportButton.addEventListener("click", () => {
  const data = RecentStore.serializeRecent(getRecent());
  if (!data.length) {
    showAlert(CONFIG.MESSAGES.EXPORT_EMPTY, {icon: "info"});
    return;
  }
  showPrompt(
    "File Name",
    CONFIG.FILES.EXPORT_DEFAULT_NAME,
    {
      confirmText: "Export"
    }
  ).then((result) => {

    if (!result.isConfirmed) return;

    let fileName = (result.value || CONFIG.FILES.EXPORT_DEFAULT_NAME)
    .trim()
    .replaceAll(" ", "-");

  if (!fileName) {
    fileName = CONFIG.FILES.EXPORT_DEFAULT_NAME;
  }
  // serializeRecent() guarantees plain JSON-safe objects: no
  // FileSystemFileHandle or internal handle key can reach the file.
  const blob = new Blob([JSON.stringify(data)], { type: CONFIG.FILES.EXPORT_TYPE });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(a.href);
  });
});

DOM.importButton.addEventListener("click", () => {
  let recent = getRecent();
  if (recent.length > 0) {
    showConfirm(CONFIG.MESSAGES.IMPORT_CONFIRM, {
      confirmText: "Import"
      }).then((result) => {
        if (result.isConfirmed) {
          DOM.recentFile.click();
        }
      });
  }
  else {
    DOM.recentFile.click();
  }
  
});
DOM.recentFile.addEventListener("change", () => {
  const file = DOM.recentFile.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      // Local entries without handles are accepted: invalid rows are
      // dropped individually, so one bad/local row can no longer reject
      // the whole import or erase the other records.
      const normalized = RecentStore.normalizeImportedRecords(parsed);
      if (!Array.isArray(parsed) || normalized.length === 0) throw new Error();
      setRecent(normalized);
      renderRecent();
      showAlert(CONFIG.MESSAGES.IMPORT_SUCCESS, {icon: "success"});
    } catch {
      showAlert(CONFIG.MESSAGES.IMPORT_ERROR, {icon: "error"});
    }
    DOM.recentFile.value = "";
  };
  reader.readAsText(file);
});
window.addEventListener("resize", () => {
  renderRecent();
});

function showUpdateAlert(registration) {
  if (!registration.waiting) return;
  showConfirm(CONFIG.MESSAGES.UPDATE_AVAILABLE, {
    icon: "info",
    confirmText: "Reload"
  }).then((result) => {
    if (result.isConfirmed) {
      registration.waiting.postMessage({ type: "SKIP_WAITING" });
    }
  });
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    const reg = await navigator.serviceWorker.register("service-worker.js");

    if (reg.waiting) {
      showUpdateAlert(reg);
    }

    reg.addEventListener("updatefound", () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener("statechange", () => {
        if (sw.state === "installed" && navigator.serviceWorker.controller && reg.waiting) {
          showUpdateAlert(reg);
        }
      });
    });

    if (navigator.serviceWorker.controller) {
        let refreshing = false;
        navigator.serviceWorker.addEventListener("controllerchange", () => {
            if (!refreshing) {
                refreshing = true;
                window.location.reload();
            }
        });
    }
  });
}


let deferredPrompt = null;
let isInstalled = false;



window.addEventListener("appinstalled", () => {
  isInstalled = true;
  deferredPrompt = null;
  DOM.installBanner.style.display = "none";
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();

  deferredPrompt = event;

  if (!isInstalled) {
    DOM.installBanner.style.display = "block";
  }
});

DOM.installButton.addEventListener("click", async () => {
  if (!deferredPrompt) return;

  deferredPrompt.prompt();

  const { outcome } = await deferredPrompt.userChoice;

  deferredPrompt = null;
  DOM.installBanner.style.display = "none";
});

DOM.closeInstallButton.addEventListener("click", () => {
  DOM.installBanner.style.display = "none";
});

DOM.downloadVideoButton.addEventListener("click", () => {
  if (!state.currentVideo || state.currentVideoType !== "url") return;
  downloadFile(state.currentVideo);
});

DOM.downloadSubtitleButton.addEventListener("click", () => {
  if (!state.currentSubtitle || state.currentSubtitleType !== "url") return;
  downloadFile(state.currentSubtitle);
});

DOM.removeAllButton.addEventListener("click", removeAllVideos);

DOM.resumeButton.addEventListener("click", () => {
  const recent = getRecent();
  if (!recent.length) {
    return;
  }
  const item = recent[0];
  if (item.videoType !== "url") {
    reselectLocalEntry(item);
    return;
  }
  DOM.videoUrl.value = item.video;
  DOM.subtitleUrl.value = item.subtitle || "";
  DOM.form.requestSubmit();
});

DOM.resetWatchTimeButton.addEventListener("click", () => {
  showConfirm(CONFIG.MESSAGES.CONFIRM_RESET_WATCH_TIME)
  .then(result => {
    if (!result.isConfirmed) return;
    state.totalWatchTime = 0;
    state.accumulatedWatchTime = 0;
    setWatchTime(0);
    DOM.watchTime.textContent = formatTime(0);
  });
});

document.addEventListener("keydown", (event) => {
  if (event.target.tagName === "INPUT" ||
      event.target.tagName === "SELECT") {
    return;
  }

  switch(event.code){
    case "Space":
      event.preventDefault();
      if (DOM.player.paused) {
        DOM.player.play();
      } else {
        DOM.player.pause();
      }
      break;

    case "ArrowLeft":
      DOM.player.currentTime =
        Math.max(0, DOM.player.currentTime - 10);
      break;

    case "ArrowRight":
      DOM.player.currentTime =
        Math.min(
          DOM.player.duration,
          DOM.player.currentTime + 10
        );
      break;
    
    case "ArrowUp":
      event.preventDefault();
      DOM.player.muted = false;
      DOM.player.volume = Math.min(1, DOM.player.volume + CONFIG.LIMITS.VOLUME_STEP);
      break;

    case "ArrowDown":
      event.preventDefault();
      DOM.player.muted = false;
      DOM.player.volume = Math.max(0, DOM.player.volume - CONFIG.LIMITS.VOLUME_STEP);
      break;
    
    case "KeyM":
      DOM.player.muted = !DOM.player.muted;
      break;
    
    case "KeyF":
      if (!document.fullscreenElement) {
        DOM.player.requestFullscreen?.();
      } else {
        document.exitFullscreen?.();
      }
      break;
    
    case "KeyP":
      if (document.pictureInPictureEnabled && !DOM.player.disablePictureInPicture) {
        if (document.pictureInPictureElement) {
          document.exitPictureInPicture().catch(() => {});
        } else {
          DOM.player.requestPictureInPicture().catch(() => {});
        }
      }
      break;

    case "End":
      event.preventDefault();
      if (DOM.player.duration) {
        DOM.player.currentTime = DOM.player.duration;
      }
      break;
  }
});
