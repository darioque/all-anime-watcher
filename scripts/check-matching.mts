/**
 * Title-matching rules, offline.
 *
 * These are the cases where a wrong answer is quiet and expensive: linking season
 * 5 to season 1 attaches the wrong air schedule to a series and nothing about the
 * UI suggests anything is off.
 *
 *   npm run check:matching
 */
import { anilistIdFrom, CONFIDENT, scoreMatch, searchQuery, seasonOf } from "~/trackers/matching"
import type { AniListMedia } from "~/trackers/anilist"

let failures = 0

function check(label: string, condition: boolean, detail = "") {
    if (condition) console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`)
    else {
        failures++
        console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`)
    }
}

const media = (titles: { romaji?: string; english?: string; synonyms?: string[] }): AniListMedia => ({
    id: 1,
    synonyms: titles.synonyms ?? [],
    ...(titles.romaji ? { titleRomaji: titles.romaji } : {}),
    ...(titles.english ? { titleEnglish: titles.english } : {})
})

console.log("\n\x1b[1mseason detection\x1b[0m\n")
check("'… Season 05' → 5", seasonOf("A Record of A Mortal's Journey to Immortality Season 05") === 5)
check("'… Part 2' → 2", seasonOf("Some Show Part 2") === 2)
check("'… – Temporada 3' → 3", seasonOf("Wan Jie Du Zun – Temporada 3") === 3)
check(
    "'Temporada' comes out of the AniList query",
    searchQuery("Wan Jie Du Zun – Temporada 3") === "Wan Jie Du Zun",
    `got "${searchQuery("Wan Jie Du Zun – Temporada 3")}"`
)
check("bare trailing number → 10", seasonOf("Tales of Demons and Gods 10") === 10)
check("no season → null", seasonOf("Renegade Immortal") === null)
check("a year is not a season", seasonOf("Xian Ni (2023)") === null, `got ${seasonOf("Xian Ni (2023)")}`)

console.log("\n\x1b[1msearch query cleaning\x1b[0m\n")
check(
    "season marker removed",
    searchQuery("A Record of A Mortal's Journey to Immortality Season 05") ===
        "A Record of A Mortal's Journey to Immortality",
    searchQuery("A Record of A Mortal's Journey to Immortality Season 05")
)
check("year removed", searchQuery("Xian Ni (2023)") === "Xian Ni")
check("sub/dub markers removed", searchQuery("Some Show English Sub") === "Some Show English")
check("bare number kept", searchQuery("Tales of Demons and Gods 10") === "Tales of Demons and Gods 10")

console.log("\n\x1b[1mscoring\x1b[0m\n")
const exact = media({ romaji: "Renegade Immortal", synonyms: ["Xian Ni"] })
check("matches on a synonym", scoreMatch("Xian Ni", exact) === 1, `${scoreMatch("Xian Ni", exact).toFixed(2)}`)
check("punctuation is ignored", scoreMatch("renegade-immortal!", exact) === 1)

const seasonOne = media({ romaji: "Fanren Xiu Xian Zhuan", english: "A Record of a Mortal's Journey to Immortality" })
const seasonFive = media({
    romaji: "Fanren Xiu Xian Zhuan Di Wu Ji",
    synonyms: ["A Record of a Mortal's Journey to Immortality Season 5"]
})

const wrongSeason = scoreMatch("A Record of a Mortal's Journey to Immortality Season 5", seasonOne)
const rightSeason = scoreMatch("A Record of a Mortal's Journey to Immortality Season 5", seasonFive)
check("season 5 does NOT auto-link to season 1", wrongSeason < CONFIDENT, wrongSeason.toFixed(2))
check("season 5 does match season 5", rightSeason >= CONFIDENT, rightSeason.toFixed(2))
check("the right season outranks the wrong one", rightSeason > wrongSeason)

// A season-1 title has no marker, so nothing should be penalised.
const plain = scoreMatch("A Record of a Mortal's Journey to Immortality", seasonOne)
check("an unnumbered title is not penalised", plain >= CONFIDENT, plain.toFixed(2))

console.log("\n\x1b[1mwhat the user typed\x1b[0m\n")

/*
 * Manual search exists for the series no query of ours will ever find — AniList
 * carries plenty of donghua under a romanisation the site's title does not
 * resemble. Pasting the page is the way out, so what counts as a paste matters.
 */
check("a bare id is an id", anilistIdFrom("21") === 21)
check("a series URL carries one", anilistIdFrom("https://anilist.co/anime/153406/Xian-Ni/") === 153406)
check("with or without a scheme", anilistIdFrom("anilist.co/anime/1535") === 1535)
check("surrounding space is ignored", anilistIdFrom("  9253 ") === 9253)
check("a title is not an id", anilistIdFrom("Xian Ni") === null)
check("and neither is a title with numbers in it", anilistIdFrom("Tales of Demons and Gods 8") === null)

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`)
process.exit(failures > 0 ? 1 : 0)
