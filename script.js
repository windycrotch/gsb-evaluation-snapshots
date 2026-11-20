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
    RESELECT_LOCAL_VIDEO: "Please reselect the local video.",
    RESELECT_LOCAL_SUBTITLE: "Please reselect the local subtitle.",
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

// All recent-list / player identity logic lives in the DOM-free core.
const core = NeovidCore.createNeovidCore({ storage: localStorage });

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
  return core.getEntries();
}

function getWatchTime() {
  return core.readWatchTime();
}

function setWatchTime(value) {
  core.writeWatchTime(value);
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

// Playback UI state. `currentEntryId` is the shared identity between the
// player and the list; `playbackToken` identifies this specific playback so
// late events from a previous video are rejected.
const state = {
  currentEntryId: null,
  playbackToken: 0,
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
  // Ignore events emitted by the previous video after a switch.
  if (!core.isMediaCurrent(state.playbackToken)) {
    state.videoLastTime = null;
    return;
  }
  const videoCurrentTime = DOM.player.currentTime;
  if (state.videoLastTime !== null) {
    const diff = videoCurrentTime - state.videoLastTime;
    const next = core.accumulateWatchTime(
      { total: state.totalWatchTime, accumulated: state.accumulatedWatchTime },
      diff
    );
    if (next.total !== state.totalWatchTime) {
      state.totalWatchTime = next.total;
      setWatchTime(state.totalWatchTime);
      DOM.watchTime.textContent = formatTime(state.totalWatchTime);
    }
    state.accumulatedWatchTime = next.accumulated;
  }
  state.videoLastTime = videoCurrentTime;
}

function handleSkipButton() {
  if (!core.isMediaCurrent(state.playbackToken)) {
    DOM.skipButton.style.display = "none";
    return;
  }
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

  // Bind the player to a list entry and open a new playback generation
  // BEFORE loading the media, so no event from the old video can pass.
  const resolvedTitle = title || (videoType === "url" ? video.split("/").pop() : title);
  const { entry, token } = core.startPlayback({
    title: resolvedTitle,
    video,
    videoType,
    subtitle,
    subtitleType,
  });
  state.currentEntryId = entry.id;
  state.playbackToken = token;
  state.videoLastTime = null;

  DOM.player.load();
  DOM.player.play().catch(() => {});

  state.currentVideo = video;
  state.currentVideoType = videoType;
  state.currentTitle = resolvedTitle;
  state.currentSubtitle = subtitle;
  state.currentSubtitleType = subtitleType;
  updateDownloadButtons();
  renderRecent();
  return entry;
}

// "Watch later" only updates the list; it does not start a playback.
function saveRecent(title, video, videoType, subtitle = "", subtitleType = "url") {
  return core.upsertEntry({ title, video, videoType, subtitle, subtitleType });
}

function removeRecent(entryId) {
  showConfirm(CONFIG.MESSAGES.CONFIRM_REMOVE, {
    confirmText: "Remove"
  }).then((result) => {
      if (result.isConfirmed) {
        core.removeEntry(entryId);
        // If the playing entry was removed, reflect the detached identity.
        state.currentEntryId = core.getCurrentEntryId();
        state.playbackToken = core.getPlaybackToken();
        renderRecent();
      }
    });
}

function removeAllVideos() {
  showConfirm(CONFIG.MESSAGES.CONFIRM_REMOVE_ALL)
  .then(result => {
    if (result.isConfirmed) {
      core.removeAllEntries();
      state.currentEntryId = core.getCurrentEntryId();
      state.playbackToken = core.getPlaybackToken();
      renderRecent();
    }
  });
}

function updateProgress() {
  if (!state.currentEntryId || !DOM.player.duration) return;
  // Reject late timeupdate events from a video that is no longer current.
  if (!core.isMediaCurrent(state.playbackToken)) return;
  const percent = Math.min(100, Math.round((DOM.player.currentTime / DOM.player.duration) * 100));
  const written = core.recordProgress(state.currentEntryId, percent, state.playbackToken);
  if (written) {
    renderRecent();
  }
}

function loadPlayerTime() {
  if (!state.currentEntryId || !DOM.player.duration) return;
  if (!core.isMediaCurrent(state.playbackToken)) return;
  const currentTime = core.getResumePosition(state.currentEntryId, DOM.player.duration);
  DOM.player.currentTime = currentTime;
}

function createRecentItem(item, maxLimit) {
  const li = document.createElement("li");
  const spanTitle = document.createElement("span");
  const spanRemove = document.createElement("span");
  li.dataset.entryId = item.id;
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

  if(core.isCompleted(item)) {
    spanProgress.innerHTML = '<i class="fa-solid fa-check"></i>';
  }

  li.appendChild(spanRemove);
  li.appendChild(spanTitle);
  li.appendChild(spanProgress);

  return { li, spanTitle, spanRemove };
}

function attachRecentEvents(item, spanTitle, spanRemove) {
  spanRemove.addEventListener("click", () => {
    removeRecent(item.id);
  });

  spanTitle.addEventListener("click", () => {
    let isDataLoaded = false;
    if(item.videoType==="url"){
      DOM.videoUrl.value = item.video;
      isDataLoaded = true;
    }
    else{
      DOM.videoUrl.value = "";
      showAlert(CONFIG.MESSAGES.RESELECT_LOCAL_VIDEO, {icon: "info"});
    }
    if (item.subtitle) {
      if (item.subtitleType==="url") {
        DOM.subtitleUrl.value = item.subtitle;
        isDataLoaded = true;
      }
      else{
        DOM.subtitleUrl.value = "";
        showAlert(CONFIG.MESSAGES.RESELECT_LOCAL_SUBTITLE, {icon: "info"});
      }
    }
    if (isDataLoaded) {
      DOM.form.scrollIntoView({"behavior": "smooth"});
    }
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
  // playVideo creates/refreshes the entry and binds the player to its id.
  playVideo(data.videoSrc, data.subtitleSrc, data.videoTitle, data.videoType, data.subtitleType);
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
  renderRecent();
  showAlert(CONFIG.MESSAGES.WATCH_LATER_ADDED, {icon: "success"});
});

DOM.player.addEventListener("loadstart", () => {
  // The media now loading belongs to the latest playback generation.
  core.markMediaReady(state.playbackToken);
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
  const data = core.exportEntries();
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
    // The core validates the whole payload first and only writes storage on
    // full success, so an invalid file leaves the existing list untouched.
    const result = core.importFromText(reader.result);
    if (result.ok) {
      // The imported list replaced the old one: the running player (if any)
      // is now detached, so its timeupdate events cannot touch old entries.
      state.currentEntryId = core.getCurrentEntryId();
      state.playbackToken = core.getPlaybackToken();
      renderRecent();
      showAlert(CONFIG.MESSAGES.IMPORT_SUCCESS, {icon: "success"});
    } else {
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
    showAlert(CONFIG.MESSAGES.RESELECT_LOCAL_VIDEO, {icon: "info"});
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
