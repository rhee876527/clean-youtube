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

function loadMediaWithRetry(mediaElement, url, retries = 6) {
    let attempt = 0;
    let locked = false;

    function tryLoad() {
        // warm up connection BEFORE requesting the media
        warmup(url);

        mediaElement.src = url;
        mediaElement.load();

        mediaElement.onplaying = () => { locked = true; };
        mediaElement.oncanplay = () => { locked = true; };

        mediaElement.onerror = () => {
            if (locked) return;
            attempt++;
            console.error("Media load failed:", url);

            if (attempt < retries) {
                setTimeout(tryLoad, 1000 * attempt); // gradual backoff, same logic, faster start
            } else {
                console.error("Failed to load media after", retries, "attempts.");
            }
        };
    }

    tryLoad();
}

function alignStreams() {
    if (!audioElement.src || !videoElement.src) return;
    const t = Math.max(audioElement.currentTime || 0, videoElement.currentTime || 0);
    audioElement.currentTime = t;
    videoElement.currentTime = t;
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

        // --- FIX: attach best audio on initial load if video has no audio ---
        const hasAudio = this.npv.type && (this.npv.type.includes("mp4a") || this.npv.type.includes("audio"));
        if (!hasAudio) {
            const bestAudio = getBestAudioFormat();
            if (bestAudio) {
                this.npa = bestAudio;
            }
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
            if (bestAudio && bestAudio.url !== this.npv.url) {
                this.npa = bestAudio;
            }
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

            let videoReady = false;
            let audioReady = false;

            const tryResume = () => {
                if (videoReady && (audioReady || !this.npa)) {
                    if (lastTime !== null) videoElement.currentTime = lastTime;
                    safeVideoPlay().catch(() => {});

                    if (this.npa) {
                        if (lastTime !== null) audioElement.currentTime = lastTime;
                        audioElement.play().catch(() => {});
                    }

                    startSyncCheck();
                }
            };

            videoElement.src = this.npv.url;
            videoElement.load();
            videoElement.addEventListener('canplaythrough', () => {
                videoReady = true;
                tryResume();
            }, { once: true });

            if (this.npa) {
                audioElement.src = this.npa.url;
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
            loadMediaWithRetry(videoElement, this.npv.url);

            if (this.npa) loadMediaWithRetry(audioElement, this.npa.url);
            else {
                audioElement.pause();
                audioElement.removeAttribute("src");
            }
        }
    }
}


const formatLoader = new FormatLoader();

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

const ignoreNext = { play: 0 };

function startSyncCheck() {
    if (syncCheckInterval) clearInterval(syncCheckInterval);

    // Only start syncing if audio is ready or thereâ€™s no separate audio
    if (formatLoader.npa && audioElement.readyState < 2) {
        audioElement.addEventListener('canplaythrough', startSyncCheck, { once: true });
        return;
    }

    syncCheckInterval = setInterval(() => {
        if (!videoElement.paused && !audioElement.paused) {
            const drift = Math.abs(videoElement.currentTime - audioElement.currentTime);
            if (drift > 0.1) {
                audioElement.currentTime = videoElement.currentTime;
            }
        }
    }, 1000);
}

function stopSyncCheck() {
    if (syncCheckInterval) clearInterval(syncCheckInterval);
    syncCheckInterval = null;
}

function cleanupSync() {
    stopSyncCheck();
}

async function safeVideoPlay() {
    if (!formatLoader.npa) return videoElement.play().catch(()=>{});

    const tryPlay = async () => {
        const bufferedEnd = audioElement.buffered.length
            ? audioElement.buffered.end(audioElement.buffered.length - 1)
            : 0;

        if (bufferedEnd >= videoElement.currentTime + 0.25) {
            videoElement.play().catch(()=>{});
        } else {
            // Wait until audio buffers enough
            await new Promise(resolve => {
                const onCanPlay = () => {
                    audioElement.removeEventListener('canplay', onCanPlay);
                    resolve();
                };
                audioElement.addEventListener('canplay', onCanPlay);
            });
            tryPlay();
        }
    };

    tryPlay();
}

videoElement.addEventListener("play", startSyncCheck);
videoElement.addEventListener("pause", stopSyncCheck);

