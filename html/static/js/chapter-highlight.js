import {q, ElemJS} from "./elemjs/elemjs.js"

class Chapter {
	constructor(linkElement) {
		this.link = new ElemJS(linkElement)
		this.time = +linkElement.getAttribute("data-clickable-timestamp")
	}
}

let chapters = [...document.querySelectorAll("[data-clickable-timestamp]")]
    .map(el => new Chapter(el))
chapters.sort((a, b) => a.time - b.time)

const video = q("#video")
const description = q("#description")
const regularBackground = "var(--regular-background)"
const highlightBackground = "var(--highlight-background)"
const paddingWidth = 4
let lastChapter = null

function getCurrentChapter(time) {
	const candidates = chapters.filter(ch => ch.time <= time)
	return candidates.length ? candidates[candidates.length - 1] : null
}

function updateHighlight() {
	if (!video) return
	const currentChapter = getCurrentChapter(video.currentTime)
	if (currentChapter !== lastChapter) {
		if (lastChapter) lastChapter.link.removeClass("timestamp--active")
		//if (currentChapter) currentChapter.link.addClass("timestamp--active")

		if (currentChapter) {
			const {offsetTop, offsetHeight} = currentChapter.link.element
			const offsetBottom = offsetTop + offsetHeight
			description.style.background =
				`linear-gradient(to bottom, ${regularBackground} ${offsetTop - paddingWidth}px, ${highlightBackground} ${offsetTop - paddingWidth}px, ${highlightBackground} ${offsetBottom + paddingWidth}px, ${regularBackground} ${offsetBottom + paddingWidth}px)`
		} else {
			description.style.background = ""
		}
		lastChapter = currentChapter
	}
}

setInterval(updateHighlight, 250)

document.addEventListener('click', e => {
	const timestampEl = e.target.closest('[data-clickable-timestamp]')
	if (!timestampEl) return

	e.preventDefault()
	const time = parseFloat(timestampEl.getAttribute('data-clickable-timestamp'))
	if (isNaN(time)) return

	video.currentTime = time

	// Convert seconds to YouTube-style t=XmYs
	const minutes = Math.floor(time / 60)
	const seconds = Math.floor(time % 60)
	const tParam = `${minutes}m${seconds}s`

	const url = new URL(window.location)
	url.searchParams.set('t', tParam)
	window.history.replaceState(null, '', url)
})
