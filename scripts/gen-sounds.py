#!/usr/bin/env python3
"""Generates Flight Deck's notification sounds into src-tauri/sounds/ (Ogg Vorbis, via ffmpeg).

All synthesized, so there are no licensing questions. Tweak and re-run, then rebuild: the files
are embedded in the binary (notifications.rs). Pure Python, no numpy needed.

  chime  two soft marimba notes, rising
  blip   a water drop with two fading echoes
  bell   a small, soft bell
"""

import math
import os
import struct
import subprocess
import tempfile
import wave

SR = 44100
OUT = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "sounds")


def silence(seconds):
    n = int(SR * seconds)
    return [0.0] * n, [0.0] * n


def mix(dst, src, at, gain=1.0, pan=0.5):
    """Adds mono `src` into the stereo pair `dst` starting at `at` seconds (pan 0 = left)."""
    left, right = dst
    gl, gr = math.cos(pan * math.pi / 2), math.sin(pan * math.pi / 2)
    start = int(at * SR)
    for i, v in enumerate(src):
        j = start + i
        if j >= len(left):
            break
        left[j] += v * gain * gl * 1.41
        right[j] += v * gain * gr * 1.41


def mallet(freq, seconds, decay, partials=((1, 1.0, 1.0), (3.9, 0.22, 3.0), (9.8, 0.05, 6.0))):
    """Marimba-like note: a few partials (ratio, amp, decay speed-up) with a soft 4 ms attack."""
    out = []
    for i in range(int(SR * seconds)):
        t = i / SR
        attack = min(1.0, t / 0.004)
        v = sum(a * math.exp(-t * k / decay) * math.sin(2 * math.pi * freq * r * t) for r, a, k in partials)
        out.append(v * attack)
    return out


def lowpass(samples, cutoff, q=0.707):
    """RBJ biquad low-pass."""
    w = 2 * math.pi * cutoff / SR
    alpha = math.sin(w) / (2 * q)
    cw = math.cos(w)
    b0, b1, b2 = (1 - cw) / 2, 1 - cw, (1 - cw) / 2
    a0, a1, a2 = 1 + alpha, -2 * cw, 1 - alpha
    b0, b1, b2, a1, a2 = b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0
    x1 = x2 = y1 = y2 = 0.0
    out = []
    for x in samples:
        y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2, x1, y2, y1 = x1, x, y1, y
        out.append(y)
    return out


def chime():
    pair = silence(1.8)
    mix(pair, mallet(659, 1.6, 0.45), 0.0, 0.34)
    mix(pair, mallet(988, 1.6, 0.55), 0.16, 0.3)
    return pair


def drop(gain):
    out = []
    phase = 0.0
    for i in range(int(SR * 0.6)):
        t = i / SR
        f = 700 + 700 * (1 - math.exp(-t / 0.02))  # a quick upward glide, like a water drop
        phase += 2 * math.pi * f / SR
        out.append(math.sin(phase) * math.exp(-t / 0.12) * min(1.0, t / 0.002) * gain)
    return out


def blip():
    pair = silence(1.5)
    mix(pair, drop(0.36), 0.0, pan=0.5)
    mix(pair, drop(0.16), 0.28, pan=0.35)
    mix(pair, drop(0.07), 0.56, pan=0.65)
    return pair


def bell():
    pair = silence(2.4)
    base = 587  # D5
    # Bell partials (hum, prime, tierce, quint, nominal); higher ones fade faster.
    partials = ((0.5, 0.35, 0.7), (1, 1.0, 1.0), (1.19, 0.45, 1.3), (1.5, 0.3, 1.6), (2, 0.35, 2.0), (2.74, 0.12, 3.0))
    mix(pair, mallet(base, 2.4, 0.8, partials), 0.0, 0.16)
    return pair


def write(name, pair):
    left, right = pair
    # Same loudness for every sound (about -24 dB RMS, like the system's message sound), with a
    # soft limiter so no peak pokes out.
    rms = math.sqrt(sum(v * v for v in left + right) / (2 * len(left)))
    gain = 0.063 / rms
    ceiling = 0.5
    left = [ceiling * math.tanh(v * gain / ceiling) for v in left]
    right = [ceiling * math.tanh(v * gain / ceiling) for v in right]
    scale = 1.0
    fade = int(SR * 0.05)
    frames = bytearray()
    for i, (l, r) in enumerate(zip(left, right)):
        g = scale * min(1.0, (len(left) - i) / fade)
        frames += struct.pack("<hh", int(l * g * 32767), int(r * g * 32767))
    with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
        with wave.open(tmp.name, "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes(bytes(frames))
        dst = os.path.join(OUT, f"{name}.oga")
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", tmp.name, "-c:a", "libvorbis", "-q:a", "5", dst], check=True
        )
    print(f"{dst}  {len(left) / SR:.1f}s")


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for name, fn in (("chime", chime), ("blip", blip), ("bell", bell)):
        write(name, fn())
