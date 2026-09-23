#!/usr/bin/env node
// scripts/voice/clips/record.mjs — S71-c (brief
// docs/agent-briefs/s71-c-clip-harness-brief.md §1.A, R-453): the maintainer
// records the 22-sentence walk (docs/walks/voice-walk-2026-09-22.md) ONCE,
// row by row, and the clips live on disk under `--out` (default
// `data/voice/clips/`, gitignored) for `score.mjs` to replay against any
// whisper.cpp setting offline. A plain Node http server, no dependencies:
// GET `/` serves one inline HTML/JS page (Chrome/Edge, no build step -- it
// imports nothing from `src/`), GET `/clip/<n>` serves a saved clip back for
// playback, GET `/manifest.json` reports what is saved so far, and POST
// `/clip/<n>` takes the raw WAV bytes the page recorded and writes
// `<out>/<nn>.wav` plus `<out>/manifest.json`.
//
//   node scripts/voice/clips/record.mjs [--port 8092] [--out data/voice/clips]
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const SENTENCES_PATH = fileURLToPath(new URL("./sentences.json", import.meta.url));
const DEFAULT_PORT = 8092;
const DEFAULT_OUT = "data/voice/clips";

function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, outDir: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--out") out.outDir = argv[++i];
    else throw new Error(`record.mjs: unknown argument "${a}"`);
  }
  return out;
}

function loadSentences() {
  return JSON.parse(readFileSync(SENTENCES_PATH, "utf8"));
}

function clipFileName(n) {
  return `${String(n).padStart(2, "0")}.wav`;
}

function readManifest(outDir) {
  const p = join(outDir, "manifest.json");
  if (!existsSync(p)) return { recordedAt: null, clips: [] };
  return JSON.parse(readFileSync(p, "utf8"));
}

