import { q, qa, ElemJS } from "/static/js/elemjs/elemjs.js";
import { SubscribeButton } from "/static/js/modules/SubscribeButton.js";

const videoElement = q("#video");
videoElement.setAttribute("fetchpriority", "low");
const audioElement = q("#audio");
// Buffer audio aggressively
audioElement.setAttribute("fetchpriority", "high");
audioElement.preload = "auto";

// Make video focusable
videoElement.setAttribute("tabindex", "0");

// Get instance for proxy rewrite
window.instanceOrigin = new URL(window.instanceOrigin).origin;

// Track proxy use
const proxyApplied = new Map();

let userInteracted = false;
document.addEventListener("click", () => { userInteracted = true; alignStreams(); }, { once: true });

let syncCheckInterval = null;
const videoFormats = new Map();
const audioFormats = [];

[...data.formatStreams, ...data.adaptiveFormats].forEach(f => {
    f.isAdaptive = f.type.startsWith("video");
    if (f.type.startsWith("video")) {
        videoFormats.set(f.itag, f);
    } else {
        audioFormats.push(f);
    }
});

// --- pre-warm all known origins ---
videoFormats.forEach(vf => warmup(vf.url));
audioFormats.forEach(af => warmup(af.url));
warmup(window.instanceOrigin);

// Update src from initial url page load
try {
    const src = videoElement.querySelector('source')?.src
    const itag = videoElement.dataset.itag
    const vf = itag && videoFormats.get(itag)
    if (vf && src) vf.url = src
} catch {}

function getBestAudioFormat() {
    function parseXtags(url) {
        const urlParams = new URLSearchParams(url.split('?')[1] ?? '');
        const xtags = urlParams.get('xtags') ?? '';
        const parts = xtags.split(':');
        let language = 'unknown';
        let content = 'unknown';
        for (const part of parts) {
            if (part.startsWith('lang=')) {
                language = part.replace('lang=', '');
                if (language.includes('-')) language = language.split('-')[0];
            }
            if (part.startsWith('acont=')) content = part.replace('acont=', '');
        }
        return { language, content };
    }

    let best = null;

    for (const f of audioFormats) {
        if (!isValidUrl(f.url)) continue;
        const { language, content } = parseXtags(f.url);
        if (language === 'en' && content === 'original') {
            if (!best || f.bitrate > best.bitrate) {
                best = f;
            }
        }
    }

    if (!best) {
        for (const f of audioFormats) {
            if (!isValidUrl(f.url)) continue;
            const { language } = parseXtags(f.url);
            if (language === 'en') {
                if (!best || f.bitrate > best.bitrate) {
                    best = f;
                }
            }
        }
    }

    if (!best) {
        for (const f of audioFormats) {
            if (!isValidUrl(f.url)) continue;
            if (!best || f.bitrate > best.bitrate) {
                best = f;
            }
        }
    }

    return best;
}

function isValidUrl(string) {
    try {
        new URL(string);
        return true;
    } catch (_) {
        return false;
    }
}

const warmedOrigins = new Set();

function warmup(url) {
    try {
        const origin = new URL(url).origin;
        if (warmedOrigins.has(origin)) return; // already done
        warmedOrigins.add(origin);

        // Preconnect: TCP + TLS
        const preconnectLink = document.createElement("link");
        preconnectLink.rel = "preconnect";
        preconnectLink.href = origin;
        document.head.appendChild(preconnectLink);

        // DNS prefetch
        const dnsLink = document.createElement("link");
        dnsLink.rel = "dns-prefetch";
        dnsLink.href = origin;
        document.head.appendChild(dnsLink);

    } catch {}
}

function rewriteToProxyUrl(url) {
    try {
        if (!url.startsWith("http")) url = "https:" + url;
        const u = new URL(url);

        if (!u.hostname.endsWith("googlevideo.com")) return url; // only rewrite GoogleVideo URLs
        u.hostname = new URL(window.instanceOrigin).hostname;
        u.searchParams.delete("host"); // remove original host param
        console.log("[DEBUG] Rewritten proxy URL:", u.href);
        return u.href;
    } catch (err) {
        console.error("[DEBUG] Failed to rewrite URL:", url, err);
        return url;
    }
}

function getActiveUrl(url) {
    if (proxyApplied.get(url)) {
        return rewriteToProxyUrl(url);
    }
    return url;
}

