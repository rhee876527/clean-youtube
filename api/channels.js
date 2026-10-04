const {render, redirect} = require("pinski/plugins")
const {fetchChannel, getChannelIdForHandle} = require("../utils/youtube")
const {getUser} = require("../utils/getuser")
const converters = require("../utils/converters")
const constants = require("../utils/constants")

module.exports = [
	{
		route: `/(c|channel|user)/(.+)`, methods: ["GET"], code: async ({req, fill, url}) => {
			const path = fill[0]
			const id = fill[1]
			const user = getUser(req)
			const settings = user.getSettingsOrDefaults()
			const data = await fetchChannel(path, id, settings.instance)
			const instanceOrigin = settings.instance

			// problem with the channel? fetchChannel has collected the necessary information for us.
			// we can render a skeleton page, display the message, and provide the option to unsubscribe.
			if (data.error) {
				const statusCode = data.missing ? 410 : 500
				const subscribed = user.isSubscribed(id)
				return render(statusCode, "pug/channel-error.pug", {req, settings, data, subscribed, instanceOrigin})
			}

			// everything is fine

			// normalise info, apply watched status
			if (!data.second__subCountText && data.subCount) {
				data.second__subCountText = converters.subscriberCountToText(data.subCount)
			}
			const watchedVideos = user.getWatchedVideos()
			if (data.latestVideos) {
				data.latestVideos.forEach(video => {
					converters.normaliseVideoInfo(video)
					video.watched = watchedVideos.includes(video.videoId)
				})
			}
		const subscribed = user.isSubscribed(data.authorId)
		return render(200, "pug/channel.pug", {req, settings, data, subscribed, instanceOrigin})
	}
	},
	{
		// YouTube @handles: resolve once via the server instance, then
		// 301 to the canonical /channel/UC... URL. Subscriptions and all
		// downstream fetches stay UCID-only, so any user instance works.
		route: `/@([^/]+)(?:/.*)?`, methods: ["GET"], code: async ({req, fill, url}) => {
			const rawHandle = fill[0] || ""
			const user = getUser(req)
			const settings = user.getSettingsOrDefaults()
			const instanceOrigin = settings.instance
			// Try the user's own instance first (respects their Settings
			// choice), then fall back to the server instance. Either can
			// resolve; the DB cache makes the second lookup free on success.
			const localOrigin = constants.server_setup.local_instance_origin
			const candidates = [...new Set([instanceOrigin, localOrigin].filter(Boolean))]

			let ucid = null
			for (const candidate of candidates) {
				try {
					ucid = await getChannelIdForHandle(rawHandle, candidate)
				} catch (e) {
					ucid = null
				}
				if (ucid) break
			}
			if (!ucid) console.error(`Could not resolve handle @${rawHandle} via ${candidates.join(", ")}`)
			if (ucid) {
				return redirect(`/channel/${ucid}${url.search || ""}`, 301)
			}

			return render(404, "pug/channel-error.pug", {
				req, settings, subscribed: false, instanceOrigin,
				data: {
					error: true,
					missing: false,
					ucid: `@${rawHandle}`,
					row: null,
					message: `Could not resolve handle @${rawHandle}.`
				}
			})
		}
	}
]
