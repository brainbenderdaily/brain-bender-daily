// index.js — Brain Bender Daily
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
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP);

// health check
app.get("/health", (_req, res) => res.json({ ok: true }));

// helper: download file
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

// helper: ffmpeg drawtext
function dt({ font, text, color, size, x, y, borderw = 4, bordercolor = "black@0.9", tStart = 0, tEnd = 999 }) {
  const safe = String(text)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\\\:");
  const enable = `enable='between(t\\,${tStart}\\,${tEnd})'`;
  return `drawtext=fontfile='${font}':text='${safe}':fontcolor=${color}:fontsize=${size}:x=${x}:y=${y}:borderw=${borderw}:bordercolor=${bordercolor}:${enable}`;
}

app.get("/make", async (_req, res) => {
  try {
    const bgPath = path.join(ASSETS, "background3.png");
    const fontPath = path.join(ASSETS, "BebasNeue-Regular.ttf");
    if (!fs.existsSync(bgPath)) throw new Error("Missing background3.png");
    if (!fs.existsSync(fontPath)) throw new Error("Missing font file");

    const title = "Today’s Riddle";
    const riddle = "I speak without a mouth and hear without ears. What am I?";
    const answer = "Answer: An echo.";
    const cta = "Follow @BrainBenderDaily";

    const narrationText = `Today's riddle. ${riddle} You have three seconds. Three, two, one. ${answer}`;
    const url = googleTTS.getAudioUrl(narrationText, { lang: "en", slow: false });
    const ts = Date.now();
    const speechMp3 = path.join(TMP, `speech_${ts}.mp3`);
    const outMp4 = path.join(TMP, `out_${ts}.mp4`);

    await downloadToFile(url, speechMp3);

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

    const args = [
      "-y", "-loop", "1", "-i", bgPath, "-i", speechMp3,
      "-t", "11", "-r", "30", "-vf", filters,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-shortest", outMp4,
    ];

    const ff = spawn(ffmpegPath, args);
    ff.stderr.on("data", d => console.log("ffmpeg:", d.toString()));

    await new Promise((resolve, reject) => {
      ff.on("error", reject);
      ff.on("close", code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
    });

    res.json({ ok: true, file: path.basename(outMp4) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// bind properly for Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));