function isCurrentVideoProxied() {
    const currentSrc = videoElement.src;
    if (!currentSrc) return false;
    // Check if any URL in proxyApplied map matches the pattern of current video
    for (const [url, applied] of proxyApplied.entries()) {
        if (applied && url && videoElement.src && videoElement.src.includes(window.instanceOrigin)) {
            return true;
        }
    }
    // Also check if the current src is already a proxied URL
    return currentSrc.includes(window.instanceOrigin);
}

async function loadMediaWithRetry(mediaElement, url, retries = 6) {
    let attempt = 0;
    let locked = false;
    let triedInstanceProxy = false;


    function tryLoad() {
        mediaElement.src = url;
        mediaElement.load();

        mediaElement.onplaying = () => { locked = true; };
        mediaElement.oncanplay = () => { locked = true; };

        mediaElement.onerror = async (e) => {
            if (locked) return;
            attempt++;

            // Determine if error is 403 or not supported
            const shouldRetryWithProxy = !triedInstanceProxy && (
                e?.target?.error?.code === 4 || // MEDIA_ERR_SRC_NOT_SUPPORTED
                e?.target?.error?.code === 1 // MEDIA_ERR_ABORTED or treat as forbidden
            );

            if (shouldRetryWithProxy) {
                triedInstanceProxy = true;
                proxyApplied.set(url, true);
                console.log("[DEBUG] Media error, retrying with instance proxy...");

                url = rewriteToProxyUrl(url);
                attempt = 0; // reset attempts for proxy
                tryLoad();
                return;
            }

            if (attempt < retries) {
                setTimeout(tryLoad, 1000 * attempt); // gradual backoff
            } else {
                console.error("Failed to load media after", retries, "attempts.");
            }
        };
    }

    tryLoad();
}

function alignStreams() {
    if (!audioElement.src || !videoElement.src) return;

    const drift = Math.abs(videoElement.currentTime - audioElement.currentTime);
    if (drift < 0.2) return;

    const t = (!videoElement.paused && !audioElement.paused && drift < 0.5)
        ? null
        : Math.max(videoElement.currentTime, audioElement.currentTime);

    if (t !== null) {
        audioElement.currentTime = t;
        videoElement.currentTime = t;
    }
}


let pipReady = false;

document.addEventListener("visibilitychange", async () => {
    const video = document.querySelector("video");
    if (!video || !document.pictureInPictureEnabled) return;

    if (document.hidden && !document.pictureInPictureElement && !video.paused) {
        if (!pipReady) {
            console.warn("PiP blocked. Waiting for user gesture to enable re-entry.");
            return;
        }

        try {
            await video.requestPictureInPicture();
        } catch (err) {
            console.error("PiP request failed:", err);
        }
    }
});

document.addEventListener("leavepictureinpicture", () => {
    pipReady = false;
});

document.addEventListener("click", () => {
    pipReady = true;
});

const audioContext = new AudioContext();

class FormatLoader {
    constructor() {
        this.npv = videoFormats.get(videoElement.getAttribute("data-itag"));
        this.npa = null;

        // --- attach best audio if video has no audio ---
        const hasAudio = this.npv.type && (this.npv.type.includes("mp4a") || this.npv.type.includes("audio"));
        if (!hasAudio) {
            const bestAudio = getBestAudioFormat();
            if (bestAudio) this.npa = bestAudio;
        }

        // Load media immediately
        requestAnimationFrame(() => this.update());
    }

    play(itag, isQualitySwitch = false) {
        this.npv = videoFormats.get(itag);
        this.npa = null;

        const hasAudio = this.npv.type && (this.npv.type.includes("mp4a") || this.npv.type.includes("audio"));
        if (!hasAudio) {
            const bestAudio = getBestAudioFormat();
            if (bestAudio && bestAudio.url !== this.npv.url) this.npa = bestAudio;
        }

        this.update(isQualitySwitch);
    }

