/**
 * The three states luciferdonghua.in's player container was observed in on
 * 2026-08-27, reduced to what `episodeAvailability` actually reads.
 *
 * Reduced on purpose rather than captured whole. The live pages are ~220KB of
 * ad frames, theme CSS and sidebar widgets, none of which the rule looks at, and
 * a fixture that large pins the site's layout instead of our rule — it would go
 * red on any redesign and tell you nothing about whether the detection still
 * works. What matters is the shape: an `.player-embed` holding either an iframe,
 * a countdown widget, or a notice.
 *
 * The ad iframe in `AD` is the reason `playerContainer` is scoped at all. It is
 * how the site really lays the page out: `div.megavid` sits above the player and
 * carries a `t.co` frame, so a page-wide `iframe[src]` finds an advert and calls
 * a countdown episode playable.
 */

const AD = `<div class="megavid"><iframe src="https://t.co/K82rYXtxpV" width="300" height="350"></iframe></div>`

const page = (playerEmbed: string) =>
    `<html><body>${AD}<div id="embed_holder" class="lowvid"><div class="player-embed" id="pembed">${playerEmbed}</div></div></body></html>`

/** E12: a real episode. The Dailymotion frame is inside an unnamed wrapper. */
export const playable = page(
    `<div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;">` +
        `<iframe src="https://geo.dailymotion.com/player.html?video=k7eSb9xbmrM4YRJ8Pyu" ` +
        `title="Dailymotion Video Player" allowfullscreen></iframe></div>`
)

/**
 * E13, base page and /v/1/: the tickcounter.com widget. Both the loader script
 * and the anchor it hydrates are present, which is why either `a.tickcounter` or
 * `[data-type=countdown]` is enough to recognise it.
 */
export const countdown = page(
    `<script>(function(d, s, id) { var js, pjs = d.getElementsByTagName(s)[0];` +
        ` if (d.getElementById(id)) return; js = d.createElement(s); js.id = id;` +
        ` js.src = "//www.tickcounter.com/static/js/loader.js";` +
        ` pjs.parentNode.insertBefore(js, pjs); }(document, "script", "tickcounter-sdk"));</script>` +
        `<a data-type="countdown" data-id="11370765" class="tickcounter" ` +
        `title="Ancient God Sovereign Episode 13 English Sub" href="//www.tickcounter.com/">` +
        `Ancient God Sovereign Episode 13 English Sub</a>`
)

/** E13, /v/2/ through /v/5/: the same episode, servers the site has given up on. */
export const notAvailable = page(`<center><h2 style="font-size: 14px;">Video Not Available</h2></center>`)

/**
 * The case the "an embed wins outright" clause exists for, and the one no live
 * page has shown yet: a countdown to the *next* episode sitting above a player
 * that works. Constructed, and labelled as constructed — if the site ever does
 * this, suppressing the episode the viewer is on would be the worse bug.
 */
export const countdownBesidePlayer = page(
    `<div><iframe src="https://geo.dailymotion.com/player.html?video=k7eSb9xbmrM4YRJ8Pyu"></iframe></div>` +
        `<a data-type="countdown" class="tickcounter" href="//www.tickcounter.com/">Episode 14 in 2 days</a>`
)
