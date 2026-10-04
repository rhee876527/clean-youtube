const {request} = require("./request")
const db = require("./db")
const {enrichSuspectVideos} = require("./collab-views")

async function fetchChannel(path, ucid, instance) {
	function updateGoodData(channel) {
		const bestIcon = channel.authorThumbnails.slice(-1)[0]
		const iconURL = bestIcon ? bestIcon.url : null
		db.prepare("REPLACE INTO Channels (ucid, name, icon_url, missing, missing_reason) VALUES (?, ?, ?, 0, NULL)").run(channel.authorId, channel.author, iconURL)
	}

	function updateBadData(channel) {
		if (channel.identifier === "NOT_FOUND" || channel.identifier === "ACCOUNT_TERMINATED") {
			db.prepare("UPDATE Channels SET missing = 1, missing_reason = ? WHERE ucid = ?").run(channel.error, channel.authorId)
			return {
				missing: true,
				message: channel.error
			}
		} else {
			return {
				missing: false,
				message: channel.error
			}
		}
	}

	if (!instance) throw new Error("No instance parameter provided")

	const row = db.prepare("SELECT * FROM Channels WHERE ucid = ?").get(ucid)
	// can branch on row.missing if needed, but account termination is not permanent,
	// so we need to fetch new data from the web either way...

	/** @type {any} */
	const channel = await request(`${instance}/api/v1/channels/${ucid}?second__path=${path}`).then(res => res.json())

	// handle the case where the just-fetched channel has an error
	if (channel.error) {
		const missingData = updateBadData(channel)
		return {
			error: true,
			ucid,
			row,
			...missingData
		}
	}

	// handle the case where the just-fetched channel does not have an error
	updateGoodData(channel)
	// Invidious zeroes views for collab videos on channel endpoints.
	// Patch views-only via search; fail-open, cached 12h.
	if (Array.isArray(channel.latestVideos)) {
		await enrichSuspectVideos(channel.latestVideos, instance)
	}
	return channel
}

/**
 * Resolve a YouTube @handle to a canonical UCID via Invidious
 * `GET {instance}/api/v1/resolveurl?url=https://www.youtube.com/@handle`.
 * Returns the UCID string, or null if it cannot be resolved.
 * Fail-open: never throws for backend errors, just returns null.
 */
async function resolveHandleToUcid(handle, instance) {
	if (!instance) throw new Error("No instance parameter provided")
	const clean = String(handle || "").replace(/^@/, "").trim()
	if (!clean) return null
	const pageURL = `https://www.youtube.com/@${clean}`
	const fetchURL = `${instance}/api/v1/resolveurl?url=${encodeURIComponent(pageURL)}`
	let resolved
	try {
		resolved = await request(fetchURL).then(res => res.json())
	} catch (e) {
		return null
	}
	if (!resolved || resolved.error) return null
	// Invidious returns {ucid, browseId, pageType}. Only accept channel pages.
	if (resolved.pageType && resolved.pageType !== "WEB_PAGE_TYPE_CHANNEL") return null
	const ucid = resolved.ucid || resolved.browseId || null
	if (!ucid || !/^UC[A-Za-z0-9-_]{20,}$/.test(ucid)) return null
	return ucid
}

/**
 * Get the UCID for a handle, using the Handles table as a cache.
 * Key is lowercased (YouTube handles are case-insensitive).
 * On cache miss, resolves via the given instance and stores the mapping.
 * Returns the UCID string, or null if unresolvable.
 */
async function getChannelIdForHandle(handle, instance) {
	const clean = String(handle || "").replace(/^@/, "").trim()
	if (!clean) return null
	const key = clean.toLowerCase()
	try {
		const hit = db.prepare("SELECT ucid FROM Handles WHERE handle = ?").get(key)
		if (hit && hit.ucid) return hit.ucid
	} catch (e) {
		// table may not exist yet if migration hasn't run; fall through to resolve
	}
	const ucid = await resolveHandleToUcid(clean, instance)
	if (ucid) {
		try {
			db.prepare("REPLACE INTO Handles (handle, ucid, updated) VALUES (?, ?, ?)").run(key, ucid, Date.now())
		} catch (e) {}
	}
	return ucid
}

module.exports.fetchChannel = fetchChannel
module.exports.resolveHandleToUcid = resolveHandleToUcid
module.exports.getChannelIdForHandle = getChannelIdForHandle
