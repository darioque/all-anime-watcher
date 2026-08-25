/**
 * A real Byse playback block, captured 2026-08-25 from
 * `https://bysekoze.com/api/videos/afl6vo7sypot` (mundodonghua's "Fm" server on
 * I Will Eternal E52).
 *
 * The signed CDN URL inside it expired fifteen minutes after capture, which
 * costs this fixture nothing: decryption does not check it. What is kept alive
 * here is the scheme — base64url, the `version` → key-part derivation, and
 * AES-256-GCM with the tag appended — so that the day the site changes any of
 * it, `npm run check:extractors` says so instead of the extractor quietly
 * falling back to an iframe.
 */
export const bysePlayback = {
    iv: "kCGBdr-DBC3YcMn-",
    payload:
        "zFkqst4xyFQUVrOp6aTBaj4JkZUNQcM1RIVO62QrTckVTGfhZcYQY004cZJluo7r4pYpyejIohqTn5SVHrDRkdyAKDkHQSrUHcOT5eMG503tIKm3bb7Gg2oJ5KieRyMOhT5AcHg-8SGuveWlSSxuyHakEc2H_aqKz9-4w8Mx7aPvOA95pPxd1mWMnaJVjbKDsxbUGQwwZoAfPF7BAUUACMERc1TTDVfsNpBizJkWHdOEjWxGqJQ-kCPC6sYfUwfxdfRjT4H1KkuAnX-TQzXTYGW9Sq_tj-ZWBWUUecn8pT_5trsj-t2bfwgAaQbbtO3y4GIg61Jy7b0ZfoOzhPJv4dxUUEzHZgFQ2VBJ2RF8MT81pMwT9-McL1NhwgLllXyS5bFbOoR5mUcdFJ2cvrixtPHalKw1qBc6D_QBhf-sKiYDDBl0nLfaagchqyVr_2xiksgQnA0gClZSgfqDBdqlzxN_WdrIqubfhMg3oLNOPIB5qsrTqhqfL9soyRbpwxI7xXoopppjTJlG09Czu8v0U9PWAoVdRT8wC3K48OyD-AcNtTgl3TkY-g6p7RNOSimdOs0OOyNUY8mHVnssgjYq89zvlIKuiCSDIHuR26-DS8CCzCibiiY5eZcl5xqW5C7f0xrYeBPA9hE36aRaML410sUzfbBwvuxJW3tedrGdZWkb530-_VU--zrcsofngsiHUQoEH5xLLE1wsuZB9458CtkR67CmDJ1s6jvOl4d-",
    key_parts: [
        "izVs9WaoyBqKQiggt-_qGT_i-tozdKnf",
        "Y19NoOM7bbFNQ2cYMkBSMP0dFv61VGnQ",
        "Xcqk29qwZ6bOrHTxrd3fevtE_3q5_bvt",
        "5dK6WfPnt180nBG72Bdf4azXEBS3Xehp",
        "i8UyBDL7dSMCtoeE09u2JqdHHF4TeJma",
        "jug4FM-WipAF1-V9qJeYuA",
        "1q3-YnkJrlYxdmGjmES8L4nr33ZGJ1sO",
        "1bIf_-xcR2ZoTHLpeK3lvD1zUz-oPzbQ",
        "Sx0Yyls9jLYWEO8pcoVz0Ul8ot4mQ_6W",
        "Z0XeYmBRs6IYtcgHdKqoHLmmRl3bOxko",
        "KHBhKQczkYvgRqZXY5mhqyJmAoNxVwtB",
        "Q7n5-BdIgaZCx8xvUbtopJg9oxmdNodf",
        "E1HvdZHmv96wchnhA5Vf_AcuE5PEDUOr",
        "JuUN3sQATnCZuSceOCVdbv7I9mKNG52X",
        "ZuateJ_p32AaqAOzF4E4qP3Dxnb2cA7N",
        "j3LqItKuQdERoghPxNCe02yQD_QQLOQJ",
        "u74WRYfx7EhVb8gEuzTq-8ZlpY049-9k",
        "WTOqp1d8k5Z1BmxTpsiV70t0Xx7STDJE",
        "QSown6bXL0ARF3pkzuEq4Kq1RKX53iZq",
        "3CSP4gZK-rA2GoUgA5eymcFaFXliV5Xq",
        "bz7yGP9ZaFdOIPEOPOw5dFbQubBgTPkK",
        "_ldAsu2eHxa2Hqjxhvz1YVgFFaXxRa90",
        "M4k7FthRoXHnUN2M4jeDv-GCHoWtjqg1",
        "CyzNytMEFaZCuYZop87NxeFBLwKzL28s",
        "6FGBMDQgsl1V_ngd2N5Uow",
        "sFwfZ_7esxaCFmtBsn7I3M59lbsZC-D4",
        "nv_4IFRObKwGsxq9SMYIAxyPloBB2gN9",
        "XorPpdVcK0H_aw1WeKuEZXRP2UJUuvzx",
        "Jm2Ewwt13MiQJtcCsimbXiiHfMh8Rl85",
        "lct2wkQRmq0nTnMt-hHK4__PBLJbR4R1"
    ],
    version: "6"
}

/** What it decrypts to. */
export const byseExpected = {
    url: "https://edge1-vienna-sprintcdn.owphbf24.com/hls2/09/05938/afl6vo7sypot_x/master.m3u8",
    label: "1080p",
    mimeType: "application/vnd.apple.mpegurl"
}
