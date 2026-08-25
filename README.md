# Kalimba Tab Player

A browser-based player for numbered-notation ("jianpu") kalimba tabs. Type or
paste a tab, hit Play, and hear it synthesized as a plucked-tine kalimba tone
— no audio samples, no backend, just the Web Audio API.

**Live at:** https://playkalimba.tech

## Features

- Parses jianpu-style tabs: scale degrees `1`–`7`, octave marks (`'`/`,`),
  dotted notes, rests, sustained notes, and chords.
- Chords (`(1 3 5)`, `[1 3 5]`, `1-3-5`) are strummed in the order they're
  written rather than struck all at once.
- Transpose control to match your physical kalimba's actual pitch.
- Tempo control (BPM) to speed up or slow down playback.
- Adjustable pause between tab lines, so phrasing reads clearly during
  playback.

## Tab format

| Syntax | Meaning |
|---|---|
| `1`–`7` | Scale degrees (do re mi fa sol la ti) in C major |
| `1'`, `1''` | One / two octaves up |
| `1,` | One octave down |
| `-` | Extend the previous note by one more beat |
| `0` | Rest for one beat |
| `3.` | Dotted note (1.5x duration) |
| `(3'5)`, `[1 3 5]`, `1-3-5` | Chord — played as a fast strum, in order |
| `\|` | Bar line — purely visual, ignored when playing |

Newlines between notes also insert a small pause (configurable via **Line
gap**), to mark phrase boundaries during playback.

## Running locally

No build step or dependencies — just open `index.html` in a browser.

```bash
open index.html
```

## Tech

Plain HTML/CSS/JavaScript. Audio is synthesized entirely client-side via the
Web Audio API (`app.js`) — a noise-burst attack plus detuned fundamental and
inharmonic overtone oscillators, tuned to approximate a kalimba tine's pluck
and decay. The only external resource is a Google Fonts stylesheet for the
page's typefaces; everything else is self-contained.
