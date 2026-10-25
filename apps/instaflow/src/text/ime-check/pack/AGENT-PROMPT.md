# Instaflow IME check: instructions for an agent with computer use

You are checking where macOS shows its input-method **candidate window** while someone types Japanese, Chinese and
Korean into a text editor that draws its own text on a canvas. You need computer use (screenshots, mouse, keyboard).
Work only in this folder, Chrome and the macOS input menu. Do not change other settings or apps.

## Before you start
1. Ask the user before changing any system setting. Check the input menu (menu bar, top right). If Japanese – Romaji,
   Chinese Simplified – Pinyin or Korean – 2-Set Korean is missing, ask the user to add it (System Settings →
   Keyboard → Input Sources → Edit → +), or add it yourself only if they say yes. Note which input source was active
   at the start so you can switch back at the end.
2. In a terminal in this folder run `node serve.mjs`. Open the printed URL in Google Chrome (not another browser).
   Wait until the page says "Ready (edit-context)".
3. Click **Use local CJK fonts** and allow the permission prompt, so Chinese, Japanese and Korean characters render.

## The steps
For each step: click inside the white box at the end of the text, switch input source from the input menu, type, and
take a screenshot **while the candidate window is open** (before pressing Enter). Then press Enter to commit.

| # | Input source | Type | Then |
|---|---|---|---|
| 1 | Japanese – Romaji | `nihongo`, then Space | screenshot, Enter |
| 2 | Chinese – Pinyin | `zhongwen` | screenshot, Space or 1 to pick |
| 3 | Korean – 2-Set | `gksrmf` | screenshot (Korean composes syllables in place; there may be no list) |
| 4 | Japanese | click **Fill a long line**, click at the end of the last line, repeat step 1 | screenshot |
| 5 | Japanese | click **Insert an Arabic word**, repeat step 1 | screenshot |
| 6 | Japanese | press Cmd + twice (browser zoom), repeat step 1, then Cmd 0 | screenshot |
| 7 | all | add `?input=textarea` to the URL, reload, click **Use local CJK fonts**, repeat steps 1–3 | screenshots |

**Pass** for a step: the candidate window (or the composing syllable for Korean) sits directly below or beside the
red-underlined text you are typing, within about one line height, and the chosen characters land at that spot.
**Fail**: the window appears somewhere else (a screen corner, the top left of the page, far from the text), the
characters land elsewhere, appear twice, or don't appear.

## Afterwards
1. Switch the input source back to the one that was active at the start.
2. In Chrome's DevTools console run `copy(JSON.stringify(window.__imeCheck.log))` and paste it into `ime-log.json`.
3. Write `ime-results.md` in this folder: one line per step (number, PASS or FAIL, one sentence on what you saw),
   the Chrome version (chrome://version), macOS version, and the screenshots' file names (save them in `results/`).
4. Stop the server (Ctrl+C in the terminal). Tell the user you're done and where `ime-results.md` is.
