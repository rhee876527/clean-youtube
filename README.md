# A fork of Cloudtube

This is how I watch Youtube. Clean UI. No ads.

Features added:
- Smooth media playback. (DASH makes this hard but current implementation is usable).
- Media fetching retry with backoff.
- Auto picture-in-picture when user leaves page mid-playback.
- 720p setting selects correct video quality.
- English audio is always preferred, including videos with dubbed audio.
- Timestamp jump fixes.
- Uses MediaSession API for external media control.
- Comments from invidious API.
- Music videos. (Needs invidious instance with local proxy enabled).

Notes:
- Requires a WORKING invidious instance.
- Media playback on Firefox no good (as of Jan 2026).

<details>
<summary>Show Original README</summary>

# CloudTube

## Navigation

- [Project hub][hub]
- [Announcements][announce]
- › CloudTube repo
- [NewLeaf repo][newleaf]
- [Documentation repo][docs]
- [Mailing list][list] for development and discussion
- [Todo tracker][todo] for listing problems and feature requests
- [Chatroom on Matrix][matrix]

[hub]: https://sr.ht/~cadence/tube/
[announce]: https://lists.sr.ht/~cadence/tube-announce
[cloudtube]: https://git.sr.ht/~cadence/cloudtube
[newleaf]: https://git.sr.ht/~cadence/NewLeaf
[list]: https://lists.sr.ht/~cadence/tube-devel
[todo]: https://todo.sr.ht/~cadence/tube
[matrix]: https://matrix.to/#/#cloudtube:cadence.moe
[docs]: https://git.sr.ht/~cadence/tube-docs

</details>