function writeManifest(outDir, manifest) {
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

function readRawBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolvePromise(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** The one inline page. Its own script tag captures the microphone the SAME
 *  way `src/lib/voice/localRecognizer.ts` does (`getUserMedia({ audio: {
 *  echoCancellation: true, noiseSuppression: true } })`, an `AudioContext`
 *  opened at 16 kHz with a default-rate + `OfflineAudioContext` resample
 *  fallback, a `ScriptProcessorNode` reading raw frames) and encodes the
 *  same 44-byte RIFF/16-bit-PCM WAV `src/lib/voice/wav.ts`'s `encodeWav16k`
 *  does -- copied here, not imported, because this page has no build step. */
function renderPage(sentences) {
  const sentencesJson = JSON.stringify(sentences);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Voice walk -- record the clips</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.2rem; }
  table { width: 100%; border-collapse: collapse; }
  td, th { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid #ddd; vertical-align: top; }
  td.n { width: 2.5rem; color: #888; }
  td.sentence { }
  td.actions { white-space: nowrap; width: 1%; }
  button { margin-right: 0.4rem; }
  .saved { color: #178a17; font-weight: 600; }
  .unsaved { color: #999; }
  .recording { color: #b00020; font-weight: 600; }
  #status { margin: 0.5rem 0; min-height: 1.2rem; }
</style>
</head>
<body>
<h1>Voice walk -- record the 22 clips once</h1>
<p>Press Record, say the sentence, press Stop. One row at a time; re-recording a row overwrites it.</p>
<div id="status"></div>
<table>
  <thead><tr><th>#</th><th>Sentence</th><th></th><th>Saved</th><th></th></tr></thead>
  <tbody id="rows"></tbody>
</table>
<script>
(function () {
  "use strict";
  var SENTENCES = ${sentencesJson};
  var TARGET_SAMPLE_RATE = 16000;
  var BUFFER_SIZE = 4096;
  var statusEl = document.getElementById("status");
  var rowsEl = document.getElementById("rows");
  var savedByN = {};
  var activeN = null;

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function encodeWav16k(samples, sampleRate) {
    var bytesPerSample = 2;
    var numChannels = 1;
    var blockAlign = numChannels * bytesPerSample;
    var byteRate = sampleRate * blockAlign;
    var dataSize = samples.length * bytesPerSample;
    var buffer = new ArrayBuffer(44 + dataSize);
    var view = new DataView(buffer);
    function writeAscii(offset, text) {
      for (var i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    }
    writeAscii(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(8, "WAVE");
    writeAscii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bytesPerSample * 8, true);
    writeAscii(36, "data");
    view.setUint32(40, dataSize, true);
    var offset = 44;
    for (var i = 0; i < samples.length; i++) {
      var clamped = Math.max(-1, Math.min(1, samples[i]));
      var scaled = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      view.setInt16(offset, Math.round(scaled), true);
      offset += bytesPerSample;
    }
    return buffer;
  }

  function resampleTo16k(samples, fromRate) {
    if (samples.length === 0 || fromRate === TARGET_SAMPLE_RATE) return Promise.resolve(samples);
    var Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var targetLength = Math.max(1, Math.ceil((samples.length * TARGET_SAMPLE_RATE) / fromRate));
    var offline = new Ctor(1, targetLength, TARGET_SAMPLE_RATE);
    var buffer = offline.createBuffer(1, samples.length, fromRate);
    buffer.getChannelData(0).set(samples);
    var source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(offline.destination);
    source.start(0);
    return offline.startRendering().then(function (rendered) {
      return rendered.getChannelData(0);
    });
  }

  function makeRow(s) {
    var tr = document.createElement("tr");
    tr.id = "row-" + s.n;

    var tdN = document.createElement("td");
    tdN.className = "n";
    tdN.textContent = s.n;
    tr.appendChild(tdN);

    var tdSentence = document.createElement("td");
    tdSentence.className = "sentence";
    tdSentence.textContent = s.text;
    tr.appendChild(tdSentence);

    var tdRecord = document.createElement("td");
    tdRecord.className = "actions";
    var recordBtn = document.createElement("button");
    recordBtn.textContent = "Record";
    recordBtn.id = "record-" + s.n;
    recordBtn.addEventListener("click", function () {
      onRecordClick(s.n);
    });
    tdRecord.appendChild(recordBtn);
    tr.appendChild(tdRecord);

    var tdSaved = document.createElement("td");
    tdSaved.id = "saved-" + s.n;
    tdSaved.className = "unsaved";
    tdSaved.textContent = "not recorded";
    tr.appendChild(tdSaved);

    var tdPlay = document.createElement("td");
    var playBtn = document.createElement("button");
    playBtn.textContent = "Play";
    playBtn.id = "play-" + s.n;
    playBtn.disabled = true;
    playBtn.addEventListener("click", function () {
      new Audio("/clip/" + s.n + "?t=" + Date.now()).play();
    });
    tdPlay.appendChild(playBtn);
    tr.appendChild(tdPlay);

    return tr;
  }

  function markSaved(n) {
    savedByN[n] = true;
    document.getElementById("saved-" + n).textContent = "saved";
    document.getElementById("saved-" + n).className = "saved";
    document.getElementById("play-" + n).disabled = false;
  }

  function setOtherButtonsDisabled(exceptN, disabled) {
    for (var i = 0; i < SENTENCES.length; i++) {
      var n = SENTENCES[i].n;
      if (n === exceptN) continue;
      document.getElementById("record-" + n).disabled = disabled;
    }
  }

  var session = null; // { stream, audioContext, sourceNode, processorNode, frames, recordedSampleRate }

  function onRecordClick(n) {
    if (activeN === n) {
      stopRecording(n);
      return;
    }
    if (activeN !== null) return; // one row at a time
    startRecording(n);
  }

  function startRecording(n) {
    activeN = n;
    var btn = document.getElementById("record-" + n);
    btn.textContent = "Requesting mic...";
    setOtherButtonsDisabled(n, true);
    setStatus("Row " + n + ": waiting for microphone permission...");

    // Exactly localRecognizer.ts's own getUserMedia constraints.
    navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then(function (stream) {
        var Ctor = window.AudioContext || window.webkitAudioContext;
        var audioContext;
        try {
          audioContext = new Ctor({ sampleRate: TARGET_SAMPLE_RATE });
        } catch (e) {
          audioContext = new Ctor();
        }
        var recordedSampleRate = audioContext.sampleRate;
        var sourceNode = audioContext.createMediaStreamSource(stream);
        var processorNode = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
        var frames = [];
        processorNode.onaudioprocess = function (event) {
          frames.push(new Float32Array(event.inputBuffer.getChannelData(0)));
        };
        var silence = audioContext.createGain();
        silence.gain.value = 0;
        sourceNode.connect(processorNode);
        processorNode.connect(silence);
        silence.connect(audioContext.destination);

        session = {
          stream: stream,
          audioContext: audioContext,
          sourceNode: sourceNode,
          processorNode: processorNode,
          frames: frames,
          recordedSampleRate: recordedSampleRate,
        };

        btn.textContent = "Stop";
        btn.disabled = false;
        setStatus("Row " + n + ": recording -- say the sentence, then press Stop.");
      })
      .catch(function (err) {
        activeN = null;
        setOtherButtonsDisabled(n, false);
        btn.textContent = "Record";
        setStatus("Row " + n + ": microphone error -- " + err);
      });
  }

  function stopRecording(n) {
    var btn = document.getElementById("record-" + n);
    btn.disabled = true;
    btn.textContent = "Saving...";
    setStatus("Row " + n + ": encoding and saving...");

    var s = session;
    session = null;
    for (var i = 0; i < s.stream.getTracks().length; i++) s.stream.getTracks()[i].stop();
    try {
      s.processorNode.disconnect();
    } catch (e) {}
    try {
      s.sourceNode.disconnect();
    } catch (e) {}
    try {
      s.audioContext.close();
    } catch (e) {}

    var totalLength = 0;
    for (var f = 0; f < s.frames.length; f++) totalLength += s.frames[f].length;
    var merged = new Float32Array(totalLength);
    var offset = 0;
    for (var g = 0; g < s.frames.length; g++) {
      merged.set(s.frames[g], offset);
      offset += s.frames[g].length;
    }

    resampleTo16k(merged, s.recordedSampleRate)
      .then(function (forEncoding) {
        var wav = encodeWav16k(forEncoding, TARGET_SAMPLE_RATE);
        return fetch("/clip/" + n, { method: "POST", body: wav });
      })
      .then(function (res) {
        if (!res.ok) throw new Error("server said " + res.status);
        return res.json();
      })
      .then(function () {
        markSaved(n);
        setStatus("Row " + n + ": saved.");
      })
      .catch(function (err) {
        setStatus("Row " + n + ": save failed -- " + err);
      })
      .then(function () {
        activeN = null;
        btn.textContent = "Record";
        btn.disabled = false;
        setOtherButtonsDisabled(n, false);
      });
  }

  for (var i = 0; i < SENTENCES.length; i++) {
    rowsEl.appendChild(makeRow(SENTENCES[i]));
  }

  fetch("/manifest.json")
    .then(function (res) {
      return res.json();
    })
    .then(function (manifest) {
      var clips = manifest.clips || [];
      for (var i = 0; i < clips.length; i++) markSaved(clips[i].n);
    })
    .catch(function () {
      // No manifest yet -- every row starts "not recorded", which is correct.
    });
})();
</script>
</body>
</html>
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(args.outDir);
  mkdirSync(outDir, { recursive: true });
  const sentences = loadSentences();
  const sentenceByN = new Map(sentences.map((s) => [s.n, s.text]));
  const page = renderPage(sentences);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page);
        return;
      }

      if (req.method === "GET" && url.pathname === "/manifest.json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(readManifest(outDir)));
        return;
      }

      const clipMatch = url.pathname.match(/^\/clip\/(\d+)$/);
      if (clipMatch) {
        const n = Number(clipMatch[1]);

        if (req.method === "GET") {
          const file = join(outDir, clipFileName(n));
          if (!existsSync(file)) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("no clip recorded for row " + n);
            return;
          }
          res.writeHead(200, { "Content-Type": "audio/wav" });
          res.end(readFileSync(file));
          return;
        }

        if (req.method === "POST") {
          const sentence = sentenceByN.get(n);
          if (sentence === undefined) {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("no sentence #" + n + " in sentences.json");
            return;
          }
          const body = await readRawBody(req);
          if (body.length === 0) {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("empty clip body");
            return;
          }
          const file = clipFileName(n);
          writeFileSync(join(outDir, file), body);

          const manifest = readManifest(outDir);
          manifest.recordedAt = new Date().toISOString();
          const existing = manifest.clips.find((c) => c.n === n);
          if (existing) {
            existing.file = file;
            existing.sentence = sentence;
          } else {
            manifest.clips.push({ n, file, sentence });
            manifest.clips.sort((a, b) => a.n - b.n);
          }
          writeManifest(outDir, manifest);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, n, file }));
          return;
        }
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(String((err && err.stack) || err));
    }
  });

  server.listen(args.port, () => {
    console.log(`recording page: http://127.0.0.1:${args.port}/`);
    console.log(`clips written under: ${outDir}`);
  });
}

main();
