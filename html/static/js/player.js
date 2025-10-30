import { q, qa, ElemJS } from "/static/js/elemjs/elemjs.js";
import { SubscribeButton } from "/static/js/modules/SubscribeButton.js";

const videoElement = q("#video");
const audioElement = q("#audio");
// Buffer audio aggressively
audioElement.preload = "auto";

// Make video focusable
videoElement.setAttribute("tabindex", "0");

let userInteracted = false;
document.addEventListener("click", () => { userInteracted = true; }, { once: true });

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

function loadMediaWithRetry(mediaElement, url, retries = 6) {
    let attempt = 0;
    let locked = false;
    let reloading = false; // prevent rapid reload loops

    const load = () => {
        if (locked && reloading) return;
        reloading = true;

        // prevent immediate consecutive reloads
        setTimeout(() => { reloading = false; }, 3000);

        // if element already has usable buffered data, skip reload
        if (mediaElement.readyState >= 3 && !mediaElement.error) return;

        mediaElement.src = url;
        mediaElement.load();

        mediaElement.onplaying = () => { locked = true; };
        mediaElement.oncanplay = () => { locked = true; };

        mediaElement.onerror = () => {
            reloading = false;
            if (locked) return;
            attempt++;
            if (attempt < retries) {
                setTimeout(load, 4000 * attempt);
            } else {
                console.error("Failed to load media after", retries, "attempts.");
            }
        };
    };

    load();
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
    }

    play(itag) {
        this.npv = videoFormats.get(itag);
        this.npa = null;

        // Only attach separate audio if the stream has no audio codec
        const hasAudio = this.npv.type && (this.npv.type.includes("mp4a") || this.npv.type.includes("audio"));
        if (!hasAudio) {
            const bestAudio = getBestAudioFormat();
            if (bestAudio && bestAudio.url !== this.npv.url) {
                this.npa = bestAudio;
            }
        }

        this.update();
    }

    update() {
        cleanupSync();
        const lastTime = videoElement.currentTime;

        loadMediaWithRetry(videoElement, this.npv.url);
        videoElement.currentTime = lastTime;

        if (this.npa) {
            audioElement.pause();
            audioElement.src = "";
            loadMediaWithRetry(audioElement, this.npa.url);
            audioElement.currentTime = lastTime;
        } else {
            audioElement.pause();
            audioElement.removeAttribute("src");
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
        this.on("input", this.setFormat.bind(this));
        this.setFormat();
    }

    setFormat() {
        const itag = this.element.value;
        formatLoader.play(itag);
        videoElement.focus();
    }
}

new QualitySelect();

const ignoreNext = { play: 0 };

function startSyncCheck() {
    if (syncCheckInterval) clearInterval(syncCheckInterval);
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

videoElement.addEventListener("play", startSyncCheck);
videoElement.addEventListener("pause", stopSyncCheck);

// --- SponsorBlock skip fix
let sponsorSkipInProgress = false; // flag to track SB skip

// Wrap SponsorBlock skips by listening for its events
document.addEventListener("SponsorBlockSkip", () => {
    sponsorSkipInProgress = true;
    setTimeout(() => { sponsorSkipInProgress = false; }, 100); // short debounce
});

function playbackIntervention(event) {
    const target = event.target;
    const other = target === videoElement ? audioElement : videoElement;

    // Prevent race while media is buffering or not ready
    if (target.readyState < 2) return;

    // Only sync audio for non-SB manual seeks
    if (!sponsorSkipInProgress && audioElement.src && !ignoreNext[event.type]--) {
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
    videoElement.currentTime += seconds;
}

async function playVideo() {
    if (!userInteracted) return;
    if (!videoElement.paused) return;

    audioElement.currentTime = videoElement.currentTime;

    // stop the "play/pause fight" loop
    ignoreNext.play = 2;

    try {
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }

        await videoElement.play();

        if (playManagers.audio.isActive() && audioElement.src) {
            try {
                await audioElement.play();
            } catch (e) {
                console.warn("Audio blocked until user gesture:", e);
            }
        }
    } catch (e) {
        console.error("Video play failed", e);
    }
}

function togglePlaying() {
    if (videoElement.paused) {
        playVideo();
    } else {
        videoElement.pause();
    }
}

function toggleFullScreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
        (videoElement.requestFullscreen || videoElement.webkitRequestFullscreen).call(videoElement);
    }
}

// 🔴 Critical: Track interaction and refocus
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

// ✅ Capture spacebar early and forcefully
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
                await videoElement.play(); // counts as user gesture
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

document.addEventListener('click', (event) => {
    const timestampEl = event.target.closest('[data-clickable-timestamp]');
    if (timestampEl) {
        event.preventDefault();
        const time = parseFloat(timestampEl.getAttribute('data-clickable-timestamp'));
        if (!isNaN(time)) {
            videoElement.currentTime = time;
            window.history.replaceState(null, '', timestampEl.href);
        }
    }
});