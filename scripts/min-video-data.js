const fs = require("fs")
const zlib = require("zlib")
const progress = require("cli-progress")
const {promisify} = require("util")
const {pipeline} = require("stream")
const pipe = promisify(pipeline)

const db = require("../utils/db")

const cutoff = new Date("2023-01-01").getTime() / 1000

function* toRows(stmt) {
	yield* stmt.raw().iterate(cutoff);
}

(async () => {
	const countToMin = db.prepare("select count(*) from Videos where published < ?").pluck().get(cutoff)
	const countTotal = db.prepare("select count(*) from Videos").pluck().get()
	console.log("want to trim", countToMin, "out of", countTotal, "videos");

	// ensure that we're not trimming the entire content
	if (Math.abs(countTotal - countToMin) <= 10) {
		throw new Error("failsafe: not trimming everything")
	}

	// export
	const backupName = "video-descriptions-backup.jsonl.gz"
	console.log(`exporting a backup to ${backupName}...`)
	const contents = db.prepare("select videoId, descriptionHtml from Videos where published < ? order by author asc, published asc")

	await new Promise((resolve, reject) => {
		const rowsProgress = new progress.SingleBar({fps: 3}, progress.Presets.shades_classic)
		const gzipProgress = new progress.SingleBar({fps: 3}, progress.Presets.shades_classic)

		// write rows into gzip
		const gzip = zlib.createGzip()
		const dest = fs.createWriteStream(backupName)
		gzip.pipe(dest)
		rowsProgress.start(countToMin, 0)
		for (const row of toRows(contents)) {
			gzip.write(JSON.stringify(row))
			rowsProgress.increment()
		}
		gzip.end()
		rowsProgress.stop()

		// track gzip progress
		console.log("  compressing backup...")
		const max = gzip._writableState.length
		gzipProgress.start(max, 0)
		const interval = setInterval(() => {
			gzipProgress.update(max - gzip._writableState.length)
		}, 100)
		dest.on("finish", () => {
			clearInterval(interval)
			gzipProgress.stop()
			resolve()
		})
	})

	// do it!
	console.log("removing descriptions...")
	db.prepare("update videos set descriptionHtml = null where published < ?").run(cutoff)

	console.log("reclaiming disk space from database...")
	db.prepare("vacuum").run()
})()
