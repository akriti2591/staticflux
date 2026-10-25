# Test fonts (B2)

Open-licensed fonts for text tests, shaping parity and golden renders. All are **SIL Open Font License 1.1**
(`OFL.txt`). Not shipped with the app.

| File | Source | Changes |
|---|---|---|
| `NotoSans-Latin.wght.ttf` | google/fonts `ofl/notosans/NotoSans[wdth,wght].ttf` | subset to Latin + Latin-1 + punctuation; `wdth` pinned to 100 |
| `NotoSansArabic.wght.ttf` | google/fonts `ofl/notosansarabic/NotoSansArabic[wdth,wght].ttf` | subset to Arabic blocks; `wdth` = 100 |
| `NotoSansDevanagari.wght.ttf` | google/fonts `ofl/notosansdevanagari/NotoSansDevanagari[wdth,wght].ttf` | subset to Devanagari blocks; `wdth` = 100 |
| `NotoSansThai.wght.ttf` | google/fonts `ofl/notosansthai/NotoSansThai[wdth,wght].ttf` | subset to Thai; `wdth` = 100 |
| `Inter-subset.otf` | Inter 4 (rsms/inter, Debian `fonts-inter`) `Inter-Regular.otf` (CFF) | subset to "AHlo Instaflow" (CFF outline test) |

Made with fonttools: `pyftsubset <font> --unicodes=… --layout-features='*' --no-hinting`, then
`fonttools varLib.instancer <font> wdth=100`. Layout features are kept whole, so shaping matches the full fonts on the
covered scripts (`shaping.parity.test.ts`).
