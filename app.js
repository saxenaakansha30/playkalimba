// Kalimba Tab Player
// Parses simple numbered-notation ("jianpu") kalimba tabs and plays them
// back with a synthesized plucked-tine tone (no audio samples needed).

const MAJOR_SCALE_SEMITONES = [0, 2, 4, 5, 7, 9, 11]; // degrees 1..7

const DEFAULT_BPM = 100;
const DEFAULT_KEY_OFFSET = 0; // C
const DEFAULT_LINE_GAP_BEATS = 0.5; // extra pause inserted when a tab line ends
const STRUM_GAP_SECONDS = 0.03; // delay between each tone of a chord, strummed rather than struck at once

let audioCtx = null;
let activeNodes = [];
let stopRequested = false;

const els = {
  tab: document.getElementById('tab'),
  transpose: document.getElementById('transpose'),
  lineGap: document.getElementById('lineGap'),
  tempo: document.getElementById('tempo'),
  play: document.getElementById('play'),
  stop: document.getElementById('stop'),
  status: document.getElementById('status'),
};

els.play.addEventListener('click', onPlay);
els.stop.addEventListener('click', onStop);

function setStatus(msg) {
  els.status.textContent = msg;
}

// --- Parsing -----------------------------------------------------------

// Bar lines ("|") are purely visual measure separators in kalimba tabs and
// carry no timing/pitch information, so they're stripped before tokenizing.
//
// Tokens are one of:
//   - a bracketed chord group: (1 3 5), (135), (3'5), [1 3 5] ...
//   - a dash-joined compact chord: 1-3-5, 3'-5 ...
//   - a single note: a digit 1-7 with optional ' / , octave marks and an
//     optional trailing '.' for a dotted (1.5x) duration
//   - '0' for a rest
//   - a lone '-' to extend the previous note/chord/rest by one more beat
// Anything else is ignored.
// Tokenizes line by line and inserts a '\n' sentinel token between lines
// that have content, so parseTab can add a small extra pause at line
// breaks (tab lines usually correspond to musical phrases).
function tokenize(text) {
  const lines = text.split('\n');
  const tokens = [];
  for (const line of lines) {
    const noBars = line.replace(/\|/g, ' ');
    const lineTokens = noBars.match(/\([^)]*\)|\[[^\]]*\]|\S+/g);
    if (!lineTokens) continue;
    if (tokens.length > 0) tokens.push('\n');
    tokens.push(...lineTokens);
  }
  return tokens;
}