    update(isQualitySwitch = false) {
        if (!userInteracted) return;
        cleanupSync();

        const lastTime = isQualitySwitch ? videoElement.currentTime : null;

        if (!this.npv.url) {
            console.error("No URL for video format! Cannot load.");
            return;
        }

        if (isQualitySwitch) {
            videoElement.pause();
            stopSyncCheck();

            // Preserve proxy state when switching quality
            const wasProxied = isCurrentVideoProxied();
            if (wasProxied) {
                proxyApplied.set(this.npv.url, true);
                if (this.npa) {
                    proxyApplied.set(this.npa.url, true);
                }
            }

            let videoReady = false;
            let audioReady = false;

            const tryResume = () => {
                if (videoReady && (audioReady || !this.npa)) {
                    if (lastTime !== null) videoElement.currentTime = lastTime;
                    videoElement.play().catch(() => {});

                    if (this.npa) {
                        if (lastTime !== null) audioElement.currentTime = lastTime;
                        audioElement.play().catch(() => {});
                    }

                    startSyncCheck();
                }
            };

            const activeVideoUrl = getActiveUrl(this.npv.url);
            videoElement.src = activeVideoUrl;
            videoElement.load();
            videoElement.addEventListener('canplaythrough', () => {
                videoReady = true;
                tryResume();
            }, { once: true });

            if (this.npa) {
                audioElement.src = getActiveUrl(this.npa.url);
                audioElement.load();
                audioElement.addEventListener('canplaythrough', () => {
                    audioReady = true;
                    tryResume();
                }, { once: true });
            } else {
                audioElement.pause();
                audioElement.removeAttribute("src");
                audioReady = true;
            }

        } else {
            loadMediaWithRetry(videoElement, getActiveUrl(this.npv.url));

            if (this.npa) loadMediaWithRetry(audioElement, getActiveUrl(this.npa.url));
            else {
                audioElement.pause();
                audioElement.removeAttribute("src");
            }
        }
    }
}

const formatLoader = new FormatLoader();

if (formatLoader.npa?.url) {
    audioElement.src = formatLoader.npa.url;
    audioElement.preload = "auto";
    audioElement.load();
}

class PlayManager {
    constructor(media, isAudio) {
        this.media = media;
        this.isAudio = isAudio;
    }

    isActive() {
        return !this.isAudio || formatLoader.npa;
    }

    play() {
        if (this.isActive()) this.media.play();
    }

    pause() {
        if (this.isActive()) this.media.pause();
    }
}

const playManagers = {
    video: new PlayManager(videoElement, false),
    audio: new PlayManager(audioElement, true)
};

class QualitySelect extends ElemJS {
    constructor() {
        super(q("#quality-select"));
        this.initialized = false;

        // Defer until DOM & videoFormats ready
        requestAnimationFrame(() => {
            const saved = localStorage.getItem("lastQuality");

            // Only set value if the option exists
            if (saved && this.element.querySelector(`option[value="${saved}"]`)) {
                this.element.value = saved;

                if (videoElement.readyState >= 1) {
                    formatLoader.play(saved, true);
                } else {
                    videoElement.addEventListener("loadedmetadata", () => {
                        formatLoader.play(saved, true);
                    }, { once: true });
                }
            }

            this.initialized = true;
        });

        this.on("input", this.setFormat.bind(this));
    }

    setFormat() {
        if (!this.initialized) return;

        const itag = this.element.value;
        localStorage.setItem("lastQuality", itag);

        formatLoader.play(itag, true);
        videoElement.focus();
    }
}

new QualitySelect();

// Throttle media sync
function throttle(func, delay) {
    let last = 0;
    return (...args) => {
        const now = performance.now();
        if (now - last > delay) {
            last = now;
            func(...args);
        }
    };
}

function startSyncCheck() {
    if (!formatLoader.npa || audioElement.readyState < 3) return;

    const driftThreshold = 0.3;
    const syncInterval = 300;

    const sync = throttle(() => {
        if (videoElement.paused || audioElement.paused) return;

        const videoTime = videoElement.currentTime;
        const audioTime = audioElement.currentTime;
        const drift = videoTime - audioTime;

        if (Math.abs(drift) > driftThreshold) {
            // Check if audio buffer is sufficient before correcting
            const audioEnd = audioElement.buffered.length
                ? audioElement.buffered.end(audioElement.buffered.length - 1)
                : 0;
            const bufferLead = audioEnd - videoTime;

            const minBufferLead = 2.0;

            if (bufferLead >= minBufferLead) {
                audioElement.currentTime = videoTime;
            }
        }
    }, syncInterval);

    videoElement.removeEventListener('timeupdate', sync);
    videoElement.addEventListener('timeupdate', sync);
}