function playbackIntervention(event) {
    const target = event.target;
    const other = target === videoElement ? audioElement : videoElement;

    // Prevent race while media is buffering or not ready
    if (target.readyState < 2) return;

    // Only sync audio for non-SB manual seeks
    if (audioElement.src && !ignoreNext[event.type]--) {
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
// --- Robust mid-playback buffering isolation ---
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

// --- Robust smooth seek for separate audio/video ---
let freezePlayback = false
let shouldResume = false

videoElement.addEventListener("seeking", () => {
    freezePlayback = true
    if (!videoElement.paused || (formatLoader.npa && !audioElement.paused)) {
        shouldResume = true
        videoElement.pause()
        if (formatLoader.npa) audioElement.pause()
    }
})

function resumeWhenBuffered() {
    if (!freezePlayback || !shouldResume) return

    const videoReady = videoElement.readyState >= 3
    const audioReady = !formatLoader.npa || audioElement.readyState >= 3

    if (videoReady && audioReady) {
        freezePlayback = false
        shouldResume = false
        const t = videoElement.currentTime
        if (formatLoader.npa) audioElement.currentTime = t
        safeVideoPlay().catch(()=>{})
        if (formatLoader.npa) audioElement.play().catch(()=>{})
    } else {
        // Retry shortly until both ready
        requestAnimationFrame(resumeWhenBuffered)
    }
}

videoElement.addEventListener("seeking", () => {
    requestAnimationFrame(resumeWhenBuffered)
})


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

async function playVideo() {
    if (!userInteracted) return;
    if (!videoElement.paused) return;

    const targetTime = videoElement.currentTime;
    audioElement.currentTime = targetTime;
    ignoreNext.play = 2;

    try {
        if (audioContext.state === 'suspended') await audioContext.resume();

        // Only play video immediately if no separate audio, otherwise wait for audio
        if (!formatLoader.npa) {
            await safeVideoPlay();
        } else {
            // Wait until audio can play
            if (audioElement.readyState >= 2) {
                await audioElement.play();
                await safeVideoPlay();
            } else {
                audioElement.addEventListener('canplaythrough', async () => {
                    await audioElement.play();
                    await safeVideoPlay();
                }, { once: true });
            }
        }
    } catch (e) {
        console.error("Playback failed:", e);
    }
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
    videoElement.lastInteraction = Date.now(); // Track last click
    videoElement.focus();
});

// âœ… Capture spacebar early and forcefully
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

    if (event.key === "k") {
        event.preventDefault();

        // Track last interaction so other logic (like spacebar) sees a gesture
        videoElement.lastInteraction = Date.now();

        // Attempt to play video and audio
        try {
            if (videoElement.paused) {
                await safeVideoPlay(); // counts as user gesture
                if (audioElement.src && playManagers.audio.isActive()) {
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
        }

        return; // prevent further handling
    }

    const action = keyActions.get(event.key);
    if (action) {
        if (event.key === " ") {
            const isActive = document.activeElement === videoElement;
            const recentlyClicked = Date.now() - (videoElement.lastInteraction || 0) < 15000;
            if (!isActive && !recentlyClicked) return;
            event.preventDefault();
        }

        action();
        event.preventDefault();
    }
}, true); // capture phase: critical for gesture detection


if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
        title: 'Video Title',
        artist: 'Artist Name',
        album: 'Album Name',
    });

    navigator.mediaSession.setActionHandler('play', togglePlaying);
    navigator.mediaSession.setActionHandler('pause', togglePlaying);
}

videoElement.setAttribute('preload', 'metadata');
audioElement.setAttribute('preload', 'metadata');

new SubscribeButton(q("#subscribe"));

let userSeeking = false;
document.addEventListener('click', (event) => {
  const timestampEl = event.target.closest('[data-clickable-timestamp]');
  if (!timestampEl) return;

  event.preventDefault();
  const time = parseFloat(timestampEl.getAttribute('data-clickable-timestamp'));
  if (isNaN(time)) return;

  // This single line stops the play/pause buffering loop
  userSeeking = true;

  videoElement.currentTime = time;
  if (formatLoader.npa) audioElement.currentTime = time;

  window.history.replaceState(null, '', timestampEl.href);

  // Clear flag after seek settles
  videoElement.addEventListener('seeked', () =>
    setTimeout(() => userSeeking = false, 300), { once: true });
});