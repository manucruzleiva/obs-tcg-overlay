/**
 * OTO sound engine, shared by the overlay (which plays sounds for the stream) and the control
 * panel (which auditions them).
 *
 * Every cue has a built-in sound made with the Web Audio API, so no audio files ship with the app.
 * A cue can instead play an uploaded file (/api/sounds/<cue>).
 *
 * Loaded in the browser as OTO_SFX.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OTO_SFX = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ building blocks

  let noiseBuffer = null;

  // One second of white noise, made once per context
  function getNoise(ctx) {
    if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) return noiseBuffer;
    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noiseBuffer = buffer;
    return buffer;
  }

  // A pen for drawing a sound: tone() and noise() schedule short shaped notes onto `destination`
  function pen(ctx, destination) {
    const envelope = (gainNode, start, dur, peak, attack) => {
      const g = gainNode.gain;
      g.setValueAtTime(0.0001, start);
      g.exponentialRampToValueAtTime(Math.max(0.0001, peak), start + attack);
      g.exponentialRampToValueAtTime(0.0001, start + dur);
    };

    return {
      tone({ type = 'sine', freq, end, start = 0, dur = 0.2, gain = 0.3, attack = 0.005 }) {
        const t0 = ctx.currentTime + start;
        const osc = ctx.createOscillator();
        const amp = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t0);
        if (end) osc.frequency.exponentialRampToValueAtTime(end, t0 + dur);
        envelope(amp, t0, dur, gain, attack);
        osc.connect(amp);
        amp.connect(destination);
        osc.start(t0);
        osc.stop(t0 + dur + 0.05);
      },

      // filter: [type, startFrequency, endFrequency]
      noise({ start = 0, dur = 0.2, gain = 0.3, filter = ['lowpass', 2000, 2000], attack = 0.004 }) {
        const t0 = ctx.currentTime + start;
        const source = ctx.createBufferSource();
        const shaping = ctx.createBiquadFilter();
        const amp = ctx.createGain();
        source.buffer = getNoise(ctx);
        source.loop = true;
        shaping.type = filter[0];
        shaping.frequency.setValueAtTime(filter[1], t0);
        shaping.frequency.exponentialRampToValueAtTime(filter[2], t0 + dur);
        envelope(amp, t0, dur, gain, attack);
        source.connect(shaping);
        shaping.connect(amp);
        amp.connect(destination);
        source.start(t0);
        source.stop(t0 + dur + 0.05);
      }
    };
  }

  // ------------------------------------------------------------------ the built-in sounds

  const RECIPES = {
    deploy(p) {
      p.noise({ dur: 0.28, gain: 0.3, filter: ['bandpass', 500, 2400] });
      p.tone({ freq: 190, end: 90, dur: 0.25, gain: 0.5 });
    },
    bench(p) {
      p.tone({ type: 'square', freq: 520, end: 380, dur: 0.09, gain: 0.25 });
      p.tone({ type: 'triangle', freq: 760, start: 0.05, dur: 0.08, gain: 0.2 });
    },
    damage(p) {
      p.tone({ freq: 150, end: 45, dur: 0.3, gain: 0.7 });
      p.noise({ dur: 0.15, gain: 0.4, filter: ['lowpass', 1800, 300] });
    },
    heal(p) {
      p.tone({ freq: 660, dur: 0.35, gain: 0.3 });
      p.tone({ freq: 880, start: 0.12, dur: 0.4, gain: 0.3 });
      p.tone({ freq: 1320, start: 0.24, dur: 0.45, gain: 0.2 });
    },
    ko(p) {
      // three layers add up, so each is kept low enough for the total to stay under full scale
      p.tone({ freq: 110, end: 28, dur: 0.9, gain: 0.55 });
      p.tone({ type: 'triangle', freq: 55, end: 30, dur: 1.1, gain: 0.3 });
      p.noise({ dur: 0.7, gain: 0.35, filter: ['lowpass', 1200, 120] });
    },
    turn(p) {
      p.tone({ type: 'square', freq: 900, dur: 0.06, gain: 0.22 });
      p.tone({ type: 'square', freq: 620, start: 0.14, dur: 0.06, gain: 0.22 });
    },
    energy(p) {
      p.tone({ type: 'sawtooth', freq: 300, end: 1100, dur: 0.16, gain: 0.25 });
      p.tone({ freq: 1500, start: 0.14, dur: 0.12, gain: 0.2 });
    },
    ability(p) {
      p.tone({ type: 'triangle', freq: 880, dur: 0.3, gain: 0.3 });
      p.tone({ type: 'triangle', freq: 1318, start: 0.1, dur: 0.45, gain: 0.3 });
    },
    stadium(p) {
      [220, 277, 330].forEach((freq) => p.tone({ freq, dur: 0.9, gain: 0.18, attack: 0.12 }));
      p.noise({ dur: 0.5, gain: 0.08, filter: ['lowpass', 800, 200], attack: 0.15 });
    },
    supporter(p) {
      // a card laid on the table, then two rising notes: different from the ability chime and the stadium swell
      p.noise({ dur: 0.1, gain: 0.2, filter: ['highpass', 1800, 3600] });
      p.tone({ type: 'triangle', freq: 523, start: 0.06, dur: 0.22, gain: 0.26 });
      p.tone({ type: 'triangle', freq: 784, start: 0.15, dur: 0.36, gain: 0.26 });
    },
    prize(p) {
      p.noise({ dur: 0.12, gain: 0.25, filter: ['highpass', 2500, 4500] });
      p.tone({ freq: 1200, start: 0.1, dur: 0.12, gain: 0.2 });
    },
    point(p) {
      p.tone({ type: 'square', freq: 988, dur: 0.12, gain: 0.22 });
      p.tone({ type: 'square', freq: 1319, start: 0.1, dur: 0.4, gain: 0.22 });
    },
    attack(p) {
      p.noise({ dur: 0.28, gain: 0.45, filter: ['bandpass', 6000, 700] });
      p.tone({ freq: 200, end: 70, start: 0.18, dur: 0.25, gain: 0.6 });
    },
    topdeck(p) {
      [784, 988, 1175, 1568].forEach((freq, i) => p.tone({ type: 'triangle', freq, start: i * 0.08, dur: 0.5, gain: 0.22 }));
    },
    win(p) {
      [523, 659, 784, 1047].forEach((freq, i) => p.tone({ type: 'square', freq, start: i * 0.14, dur: i === 3 ? 1 : 0.3, gain: 0.22 }));
      [262, 330].forEach((freq) => p.tone({ freq, start: 0.5, dur: 0.9, gain: 0.18 }));
    },
    startgame(p) {
      p.tone({ freq: 196, dur: 1.6, gain: 0.5 });
      p.tone({ freq: 392, dur: 1.2, gain: 0.2 });
      p.tone({ freq: 588, dur: 0.9, gain: 0.12 });
      p.noise({ dur: 0.4, gain: 0.15, filter: ['bandpass', 2000, 500] });
    }
  };

  // ------------------------------------------------------------------------ the engine

  class Engine {
    constructor() {
      this.context = null;
      this.master = null;
      this.buffers = new Map(); // cue -> decoded custom sound
      this.versions = {}; // cue -> version of the file those buffers came from
      this.log = []; // every request to play, for tests and for working out why nothing was heard
    }

    // Created on first use: browsers only allow audio after the page has started it
    audio() {
      if (this.context) return this.context;
      const Context = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
      if (!Context) return null;
      this.context = new Context();
      // A gentle limiter on the way out, so stacked sounds can never clip the stream
      const limiter = this.context.createDynamicsCompressor();
      this.master = this.context.createGain();
      this.master.connect(limiter);
      limiter.connect(this.context.destination);
      return this.context;
    }

    // Draw the built-in sound for `cue` into `ctx` (a live or an offline context), through `destination`
    synthesize(cue, ctx, destination) {
      const recipe = RECIPES[cue];
      if (!recipe) return false;
      recipe(pen(ctx, destination));
      return true;
    }

    // Learn which cues have an uploaded file ({ cue: { version } }) and fetch what changed
    async setCustom(custom) {
      const wanted = custom || {};
      for (const cue of Array.from(this.buffers.keys())) {
        if (!wanted[cue] || wanted[cue].version !== this.versions[cue]) this.buffers.delete(cue);
      }
      await Promise.all(Object.keys(wanted).map((cue) => this.load(cue, wanted[cue].version)));
    }

    // Decoding goes through an offline context: it needs no permission to start, unlike a live one
    decoder() {
      if (this.offline) return this.offline;
      const Offline = typeof window !== 'undefined' && (window.OfflineAudioContext || window.webkitOfflineAudioContext);
      this.offline = Offline ? new Offline(1, 1, 44100) : null;
      return this.offline;
    }

    async load(cue, version) {
      if (this.buffers.has(cue) && this.versions[cue] === version) return;
      const decoder = this.decoder();
      if (!decoder) return;
      try {
        const response = await fetch(`/api/sounds/${encodeURIComponent(cue)}?v=${version}`);
        if (!response.ok) return;
        this.buffers.set(cue, await decoder.decodeAudioData(await response.arrayBuffer()));
        this.versions[cue] = version;
      } catch (error) {
        // A file the browser cannot decode falls back to the built-in sound
        this.buffers.delete(cue);
      }
    }

    // Play `cue` for the sound settings (state.settings.sound). `force` is for auditioning: it plays
    // even when sound is switched off. Returns whether anything was started.
    play(cue, settings, force) {
      const sound = settings || {};
      const event = (sound.events || {})[cue];
      if (!event) return false;
      if (!force && (!sound.enabled || !event.enabled)) return false;

      const volume = (Math.max(0, Math.min(100, sound.volume)) / 100) * (Math.max(0, Math.min(100, event.volume)) / 100);
      const custom = this.buffers.has(cue);
      this.log.push({ cue, volume, custom, force: Boolean(force) });
      if (volume <= 0) return false;

      const ctx = this.audio();
      if (!ctx) return false;
      if (ctx.state === 'suspended') ctx.resume();

      const level = ctx.createGain();
      level.gain.value = volume;
      level.connect(this.master);

      if (custom) {
        const source = ctx.createBufferSource();
        source.buffer = this.buffers.get(cue);
        source.connect(level);
        source.start();
        return true;
      }
      return this.synthesize(cue, ctx, level);
    }
  }

  return { Engine, CUES: Object.keys(RECIPES) };
}));