function stopSyncCheck() {
    if (syncCheckInterval) clearInterval(syncCheckInterval);
    syncCheckInterval = null;
}

function cleanupSync() {
    stopSyncCheck();
}

videoElement.addEventListener("play", startSyncCheck);
videoElement.addEventListener("pause", stopSyncCheck);

function playbackIntervention(event) {
    const target = event.target;
    const other = target === videoElement ? audioElement : videoElement;

    // Prevent race while media is buffering or not ready
    if (target.readyState < 2) return;

    // Ensure audio follows video on native play/pause
    if (target === videoElement) {
        if (event.type === "play" && formatLoader.npa && audioElement.paused) {
            audioElement.currentTime = videoElement.currentTime;
            audioElement.play().catch(() => {});
        } else if (event.type === "pause" && formatLoader.npa && !audioElement.paused) {
            audioElement.pause();
        }
    }

    // Sync audio for manual seeks
    if (audioElement.src) {
        if (event.type === "seeked") {
            const targetTime = target.currentTime;
            other.currentTime = targetTime;

            setTimeout(() => {
                if (Math.abs(videoElement.currentTime - audioElement.currentTime) > 0.1) {
                    videoElement.currentTime = targetTime;
                    audioElement.currentTime = targetTime;
                }
            }, 100);
        } else if (event.type === "play") {
            if (other.readyState >= 2) {
                playManagers[other.tagName.toLowerCase()].play();
            }
        } else if (event.type === "pause") {
            other.pause();
        } else if (event.type === "ratechange") {
            other.playbackRate = target.playbackRate;
        }
    }
}

async function waitForAudioThenPlay(videoEl, audioEl) {
    if (videoEl.paused === false) return;
    if (!formatLoader.npa) {
        await videoEl.play();
        return;
    }

    // Wait until audio has sufficient buffer ahead of video
    const requiredBuffer = 6;
    await new Promise(resolve => {
        const check = () => {
            const audioEnd = audioEl.buffered.length
                ? audioEl.buffered.end(audioEl.buffered.length - 1)
                : 0;

            if (audioEnd - videoEl.currentTime >= requiredBuffer) return resolve();
            requestAnimationFrame(check);
        };
        check();
    });

    audioEl.currentTime = videoEl.currentTime;

    try { await audioEl.play(); } catch {}
    try { await videoEl.play(); } catch {}

    startSyncCheck();
}

function debounce(func, wait) {
    let timeoutId;
    return (...args) => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => func(...args), wait);
    };
}

const debouncedPlaybackIntervention = debounce(playbackIntervention, 100);
["pause", "play", "seeked"].forEach(eventName =>
    videoElement.addEventListener(eventName, debouncedPlaybackIntervention)
);
["canplaythrough", "waiting", "stalled", "ratechange"].forEach(eventName => {
    videoElement.addEventListener(eventName, playbackIntervention);
    audioElement.addEventListener(eventName, playbackIntervention);
});

// Error handling
videoElement.addEventListener("error", (e) => {
    console.error("Video loading error:", e);
});
audioElement.addEventListener("error", (e) => {
    console.error("Audio loading error:", e);
});

// Loading feedback
videoElement.addEventListener("waiting", () => console.log("Video buffering..."));
audioElement.addEventListener("waiting", () => console.log("Audio buffering..."));

// Fix reverb on buffering mid-playback
let wasPlayingBeforeBuffer = false;

videoElement.addEventListener("waiting", () => {
    if (!videoElement.paused && videoElement.currentTime > 0) {
        wasPlayingBeforeBuffer = true;

        if (!audioElement.paused && formatLoader.npa) {
            audioElement.muted = true;
        }
    }
});

videoElement.addEventListener("playing", () => {
    if (wasPlayingBeforeBuffer && formatLoader.npa) {
        wasPlayingBeforeBuffer = false;
        audioElement.muted = false;
        audioElement.currentTime = videoElement.currentTime;
    }
});

// Smooth seek for DASH audio/video
let freezePlayback = false
let shouldResume = false

videoElement.addEventListener("seeking", async () => {
    if (!formatLoader.npa) return;

    freezePlayback = true;
    shouldResume = !videoElement.paused;

    videoElement.pause();
    audioElement.pause();

    await waitForAudioThenPlay(videoElement, audioElement);

    freezePlayback = false;
    shouldResume = false;
});


