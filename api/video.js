const {request} = require("../utils/request");
/** @type {import("node-fetch").default} */
// @ts-ignore
const fetch = require("node-fetch");
const {render} = require("pinski/plugins");
const db = require("../utils/db");
const {getToken, getUser} = require("../utils/getuser");
const pug = require("pug");
const converters = require("../utils/converters");
const constants = require("../utils/constants");

class InstanceError extends Error {
	constructor(error, identifier) {
		super(error);
		this.identifier = identifier;
	}
}

class MessageError extends Error {}

function formatOrder(format) {
	const spec = [
		{key: "second__height", max: 8000, order: "desc", transform: x => (x ? Math.floor(x / 96) : 0)},
		{key: "fps", max: 100, order: "desc", transform: x => (x ? Math.floor(x / 10) : 0)},
		{key: "type", max: " ".repeat(60), order: "asc", transform: x => x.length}
	];

	return spec.reduce((total, s, i) => {
		let diff = s.transform(format[s.key]);
		if (s.order === "asc") diff = s.transform(s.max) - diff;
		total += diff;
		if (i + 1 < spec.length) {
			total *= spec[i + 1].transform(spec[i + 1].max);
		}
		return total;
	}, 0) * -1;
}

function sortFormats(video, preference) {
	const {formatStreams, adaptiveFormats} = video;
	let formats = [...formatStreams, ...adaptiveFormats];

	formats.forEach(format => {
		if (!format.second__height && format.resolution) {
			format.second__height = +format.resolution.slice(0, -1);
		}
		if (!format.second__order) {
			format.second__order = formatOrder(format);
		}
		format.cloudtube__label = `${format.qualityLabel} ${format.container}`;
	});

	const standard = [...formatStreams].sort((a, b) => b.second__height - a.second__height);
	const adaptive = adaptiveFormats
		.filter(f => f.type.startsWith("video") && f.qualityLabel)
		.map(f => ({...f, cloudtube__label: `${f.cloudtube__label} *`}))
		.sort((a, b) => a.second__order - b.second__order);

	formats = [...standard, ...adaptive];

	const preferenceSorters = {
		5: (a, b) => (b.second__height + b.fps / 100) - (a.second__height + a.fps / 100),
		2: (a, b) => {
			const a1 = a.second__height + a.fps / 100;
			const b1 = b.second__height + b.fps / 100;
			if (b1 > 1081) return a1 > 1081 ? b1 - a1 : -1;
			if (a1 > 1081) return 1;
			return b1 - a1;
		},
		1: (a, b) => {
			const a1 = a.second__height + a.fps / 100;
			const b1 = b.second__height + b.fps / 100;
			if (b1 > 721) return a1 > 721 ? b1 - a1 : -1;
			if (a1 > 721) return 1;
			return b1 - a1;
		},
		3: (a, b) => {
			if (b.fps > 30) return a.fps < 30 ? b.second__height - a.second__height : -1;
			if (a.fps > 30) return 1;
			return b.second__height - a.second__height;
		},
		4: (a, b) => (a.itag === 18 ? -1 : b.itag === 18 ? 1 : 0)
	};

	if (preference in preferenceSorters) {
		formats.sort(preferenceSorters[preference]);
	}

	return formats;
}

