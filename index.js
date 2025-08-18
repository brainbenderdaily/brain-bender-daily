// index.js — Brain Bender Daily (fixed ffmpeg drawtext escaping + robust I/O)
const express = require("express");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const googleTTS = require("google-tts-api");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const app = express();
app.use(express.json());

// --- paths
const ROOT = process.cwd();
const ASSETS = path.join(ROOT, "assets");
const TMP = path.join(ROOT, "tmp");

// ensure tmp exists
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP);

app.get("/health", (_req, res) => res.json({ ok: true }));

// Helper to fetch a file to disk
async function downloadToFile(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  const file = fs.createWriteStream(outPath);
  await new Promise((resolve, reject) => {
    res.body.pipe(file);
    res.body.on("error", reject);
    file.on("finish", resolve);
  });
  return outPath;
}

// Build drawtext with proper escaping for ffmpeg 4.4 on Render
function dt({ font, text, color, size, x, y, borderw = 4, bordercolor = "black@0.9", tStart = 0, tEnd = 999 }) {
  // Escape single quotes and colons in the text; escape backslashes for JS/ffmpeg
  const safe = String(text)
    .replace(/\\/g, "\\\\")        // backslashes
    .replace(/'/g, "\\\\'")        // apostrophes
    .replace(/:/g, "\\\\:");       // colons for ffmpeg
  // commas in enable() MUST be escaped as \, — double-escaped here for JS
  const enable = `enable='between(t\\,${tStart}\\,${tEnd})'`;
  return `drawtext=fontfile='${font}':text='${safe}':fontcolor=${color}:fontsize=${size}:x=${x}:y=${y}:borderw=${borderw}:bordercolor=${bordercolor}:${enable}`;
}

app.get("/make", async (req, res) => {
  try {
    // --- Inputs (could be made dynamic later)
    const bgPath = path.join(ASSETS, "background3.png"); // 1536x1024 works; scaled to 1080x1920
    const fontPath = path.join(ASSETS, "BebasNeue-Regular.ttf"); // already added to repo
    if (!fs.existsSync(bgPath)) throw new Error("Missing assets/background3.png");
    if (!fs.existsSync(fontPath)) throw new Error("Missing assets/BebasNeue-Regular.ttf");

    // Script
    const title = "Today’s Riddle";
    const riddle = "I speak without a mouth and hear without ears. What am I?";
    const answer = "Answer: An echo.";
    const cta = "Follow @BrainBenderDaily";

    // --- TTS
    const narrationText = `Today's riddle. ${riddle} You have three seconds. Three, two, one. ${answer}`;
    const url = googleTTS.getAudioUrl(narrationText, {
      lang: "en",
      slow: false,
      host: "https://translate.google.com",
    });

    const ts = Date.now();
    const speechMp3 = path.join(TMP, `speech_${ts}.mp3`);
    const outMp4 = path.join(TMP, `out_${ts}.mp4`);

    await downloadToFile(url, speechMp3);

    // --- ffmpeg filter graph
    // Positions (centered X; Y as percentages of height)
    const Xcenter = "(w-text_w)/2";
    const Ytitle = "h*0.15";
    const Yriddle = "h*0.40";
    const Ycount = "h*0.78";
    const Ycta = "h*0.92";

    // Compose drawtext layers with time windows; NOTE: commas in between() are escaped
    const filters = [
      // scale + pixel format first
      "scale=1080:1920:flags=lanczos,format=yuv420p",

      dt({ font: fontPath, text: title, color: "white", size: 68, x: Xcenter, y: Ytitle, tStart: 0, tEnd: 2 }),
      dt({ font: fontPath, text: riddle, color: "white", size: 58, x: Xcenter, y: Yriddle, tStart: 0, tEnd: 6 }),
      dt({ font: fontPath, text: "Answer in 3…", color: "yellow", size: 60, x: Xcenter, y: Ycount, tStart: 2, tEnd: 3 }),
      dt({ font: fontPath, text: "Answer in 2…", color: "yellow", size: 60, x: Xcenter, y: Ycount, tStart: 3, tEnd: 4 }),
      dt({ font: fontPath, text: "Answer in 1…", color: "yellow", size: 60, x: Xcenter, y: Ycount, tStart: 4, tEnd: 5 }),
      dt({ font: fontPath, text: answer, color: "cyan", size: 66, x: Xcenter, y: Yriddle, tStart: 5, tEnd: 11 }),
      dt({ font: fontPath, text: cta, color: "white", size: 44, x: Xcenter, y: Ycta, borderw: 3, tStart: 0, tEnd: 11 }),
    ].join(",");

    // --- ffmpeg run
    // -loop 1 with PNG, duration ~11s, video 30fps, aac audio, faststart
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
      "-movflags",