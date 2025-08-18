// index.js — stable boot for Render (fixes 502), healthcheck, and /make
const express = require("express");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const googleTTS = require("google-tts-api");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static"); // absolute path to ffmpeg binary

const app = express();
app.use(express.json());

// Paths
const ROOT = process.cwd();
const ASSETS = path.join(ROOT, "assets");
const TMP = path.join(ROOT, "tmp");

// Ensure required dirs/files
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

// Healthcheck (Render probes this)
app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, ts: Date.now() });
});

// Helper: download URL to file
async function downloadToFile(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outPath);
    res.body.pipe(file);
    res.body.on("error", reject);
    file.on("finish", resolve);
  });
  return outPath;
}

// Build a drawtext filter string with correct escaping for ffmpeg 4.4
function drawText({ font, text, color, size, x, y, borderw = 4, bordercolor = "black@0.9", tStart = 0, tEnd = 999 }) {
  const safe = String(text)
    .replace(/\\/g, "\\\\")   // backslashes
    .replace(/'/g, "\\\\'")   // apostrophes
    .replace(/:/g, "\\\\:");  // colons
  const enable = `enable='between(t\\,${tStart}\\,${tEnd})'`; // escape commas in between()
  return [
    `drawtext=fontfile='${font}'`,
    `text='${safe}'`,
    `fontcolor=${color}`,
    `fontsize=${size}`,
    `x=${x}`,
    `y=${y}`,
    `borderw=${borderw}`,
    `bordercolor=${bordercolor}`,
    enable
  ].join(":");
}

// Demo maker endpoint (kept simple so we can confirm 502 is gone)
app.get("/make", async (_req, res) => {
  try {
    const bgPath = path.join(ASSETS, "background3.png");
    const fontPath = path.join(ASSETS, "BebasNeue-Regular.ttf");

    if (!fs.existsSync(bgPath)) {
      return res.status(500).json({ error: "Missing assets/background3.png" });
    }
    if (!fs.existsSync(fontPath)) {
      return res.status(500).json({ error: "Missing assets/BebasNeue-Regular.ttf" });
    }

    const title = "Today’s Riddle";
    const riddle = "I speak without a mouth and hear without ears. What am I?";
    const answer = "Answer: An echo.";
    const cta = "Follow @BrainBenderDaily";

    // TTS
    const narrationText = `Today's riddle. ${riddle} You have three seconds. Three, two, one. ${answer}`;
    const ttsUrl = googleTTS.getAudioUrl(narrationText, {
      lang: "en",
      slow: false,
      host: "https://translate.google.com"
    });

    const ts = Date.now();
    const speechMp3 = path.join(TMP, `speech_${ts}.mp3`);
    const outMp4 = path.join(TMP, `out_${ts}.mp4`);

    await downloadToFile(ttsUrl, speechMp3);

    const Xcenter = "(w-text_w)/2";
    const Ytitle = "h*0.15";
    const Yriddle = "h*0.40";
    const Ycount = "h*0.78";
    const Ycta = "h*0.92";

    const filters = [
      "scale=1080:1920:flags=lanczos,format=yuv420p",
      drawText({ font: fontPath, text: title,   color: "white",  size: 68, x: Xcenter, y: Ytitle, tStart: 0, tEnd: 2 }),
      drawText({ font: fontPath, text: riddle,  color: "white",  size: 58, x: Xcenter, y: Yriddle, tStart: 0, tEnd: 6 }),
      drawText({ font: fontPath, text: "Answer in 3…", color: "yellow", size: 60, x: Xcenter, y: Ycount, tStart: 2, tEnd: 3 }),
      drawText({ font: fontPath, text: "Answer in 2…", color: "yellow", size: 60, x: Xcenter, y: Ycount, tStart: 3, tEnd: 4 }),
      drawText({ font: fontPath, text: "Answer in 1…", color: "yellow", size: 60, x: Xcenter, y: Ycount, tStart: 4, tEnd: 5 }),
      drawText({ font: fontPath, text: answer,  color: "cyan",   size: 66, x: Xcenter, y: Yriddle, tStart: 5, tEnd: 11 }),
      drawText({ font: fontPath, text: cta,     color: "white",  size: 44, x: Xcenter, y: Ycta, borderw: 3, tStart: 0, tEnd: 11 })
    ].join(",");

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
      outMp4
    ];

    const ffmpegBin = ffmpegPath;
    if (!ffmpegBin) throw new Error("ffmpeg-static path not found");

    await new Promise((resolve, reject) => {
      const p = spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      p.stdout.on("data", d => process.stdout.write(d));
      p.stderr.on("data", d => { stderr += d.toString(); process.stderr.write(d); });
      p.on("close", code => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}\n${stderr}`));
      });
    });

    // stream file back
    res.setHeader("Content-Type", "video/mp4");
    fs.createReadStream(outMp4).pipe(res).on("close", () => {
      // cleanup
      try { fs.unlinkSync(speechMp3); } catch {}
      try { fs.unlinkSync(outMp4); } catch {}
    });
  } catch (err) {
    console.error("MAKE_ERROR:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// --- start server (Render provides PORT)
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
  console.log(`NODE_VERSION=${process.version}, ffmpeg=${ffmpegPath}`);
});