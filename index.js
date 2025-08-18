// index.js — Brain Bender Daily (robust ffmpeg + escaping + simple routes)
const express = require("express");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const googleTTS = require("google-tts-api");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static") || "ffmpeg";

const app = express();
app.use(express.json());

// --- Paths
const ROOT = process.cwd();
const ASSETS = path.join(ROOT, "assets");
const TMP = path.join(ROOT, "tmp");

// Ensure tmp exists
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

app.get("/health", (_req, res) => res.json({ ok: true }));

// Serve generated files
app.get("/file/:name", (req, res) => {
  const file = path.join(TMP, req.params.name);
  if (!fs.existsSync(file)) return res.status(404).send("Not found");
  res.sendFile(file);
});

// Download helper
async function downloadToFile(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outPath);
    res.body.pipe(file);
    res.body.on("error", reject);
    file.on("finish", resolve);
  });
  return outPath;
}

// Build drawtext with safe escaping for ffmpeg 4.4 (Render)
function dt({
  font,
  text,
  color,
  size,
  x,
  y,
  borderw = 4,
  bordercolor = "black@0.9",
  tStart = 0,
  tEnd = 999,
}) {
  // Escape for ffmpeg: backslashes, single quotes, and colons
  const safe = String(text)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\\\'")
    .replace(/:/g, "\\\\:");
  // IMPORTANT: commas inside between() must be escaped as \,
  const enable = `enable='between(t\\,${tStart}\\,${tEnd})'`;
  return `drawtext=fontfile='${font}':text='${safe}':fontcolor=${color}:fontsize=${size}:x=${x}:y=${y}:borderw=${borderw}:bordercolor=${bordercolor}:${enable}`;
}

app.get("/make", async (_req, res) => {
  try {
    // --- Inputs
    const bgPath = path.join(ASSETS, "background3.png");
    const fontPath = path.join(ASSETS, "BebasNeue-Regular.ttf");
    if (!fs.existsSync(bgPath)) throw new Error("Missing assets/background3.png");
    if (!fs.existsSync(fontPath)) throw new Error("Missing assets/BebasNeue-Regular.ttf");

    // Script
    const title = "Today’s Riddle";
    const riddle = "I speak without a mouth and hear without ears. What am I?";
    const answer = "Answer: An echo.";
    const cta = "Follow @BrainBenderDaily";

    // TTS
    const narrationText = `Today's riddle. ${riddle} You have three seconds. Three, two, one. ${answer}`;
    const ttsUrl = googleTTS.getAudioUrl(narrationText, {
      lang: "en",
      slow: false,
      host: "https://translate.google.com",
    });

    const ts = Date.now();
    const speechMp3 = path.join(TMP, `speech_${ts}.mp3`);
    const outMp4 = path.join(TMP, `out_${ts}.mp4`);

    await downloadToFile(ttsUrl, speechMp3);

    // Filter graph
    const Xcenter = "(w-text_w)/2";
    const Ytitle = "h*0.15";
    const Yriddle = "h*0.40";
    const Ycount = "h*0.78";
    const Ycta = "h*0.92";

    const filters = [
      "scale=1080:1920:flags=lanczos,format=yuv420p",
      dt({ font: fontPath, text: title, color: "white", size: 68, x: Xcenter, y: Ytitle, tStart: 0, tEnd: 2 }),
      dt({ font: fontPath, text: riddle, color: "white", size: 58, x: Xcenter, y: Yriddle, tStart: 0, tEnd: 6 }),
      dt({ font: fontPath, text: "Answer in 3…", color: "yellow", size: 60, x: Xcenter, y: Ycount, tStart: 2, tEnd: 3 }),
      dt({ font: fontPath, text: "Answer in 2…", color: "yellow", size: 60, x: Xcenter, y: Ycount, tStart: 3, tEnd: 4 }),
      dt({ font: fontPath, text: "Answer in 1…", color: "yellow", size: 60, x: Xcenter, y: Ycount, tStart: 4, tEnd: 5 }),
      dt({ font: fontPath, text: answer, color: "cyan", size: 66, x: Xcenter, y: Yriddle, tStart: 5, tEnd: 11 }),
      dt({ font: fontPath, text: cta, color: "white", size: 44, x: Xcenter, y: Ycta, borderw: 3, tStart: 0, tEnd: 11 }),
    ].join(",");

    // ffmpeg args
    const args = [
      "-y",
      "-loop", "1",
      "-i", bgPath,
      "-i", speechMp3,
      "-t", "11",
      "-r", "30",
      "-vf", filters,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "22",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      "-shortest",
      outMp4,
    ];

    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("close", (code) => {
      if (code !== 0 || !fs.existsSync(outMp4)) {
        return res.status(500).json({
          error: "ffmpeg failed",
          ARGS: args.join(" "),
          STDERR: stderr || "(empty)",
        });
      }
      const fileName = path.basename(outMp4);
      return res.json({
        ok: true,
        file: `/file/${fileName}`,
        hint: "Open the file URL to preview/download.",
      });
    });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Brain Bender Daily server listening on :${PORT}`);
});