module.exports = [
	{
		route: "/watch", methods: ["GET", "POST"], upload: true, code: async ({req, url, body}) => {
			const user = getUser(req);
			const settings = user.getSettingsOrDefaults();
			const id = url.searchParams.get("v");

			if (settings.local === 2) {
				const dest = `https://www.youtube.com${url.pathname}${url.search}#cloudtube`;
				user.addWatchedVideoMaybe(id);
				return {
					statusCode: 302,
					contentType: "text/plain",
					headers: {"Location": dest},
					content: `Redirecting to ${dest}...`
				};
			}

			const videoTakedownInfo = db.prepare("SELECT id, org, url FROM TakedownVideos WHERE id = ?").get(id);
			if (videoTakedownInfo) {
				return render(451, "pug/takedown-video.pug", {...videoTakedownInfo, req, settings});
			}

			const t = url.searchParams.get("t");
			const mediaFragment = converters.tToMediaFragment(t);
			const continuous = url.searchParams.get("continuous") === "1";
			const autoplay = url.searchParams.get("autoplay") === "1";
			const swp = url.searchParams.get("session-watched");
			const sessionWatched = swp ? swp.split(" ") : [];
			const sessionWatchedNext = [...sessionWatched, id].join("+");
			if (continuous) settings.quality = 0;

			const instanceOrigin = settings.local === 1 ? "http://localhost:3000" : settings.instance;
			const videoFuture = req.method === "GET"
				? request(`${instanceOrigin}/api/v1/videos/${id}`).then(res => res.json())
				: JSON.parse(new URLSearchParams(body.toString()).get("video"));

			const commentsFuture = request(`${instanceOrigin}/api/v1/comments/${id}`)
				.then(res => res.json())
				.catch(err => {
					console.error("Comments fetch failed:", err.code || err.message);
					return {comments: []};
				});


			try {
				const video = await videoFuture;
				const commentsData = await commentsFuture;
				if (!video) throw new MessageError("The instance returned null.");
				if (video.error) throw new InstanceError(video.error, video.identifier);

				const channelTakedownInfo = db.prepare("SELECT ucid, org, url FROM TakedownChannels WHERE ucid = ?").get(video.authorId);
				if (channelTakedownInfo) {
					db.prepare("INSERT INTO TakedownVideos (id, org, url) VALUES (@id, @org, @url)").run({id, ...channelTakedownInfo});
					return render(451, "pug/takedown-video.pug", {...channelTakedownInfo, req, settings});
				}

				const formats = sortFormats(video, settings.quality);

				video.recommendedVideos.forEach(converters.normaliseVideoInfo);
				const {videos, filteredCount} = converters.applyVideoFilters(video.recommendedVideos, user.getFilters());
				video.recommendedVideos = videos;

				const subscribed = user.isSubscribed(video.authorId);
				user.addWatchedVideoMaybe(video.videoId);
				const watchedVideos = user.getWatchedVideos();
				if (watchedVideos.length) {
					video.recommendedVideos.forEach(rec => {
						rec.watched = watchedVideos.includes(rec.videoId);
					});
				}

				if (!video.second__viewCountText && video.viewCount) {
					video.second__viewCountText = new Intl.NumberFormat().format(video.viewCount);
				}

				formats.forEach(format => {
					format.url += mediaFragment;
				});

				video.descriptionHtml = converters.rewriteVideoDescription(video.descriptionHtml, id);
				video.captions.forEach(caption => {
					caption.url = `/proxy?${new URLSearchParams({url: caption.url})}`;
				});

				return render(200, "pug/video.pug", {
					req, url, video, formats, subscribed, instanceOrigin, mediaFragment, autoplay, continuous,
					sessionWatched, sessionWatchedNext, settings, comments: commentsData.comments || []
				});

			} catch (error) {
				const errorTypeMap = {
					"fetch-error": error instanceof fetch.FetchError,
					"message-error": error instanceof MessageError,
					"rate-limited": error instanceof InstanceError && (error.identifier === "RATE_LIMITED_BY_YOUTUBE" || error.message === "Could not extract video info. Instance is likely blocked."),
					"instance-error": error instanceof InstanceError
				};
				const errorType = Object.keys(errorTypeMap).find(key => errorTypeMap[key]) || "unrecognised-error";
				const message = render(0, `pug/errors/${errorType}.pug`, {instanceOrigin, error}).content;

				return render(500, "pug/video.pug", {video: {videoId: id}, error: true, message, req, settings});
			}
		}
	},
	{
		route: "/api/comments", methods: ["GET"], code: async ({req, url}) => {
			const user = getUser(req);
			const settings = user.getSettingsOrDefaults();
			const videoId = url.searchParams.get("v");
			const continuation = url.searchParams.get("continuation");

			if (!videoId || !continuation) {
				return {
					statusCode: 400,
					contentType: "application/json",
					content: JSON.stringify({error: "Missing videoId or continuation"})
				};
			}

			const instanceOrigin = settings.local === 1 ? "http://localhost:3000" : settings.instance;

			try {
				const response = await request(`${instanceOrigin}/api/v1/comments/${videoId}?continuation=${encodeURIComponent(continuation)}`);
				const data = await response.json();

				return {
					statusCode: 200,
					contentType: "application/json",
					content: JSON.stringify(data)
				};
			} catch (error) {
				return {
					statusCode: 500,
					contentType: "application/json",
					content: JSON.stringify({error: "Failed to fetch comments"})
				};
			}
		}
	}
];