// ===== Core deps
const express = require('express');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { getAudioUrl } = require('google-tts-api');
const fetch = require('node-fetch');
const { spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const cron = require('node-cron');

// ===== Project info (comment only)
// Brain Bender Daily – automated Shorts creator
// - Generates a voiced vertical short with animated text overlays
// - Uploads to YouTube as PRIVATE
// - /make endpoint triggers a one-off generation
// - Cron (3x/day) can be enabled if desired

// ===== Env
const PORT           = process.env.PORT || 3000;
const CLIENT_ID      = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET  = process.env.YOUTUBE_CLIENT_SECRET;
const REFRESH_TOKEN  = process.env.YOUTUBE_REFRESH_TOKEN;
const REDIRECT_URI   = process.env.REDIRECT_URI || `https://${process.env.RENDER_INTERNAL_HOSTNAME || 'localhost'}/oauth2callback`;

// ===== OAuth client
const oauth2client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
oauth2client.setCredentials({ refresh_token: REFRESH_TOKEN });
const youtube = google.youtube({ version: 'v3', auth: oauth2client });

// ===== Paths
const appRoot  = process.cwd();
const dataDir  = path.join(appRoot, 'data');
const assetsDir= path.join(appRoot, 'assets');

// ===== FONT (you uploaded this file)
const FONT_PATH = path.join(assetsDir, 'BebasNeue-Regular.ttf');

// ===== Helpers (safe text for drawtext)
function escText(s) {
  return String(s)
    .replace(/\\/g, '\\\\')   // backslashes
    .replace(/:/g, '\\:')     // colons
    .replace(/'/g, "\\\\'");  // single quotes
}

// Build a drawtext string with outline + time window
function dt(text, { x="(w-text_w)/2", y="(h-text_h)/2", size=56, color="white",
                    start=0, end=3, border=4, borderColor="black@0.9" } = {}) {
  const t = escText(text);
  return `drawtext=fontfile='${FONT_PATH}':text='${t}':fontcolor=${color}:fontsize=${size}:x=${x}:y=${y}:borderw=${border}:bordercolor=${borderColor}:enable='between(t,${start},${end})'`;
}

// Pick a background image or use a solid color
function pickBackgroundOrSolid() {
  try {
    if (fs.existsSync(assetsDir)) {
      const files = fs.readdirSync(assetsDir)
        .filter(f => /^background.*\.(png|jpg|jpeg)$/i.test(f));
      if (files.length) {
        const chosen = files[Math.floor(Math.random() * files.length)];
        return { type: 'image', path: path.join(assetsDir, chosen) };
      }
    }
  } catch (_) {}
  // solid color fallback (lavfi)
  return { type: 'solid', color: '0x101020' }; // deep blue
}

// Load a random riddle
function loadRiddle() {
  const file = path.join(dataDir, 'riddles.json');
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  return list[Math.floor(Math.random() * list.length)];
}

// Download a URL to a file
async function downloadToFile(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const buf = await res.buffer();
  fs.writeFileSync(outPath, buf);
  return outPath;
}

// Build voiced audio (question + short pause + answer)
async function buildVoiceTrack(question, answer) {
  const tmpDir = path.join(appRoot, 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);
  const qUrl = getAudioUrl(question, { lang: 'en', slow: false, host: 'https://translate.google.com' });
  const aUrl = getAudioUrl(`Answer: ${answer}`, { lang: 'en', slow: false, host: 'https://translate.google.com' });

  const qMp3 = path.join(tmpDir, `q_${Date.now()}.mp3`);
  const pad  = path.join(tmpDir, `pad_${Date.now()}.mp3`); // 1s silence
  const aMp3 = path.join(tmpDir, `a_${Date.now()}.mp3`);
  const out  = path.join(tmpDir, `speech_${Date.now()}.mp3`);

  await downloadToFile(qUrl, qMp3);
  // make 1s silent mp3
  let args = ['-f','lavfi','-i','anullsrc=r=24000:cl=mono','-t','1','-q:a','9','-acodec','libmp3lame', pad];
  let p = spawnSync(ffmpegPath, args, { encoding: 'utf8' });
  if (p.status !== 0) { throw new Error(`ffmpeg(silence) failed: ${p.stderr}`); }

  await downloadToFile(aUrl, aMp3);

  // concat q + pad + a
  const listFile = path.join(tmpDir, `list_${Date.now()}.txt`);
  fs.writeFileSync(listFile, `file '${qMp3}'\nfile '${pad}'\nfile '${aMp3}'\n`);
  args = ['-f','concat','-safe','0','-i',listFile,'-c','copy',out];
  p = spawnSync(ffmpegPath, args, { encoding: 'utf8' });
  if (p.status !== 0) { throw new Error(`ffmpeg(concat) failed: ${p.stderr}`); }

  return out;
}

// Create video with overlays
async function createVideo(question, answer, audioPath) {
  const bg = pickBackgroundOrSolid();
  const tmpDir = path.join(appRoot, 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);
  const out = path.join(tmpDir, `out_${Date.now()}.mp4`);

  // base filters
  const filters = [
    'scale=1080:1920:flags=lanczos,format=yuv420p',
    dt("Today's Riddle",           { size: 68, y: 'h*0.15', start: 0, end: 2 }),
    dt(question,                   { size: 58, y: 'h*0.40', start: 0, end: 6 }),
    dt('Answer in 3…',             { size: 60, y: 'h*0.78', start: 2, end: 3, color: 'yellow' }),
    dt('Answer in 2…',             { size: 60, y: 'h*0.78', start: 3, end: 4, color: 'yellow' }),
    dt('Answer in 1…',             { size: 60, y: 'h*0.78', start: 4, end: 5, color: 'yellow' }),
    dt(`Answer: ${answer}`,        { size: 66, y: 'h*0.40', start: 5, end: 11, color: 'cyan' }),
    dt('Follow @BrainBenderDaily', { size: 44, y: 'h*0.92', start: 0, end: 11, color: 'white', border: 3 }),
  ].join(',');

  // Build ffmpeg args
  let args = [];
  if (bg.type === 'image') {
    // loop image for 11s
    args.push('-loop','1','-i', bg.path);
  } else {
    // solid color background
    args.push('-f','lavfi','-i', `color=c=${bg.color}:s=1080x1920:r=30`);
  }
  args.push('-i', audioPath);

  // duration 11s, h264, aac
  args.push(
    '-t','11',
    '-r','30',
    '-vf', filters,
    '-c:v','libx264','-preset','veryfast','-crf','22',
    '-c:a','aac','-b:a','128k',
    '-shortest',
    out
  );

  const proc = spawnSync(ffmpegPath, args, { encoding: 'utf8' });
  if (proc.status !== 0) {
    console.error('FFmpeg args:', args.join(' '));
    console.error('FFmpeg stdout:', proc.stdout);
    console.error('FFmpeg stderr:', proc.stderr);
    throw new Error('ffmpeg failed');
  }
  return out;
}

// Upload to YouTube
async function uploadToYouTube(filePath, title, description) {
  const stats = fs.statSync(filePath);
  const res = await youtube.videos.insert({
    part: ['snippet','status'],
    requestBody: {
      snippet: { title, description, categoryId: '27' }, // Education
      status: { privacyStatus: 'private' }
    },
    media: { body: fs.createReadStream(filePath), mimeType: 'video/mp4' },
  }, {
    maxContentLength: stats.size,
    maxBodyLength:  Infinity,
  });
  return res.data.id;
}

// Express app
const app = express();

app.get('/', (_, res) => {
  res.json({ ok: true, hint: 'Use /make to generate a short.' });
});

app.get('/make', async (req, res) => {
  try {
    const { question, answer } = loadRiddle();
    const audio = await buildVoiceTrack(question, answer);
    const vid   = await createVideo(question, answer, audio);
    const title = question.length > 90 ? question.slice(0, 90) + '…' : question;
    const desc  = `${question}\nAnswer: ${answer}\n#riddle #brainteaser #shorts`;
    const videoId = await uploadToYouTube(vid, title, desc);

    // cleanup temp media (non-fatal if fails)
    try {
      fs.unlinkSync(vid);
      fs.unlinkSync(audio);
    } catch (_) {}

    res.json({ question, answer, videoId });
  } catch (e) {
    console.error('Error in /make:', e && e.stack || e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// OPTIONAL: cron – uncomment to enable 3x/day
// cron.schedule('0 9,15,21 * * *', async () => {
//   try {
//     const r = await fetch(`http://localhost:${PORT}/make`);
//     console.log('Cron /make status:', r.status);
//   } catch (e) {
//     console.error('Cron error:', e);
//   }
// });

app.listen(PORT, () => {
  console.log(`Server on :${PORT}`);
});