function resumeWhenBuffered() {
    if (!freezePlayback || !shouldResume) return;

    const audioEnd = audioElement.buffered.length
        ? audioElement.buffered.end(audioElement.buffered.length - 1)
        : 0;

    if (audioEnd - videoElement.currentTime >= 3) {
        freezePlayback = false;
        shouldResume = false;

        audioElement.currentTime = videoElement.currentTime;
        videoElement.play().catch(() => {});
        audioElement.play().catch(() => {});
    } else {
        requestAnimationFrame(resumeWhenBuffered);
    }
}

document.addEventListener("visibilitychange", () => {
    if (!formatLoader.npa) return;

    if (!document.hidden) {
        if (!videoElement.paused) {
            freezePlayback = true;
            shouldResume = true;

            videoElement.pause();
            audioElement.pause();

            resumeWhenBuffered();
        }
    }
});

videoElement.addEventListener("seeking", () => {
    requestAnimationFrame(resumeWhenBuffered)
})

// Drift detection and correction during playback

// Skip non-chrome
const isChrome = typeof navigator !== "undefined" && /chrome|chromium/i.test(navigator.userAgent);

const driftThreshold = 0.15;
const minBufferLead = 2.0;

const checkDriftThrottled = throttle(() => {
    if (!formatLoader.npa || !isChrome || freezePlayback) return;

    const drift = videoElement.currentTime - audioElement.currentTime;

    const audioEnd = audioElement.buffered.length
        ? audioElement.buffered.end(audioElement.buffered.length - 1)
        : 0;

    if (audioElement.readyState >= 3 &&
        (audioEnd - videoElement.currentTime) >= minBufferLead &&
        Math.abs(drift) > driftThreshold) {
        audioElement.currentTime = videoElement.currentTime;
    }
}, 250);

videoElement.addEventListener("timeupdate", checkDriftThrottled);


const videoObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            loadMediaWithRetry(videoElement, formatLoader.npv.url);
            if (formatLoader.npa) {
                loadMediaWithRetry(audioElement, formatLoader.npa.url);
            }
            videoObserver.disconnect();
        }
    });
}, { threshold: 0.5 });

videoObserver.observe(videoElement);

function relativeSeek(seconds) {
    const t = videoElement.currentTime + seconds;
    videoElement.currentTime = t;
    if (formatLoader.npa) audioElement.currentTime = t;
}

// Throttle play calls on sustained seek events
const debouncedPlayVideo = debounce(async () => {
    if (!userInteracted) return;
    if (!videoElement.paused) return;

    try {
        if (audioContext.state === 'suspended') await audioContext.resume();

        if (formatLoader.npa) {
            await waitForAudioThenPlay(videoElement, audioElement);
        } else {
            await videoElement.play();
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            return; // Expected during rapid seeks — silent ignore
        }
        console.error("Playback failed:", err);
    }
}, 100);

async function playVideo() {
    debouncedPlayVideo();
}

function togglePlaying() {
    if (videoElement.paused) {
        if (!userInteracted) return;
        playVideo();
    } else {
        videoElement.pause();
        if (formatLoader.npa) audioElement.pause(); // also pause separate audio
    }
}

function toggleFullScreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
        (videoElement.requestFullscreen || videoElement.webkitRequestFullscreen).call(videoElement);
    }
}

// ðŸ”´ Critical: Track interaction and refocus
videoElement.addEventListener("pointerdown", () => {
    userInteracted = true
    videoElement.focus();
});

videoElement.addEventListener("click", (event) => {
    event.preventDefault();
    togglePlaying();
    videoElement.focus();
});

videoElement.addEventListener("seeking", () => {
    freezePlayback = true;
    if (formatLoader.npa && !videoElement.paused) {
        shouldResume = true;
        videoElement.pause();
        audioElement.pause();
    }
});

// âœ… Capture spacebar early and forcefully
let isPlaybackActionPending = false;

const keyActions = new Map([
    ["j", () => relativeSeek(-10)],
    ["n", () => relativeSeek(-10)],
    ["k", togglePlaying],
    ["p", togglePlaying],
    [" ", togglePlaying],
    ["e", togglePlaying],
    ["l", () => relativeSeek(10)],
    ["o", () => relativeSeek(10)],
    ["ArrowLeft", () => relativeSeek(-5)],
    ["ArrowRight", () => relativeSeek(5)],
    ["f", toggleFullScreen]
]);