// Parses the note substrings inside a chord group (bracket or dash-joined),
// e.g. "3'5" or "1 3 5" or "1-3-5" -> [{ degree, octave }, ...].
function parseChordTones(inner) {
  const tones = [];
  const re = /([0-7])([',]*)/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    const digit = m[1];
    if (digit === '0') continue; // rests don't contribute a tone to a chord
    let octave = 0;
    for (const ch of m[2]) {
      if (ch === "'") octave += 1;
      else if (ch === ',') octave -= 1;
    }
    tones.push({ degree: parseInt(digit, 10), octave });
  }
  return tones;
}

// Returns an array of note events. Each is one of:
//   { rest: true, beats }
//   { rest: false, degree, octave, beats }                 -- single note
//   { rest: false, chord: [{ degree, octave }, ...], beats } -- chord
function parseTab(text) {
  const tokens = tokenize(text);
  const notes = [];

  // Set when a '\n' sentinel is seen; consumed by the next note-producing
  // token so a small pause lands between the last note of one line and the
  // first note of the next. A '-' crossing the break just extends the
  // previous note as normal (no pause, since it's the same sustained note).
  let pendingLineBreak = false;
  const applyLineBreak = () => {
    if (pendingLineBreak) {
      if (notes.length > 0) notes[notes.length - 1].lineGapAfter = true;
      pendingLineBreak = false;
    }
  };

  for (const tok of tokens) {
    if (tok === '\n') {
      if (notes.length > 0) pendingLineBreak = true;
      continue;
    }

    if (tok === '-') {
      if (notes.length === 0) continue; // leading '-' with nothing to extend
      notes[notes.length - 1].beats += 1;
      pendingLineBreak = false;
      continue;
    }

    // Bracketed chord: (1 3 5), (135), (3'5), [1 3 5] ...
    if (/^[([]/.test(tok)) {
      const inner = tok.slice(1, -1);
      const tones = parseChordTones(inner);
      if (tones.length === 0) continue;
      applyLineBreak();
      if (tones.length === 1) {
        notes.push({ rest: false, degree: tones[0].degree, octave: tones[0].octave, beats: 1 });
      } else {
        notes.push({ rest: false, chord: tones, beats: 1 });
      }
      continue;
    }

    // Dash-joined compact chord, e.g. 1-3-5 or 3'-5 (no spaces, so it isn't
    // the sustain '-' token, and has at least one internal dash).
    if (/^[0-7][',]*(-[0-7][',]*)+$/.test(tok)) {
      const tones = parseChordTones(tok);
      if (tones.length > 0) {
        applyLineBreak();
        notes.push({ rest: false, chord: tones, beats: 1 });
      }
      continue;
    }

    const match = tok.match(/^([0-7])([',]*)(\.)?$/);
    if (!match) continue; // ignore anything we don't understand

    const digit = match[1];
    const marks = match[2];
    const dotted = Boolean(match[3]);
    const beats = dotted ? 1.5 : 1;

    applyLineBreak();

    if (digit === '0') {
      notes.push({ rest: true, beats });
      continue;
    }

    let octave = 0;
    for (const ch of marks) {
      if (ch === "'") octave += 1;
      else if (ch === ',') octave -= 1;
    }

    notes.push({ rest: false, degree: parseInt(digit, 10), octave, beats });
  }

  return notes;
}

// --- Pitch mapping -------------------------------------------------------

// MIDI note number for the root of each key, at the octave the "1" (no
// octave marks) should sound on a kalimba (around the 4th octave).
function rootMidi(keySemitoneOffset) {
  // MIDI 60 = C4. Keys are offsets from C.
  return 60 + keySemitoneOffset;
}

function degreeToFrequency(degree, octave, keySemitoneOffset, transposeSemitones) {
  const scaleOffset = MAJOR_SCALE_SEMITONES[degree - 1];
  const midi =
    rootMidi(keySemitoneOffset) +
    scaleOffset +
    octave * 12 +
    transposeSemitones;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function noteToFrequency(note, keySemitoneOffset, transposeSemitones) {
  return degreeToFrequency(note.degree, note.octave, keySemitoneOffset, transposeSemitones);
}

// --- Synthesis -------------------------------------------------------
// A kalimba tine is a stiff clamped-free bar plucked by the thumb: the
// attack is a short percussive "tick" (thumbnail leaving the metal), the
// overtones are inharmonic and stretched (not clean integer multiples of
// the fundamental like a string), and those overtones die out MUCH faster
// than the fundamental — a bright transient collapsing into a plainer,
// longer-ringing tone. Higher tines are also physically shorter/stiffer,
// so they decay noticeably faster than low tines. We approximate all of
// that with: a noise-burst click, a lightly detuned pair of fundamental
// oscillators (for a touch of natural beating), and a handful of
// fast-decaying inharmonic overtone oscillators.

let noiseBufferCache = null;
function getNoiseBuffer(ctx) {
  if (noiseBufferCache && noiseBufferCache.sampleRate === ctx.sampleRate) {
    return noiseBufferCache;
  }
  const length = Math.floor(ctx.sampleRate * 0.08);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  noiseBufferCache = buffer;
  return buffer;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Tracks a source node together with the gain node controlling its
// amplitude, so Stop can fade it out instead of truncating the waveform
// mid-swing (which produces an audible click/pop).
function trackNode(node, gain) {
  const entry = { node, gain };
  activeNodes.push(entry);
  node.onended = () => {
    activeNodes = activeNodes.filter((n) => n !== entry);
  };
}

function pluckNote(freq, startTime, duration) {
  const ctx = audioCtx;
  const master = ctx.createGain();
  master.gain.value = 0.85;
  master.connect(ctx.destination);

  // Higher tines ring out faster than low tines on a real kalimba — this
  // shapes the overtone brightness falloff below, it does not set how
  // long the fundamental rings (see `sustain`).
  const decay = clamp(1.0 - Math.log2(freq / 130.81) * 0.15, 0.3, 1.0);
  // The fundamental gets only a short tail added past the note's own
  // beat, not a long decay-based floor — otherwise it's still near full
  // volume when several subsequent notes have already started, and the
  // pile-up of overlapping, ringing pitches reads as one blended sound
  // (or a slide) instead of distinct notes playing one after another.
  const sustain = duration + clamp(decay * 0.12, 0.04, 0.12);

  // Attack transient: a short bandpassed noise burst for the pluck "tick".
  const noise = ctx.createBufferSource();
  noise.buffer = getNoiseBuffer(ctx);
  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = 'bandpass';
  noiseFilter.frequency.value = freq * 3.5;
  noiseFilter.Q.value = 0.6;
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0, startTime);
  noiseGain.gain.linearRampToValueAtTime(0.4, startTime + 0.002);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.025);
  noise.connect(noiseFilter).connect(noiseGain).connect(master);
  noise.start(startTime);
  noise.stop(startTime + 0.05);
  trackNode(noise, noiseGain);

  // Fundamental: two triangle oscillators, slightly detuned, long decay.
  const fundGain = ctx.createGain();
  fundGain.gain.setValueAtTime(0, startTime);
  fundGain.gain.linearRampToValueAtTime(0.5, startTime + 0.004);
  fundGain.gain.exponentialRampToValueAtTime(0.001, startTime + sustain);
  fundGain.connect(master);

  [-4, 4].forEach((cents) => {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    osc.detune.value = cents;
    osc.connect(fundGain);
    const stopAt = startTime + sustain + 0.2;
    osc.start(startTime);
    osc.stop(stopAt);
    trackNode(osc, fundGain);
  });

  // Inharmonic overtones (stretched ratios typical of a clamped-free bar),
  // each decaying far faster than the fundamental so the brightness fades
  // quickly after the pluck.
  const overtones = [
    { ratio: 2.4, level: 0.24, decayMul: 0.3 },
    { ratio: 4.6, level: 0.12, decayMul: 0.16 },
    { ratio: 7.1, level: 0.06, decayMul: 0.09 },
  ];
  overtones.forEach(({ ratio, level, decayMul }) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq * ratio;
    const g = ctx.createGain();
    const otDecay = Math.max(decay * decayMul, 0.05);
    g.gain.setValueAtTime(0, startTime);
    g.gain.linearRampToValueAtTime(level, startTime + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, startTime + otDecay);
    osc.connect(g).connect(master);
    const stopAt = startTime + otDecay + 0.1;
    osc.start(startTime);
    osc.stop(stopAt);
    trackNode(osc, g);
  });
}

// --- Playback ----------------------------------------------------------

function onPlay() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  const notes = parseTab(els.tab.value);
  if (notes.length === 0) {
    setStatus('Nothing to play — check your tab text.');
    return;
  }

  const bpm = Math.max(1, parseInt(els.tempo.value, 10) || DEFAULT_BPM);
  const secondsPerBeat = 60 / bpm;
  const keyOffset = DEFAULT_KEY_OFFSET;
  const transpose = parseInt(els.transpose.value, 10) || 0;
  const lineGapBeats = Math.max(0, parseFloat(els.lineGap.value));
  const lineGapSeconds = (Number.isFinite(lineGapBeats) ? lineGapBeats : DEFAULT_LINE_GAP_BEATS) * secondsPerBeat;

  stopRequested = false;
  const startTime = audioCtx.currentTime + 0.1;
  let t = startTime;

  for (const note of notes) {
    const dur = note.beats * secondsPerBeat;
    if (!note.rest) {
      if (note.chord) {
        // Strum: play each tone of the chord in the order it's written,
        // just slightly offset, like rolling a thumb across kalimba
        // tines — not all struck at the exact same instant like a piano
        // chord.
        note.chord.forEach((tone, i) => {
          const freq = degreeToFrequency(tone.degree, tone.octave, keyOffset, transpose);
          pluckNote(freq, t + i * STRUM_GAP_SECONDS, dur);
        });
      } else {
        const freq = noteToFrequency(note, keyOffset, transpose);
        pluckNote(freq, t, dur);
      }
    }
    t += dur;
    if (note.lineGapAfter) t += lineGapSeconds;
  }

  const totalDuration = t - startTime;
  setStatus(`Playing ${notes.length} events (~${totalDuration.toFixed(1)}s)...`);
  els.play.disabled = true;
  setTimeout(() => {
    if (!stopRequested) setStatus('Done.');
    els.play.disabled = false;
  }, totalDuration * 1000 + 200);
}

function onStop() {
  stopRequested = true;
  const now = audioCtx.currentTime;
  const FADE = 0.015; // seconds; short enough to feel instant, long enough to avoid a click
  activeNodes.forEach(({ node, gain }) => {
    try {
      if (gain) {
        // Freeze the gain at its current (possibly mid-ramp) value, then
        // ease it to silence, instead of chopping the waveform off
        // mid-swing — an abrupt cut causes an audible click/pop.
        if (typeof gain.gain.cancelAndHoldAtTime === 'function') {
          gain.gain.cancelAndHoldAtTime(now);
        } else {
          gain.gain.cancelScheduledValues(now);
        }
        gain.gain.linearRampToValueAtTime(0, now + FADE);
      }
      node.stop(now + FADE);
    } catch (e) {
      // not yet started, or already stopped
    }
  });
  activeNodes = [];
  els.play.disabled = false;
  setStatus('Stopped.');
}
