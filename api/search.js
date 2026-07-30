const {request} = require("../utils/request")
const {render} = require("pinski/plugins")
const db = require("../utils/db")
const {getUser} = require("../utils/getuser")
const converters = require("../utils/converters")

const searchCache = new Map()

module.exports = [
	{
		route: "/(?:search|results)", methods: ["GET"], code: async ({req, url}) => {
			const query = url.searchParams.get("q") || url.searchParams.get("search_query")
			const user = getUser(req)
			const settings = user.getSettingsOrDefaults()
			const instanceOrigin = settings.instance

			const fetchURL = new URL(`${instanceOrigin}/api/v1/search`)
			fetchURL.searchParams.set("q", query)

			let results = await request(fetchURL.toString()).then(res => res.json())
			const error = results.error || results.message || results.code

			if (error) throw new Error(`Instance said: ${error}`)

			for (const video of results) {
				converters.normaliseVideoInfo(video)
			}

			for (const video of results) {
				if (!video.authorId) {
					const firstCreator = video.author.split(/ and | ft\. | featuring | x | vs | ,/i)[0].trim()
					if (firstCreator) {
						const match = results.find(v => v.author === firstCreator && v.authorId)
						if (match) {
							video.authorId = match.authorId
							video.authorUrl = `/channel/${match.authorId}`
						} else {
							const dbRow = db.prepare("SELECT ucid FROM Channels WHERE name = ?").get(firstCreator)
							if (dbRow) {
								video.authorId = dbRow.ucid
								video.authorUrl = `/channel/${dbRow.ucid}`
							} else if (searchCache.has(firstCreator)) {
								video.authorId = searchCache.get(firstCreator)
								video.authorUrl = `/channel/${searchCache.get(firstCreator)}`
							} else {
								try {
									const searchRes = await request(`${instanceOrigin}/api/v1/search?type=channel&q=${encodeURIComponent(firstCreator)}`).then(r => r.json())
									if (Array.isArray(searchRes)) {
										const found = searchRes.find(r => r.author.trim() === firstCreator && r.authorId)
										if (found && found.authorId) {
											video.authorId = found.authorId
											video.authorUrl = `/channel/${found.authorId}`
											searchCache.set(firstCreator, found.authorId)
											try { db.prepare("REPLACE INTO Channels (ucid, name) VALUES (?, ?)").run(found.authorId, firstCreator) } catch (e) {}
										}
									}
								} catch (e) {}
							}
						}
					}
					if (!video.authorId) {
						video.authorUrl = null
					}
				}
			}

			const filters = user.getFilters()
			results = converters.applyVideoFilters(results, filters).videos

			return render(200, "pug/search.pug", {req, settings, url, query, results, instanceOrigin})
		}
	}
]
