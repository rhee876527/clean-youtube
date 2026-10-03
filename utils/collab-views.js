const {request} = require("./request")

// Cache for search-based collab-bug enrichments (views + publish date).
// 12h TTL per user request.
const CACHE_TTL_MS = 12 * 60 * 60 * 1000
const cache = new Map() // videoId -> {viewCount, viewCountText, published, publishedText, ts}

function cacheGet(videoId) {
	const entry = cache.get(videoId)
	if (!entry) return null
	if (Date.now() - entry.ts > CACHE_TTL_MS) {
		cache.delete(videoId)
		return null
	}
	return entry
}

function cacheSet(videoId, viewCount, viewCountText, published, publishedText) {
	cache.set(videoId, {viewCount, viewCountText, published, publishedText, ts: Date.now()})
}

function cacheClear() {
	cache.clear()
}

/**
 * Invidious channel endpoints zero out views for collab videos
 * (author "A and B", authorId "") while search parses them correctly.
 * Genuine live/upcoming videos also report 0 views and must be left alone.
 */
function isSuspect(video) {
	if (!video || typeof video !== "object") return false
	if (video.viewCount !== 0) return false
	if (video.liveNow === true) return false
	if (video.isUpcoming === true) return false
	const prem = video.premiereTimestamp
	if (prem !== undefined && prem !== null && prem !== 0) return false
	if (typeof video.lengthSeconds === "number" && video.lengthSeconds <= 0) return false
	return true
}

function fetchWithTimeout(url, timeoutMs) {
	return Promise.race([
		request(url).then(res => res.json()),
		new Promise((_, reject) => setTimeout(() => reject(new Error("collab-views timeout")), timeoutMs))
	])
}

async function enrichOne(video, instance, timeoutMs) {
	const videoId = video.videoId ?? video.playlistId
	if (!videoId) return false
	const cached = cacheGet(videoId)
	if (cached) {
		// views + publish-date patch from cache (author etc. untouched)
		video.viewCount = cached.viewCount
		video.viewCountText = cached.viewCountText
		if (cached.published !== undefined && cached.published !== null) {
			video.published = cached.published
			video.publishedText = cached.publishedText
		}
		delete video.second__viewCountText
		return true
	}
	const url = `${instance}/api/v1/search?q=${encodeURIComponent(videoId)}&type=video&hl=en`
	const data = await fetchWithTimeout(url, timeoutMs)
	if (!Array.isArray(data)) return false
	const match = data.find(v => v && v.videoId === videoId)
	if (!match || typeof match.viewCount !== "number") return false
	// Only apply when search actually has real (non-zero) views.
	// A genuine just-published 0-view video stays 0 without extra writes.
	if (match.viewCount === 0) return false
	cacheSet(videoId, match.viewCount, match.viewCountText ?? null, match.published ?? null, match.publishedText ?? null)
	// Views + publish-date patch: do not touch author or any other field.
	// Fixing the date matters because normaliseVideoInfo renders a leftover
	// "0 seconds ago" as "Live now".
	video.viewCount = match.viewCount
	video.viewCountText = match.viewCountText ?? video.viewCountText
	if (match.published !== undefined && match.published !== null) {
		video.published = match.published
		video.publishedText = match.publishedText ?? video.publishedText
	}
	delete video.second__viewCountText
	return true
}

/**
 * Patch collab-bug 0-views entries in-place via search API (views + publish date).
 * Fail-open: any error leaves the original video untouched.
 */
async function enrichSuspectVideos(videos, instance, options = {}) {
	if (!Array.isArray(videos) || videos.length === 0) return {patched: 0, skipped: 0}
	if (!instance) return {patched: 0, skipped: videos.length}
	const {
		concurrency = 3,
		timeoutMs = 8000
	} = options
	const suspects = videos.filter(isSuspect)
	let patched = 0
	for (let i = 0; i < suspects.length; i += concurrency) {
		const batch = suspects.slice(i, i + concurrency)
		const results = await Promise.allSettled(
			batch.map(video => enrichOne(video, instance, timeoutMs).then(ok => ({video, ok})))
		)
		for (const r of results) {
			if (r.status === "fulfilled" && r.value.ok) {
				patched++
				const v = r.value.video
				console.log(`collab-views patched videoId=${v.videoId ?? v.playlistId} views=${v.viewCount} text=${v.viewCountText}`)
			}
		}
	}
	return {patched, skipped: videos.length - patched}
}

module.exports.isSuspect = isSuspect
module.exports.enrichSuspectVideos = enrichSuspectVideos
module.exports.cacheClear = cacheClear
module.exports.CACHE_TTL_MS = CACHE_TTL_MS