// Use capture phase to intercept spacebar before browser scrolls
document.addEventListener("keydown", async (event) => {
    // Ignore inputs and Ctrl combinations
    if (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(event.target.tagName) || event.ctrlKey) {
        return;
    }

    if (event.key === "k" || event.key === " ") {
        event.preventDefault();

        // Prevent multiple simultaneous playback attempts
        if (isPlaybackActionPending) {
            return; // Skip if already processing a playback action
        }

        isPlaybackActionPending = true;

        // Check if both elements are ready before attempting playback
        if (videoElement.readyState < 2 || (formatLoader.npa && audioElement.readyState < 2)) {
            console.log("Media not ready, skipping playback attempt");
            isPlaybackActionPending = false;
            return; // prevent further handling but don't play
        }

        // Attempt to play video and audio
        try {
            if (videoElement.paused) {
                if (formatLoader.npa) {
                    // For video+audio, use the alignment-aware playback
                    await waitForAudioThenPlay(videoElement, audioElement);
                } else {
                    // For video-only, play directly
                    await videoElement.play(); // counts as user gesture
                }

                if (audioElement.src && playManagers.audio.isActive() && formatLoader.npa) {
                    try {
                        await audioElement.play();
                    } catch (e) {
                        console.warn("Audio blocked until user gesture:", e);
                    }
                }
            } else {
                videoElement.pause();
                audioElement.pause();
            }
        } catch (e) {
            console.warn("Playback blocked by browser:", e);
        } finally {
            // Reset the flag regardless of success or failure
            isPlaybackActionPending = false;
        }

        return; // prevent further handling
    }

    // Other key actions
    const action = keyActions.get(event.key);
    if (action) {
        event.preventDefault();
        action();
    }
}, true); // capture phase: critical for gesture detection


// MediaSession
function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;

  navigator.mediaSession.metadata = null;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: data?.title || document.title,
    artist: data?.author || ''
  });
  navigator.mediaSession.playbackState = videoElement.paused ? 'paused' : 'playing';
}

// Claim on meaningful events only
['play','pause','loadedmetadata','canplay','seeked'].forEach(e =>
  videoElement.addEventListener(e, updateMediaSession)
);

// Override on format/quality switches
const _origPlay = formatLoader.play.bind(formatLoader);
formatLoader.play = (...args) => { _origPlay(...args); requestAnimationFrame(updateMediaSession); };

// Media keys scoped to this tab
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', togglePlaying);
  navigator.mediaSession.setActionHandler('pause', togglePlaying);
}

// Initial claim
updateMediaSession();

videoElement.setAttribute('preload', 'metadata');
//audioElement.setAttribute('preload', 'metadata');

new SubscribeButton(q("#subscribe"));

// Helper function to seek to timestamp
async function seekToTimestamp(time, href = null) {
    if (isNaN(time)) return;

    // Set times
    videoElement.currentTime = time;

    if (formatLoader.npa?.url) {
        audioElement.src = formatLoader.npa.url;
        audioElement.load();
        audioElement.currentTime = time;
        await waitForAudioThenPlay(videoElement, audioElement);
    }

    if (href) {
        window.history.replaceState(null, '', href);
    }
}

// Handle clicks on timestamps in page content (descriptions, etc.)
document.addEventListener('click', async (event) => {
    const timestampEl = (event.target instanceof Element) ? event.target.closest('[data-clickable-timestamp], [data-jump-time]') : null;
    if (!timestampEl) return;

    const time = parseFloat(
        timestampEl.getAttribute('data-clickable-timestamp') ||
        timestampEl.getAttribute('data-jump-time') || '0'
    );
    if (isNaN(time)) return;

    event.preventDefault();
    const href = timestampEl instanceof HTMLAnchorElement ? timestampEl.href : null;
    await seekToTimestamp(time, href);
});

// Handle custom event from comments seeking to timestamps
document.addEventListener('seekToTimestamp', async (event) => {
    const eventData = event['detail'] || {};
    const { time, link } = eventData;
    const href = link instanceof HTMLAnchorElement ? link.href : null;
    await seekToTimestamp(time, href);
});