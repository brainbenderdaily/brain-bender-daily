// =========================
// Brain Bender Daily - Server
// One-file drop-in (copy/paste)
// =========================

const express     = require('express');
const fs          = require('fs');
const path        = require('path');
const { google }  = require('googleapis');
const { getAudioUrl } = require('google-tts-api');
const fetch       = require('node-fetch');
const { spawnSync } = require('child_process');
const ffmpegPath  = require('ffmpeg-static');

// -------------------------
// ENV
// -------------------------
const PORT          = process.env.PORT || 3000;
const CLIENT_ID     = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.YOUTUBE_REFRESH_TOKEN;
const REDIRECT_URI  = process.env.REDIRECT_URI || `https://${process.env.RENDER_INTERNAL_HOSTNAME || 'localhost'}/oauth2callback`;

// -------------------------
// OAuth + YouTube
// -------------------------
const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
oauth2.setCredentials({ refresh_token: REFRESH_TOKEN });
const youtube = google.youtube({ version: 'v3', auth: oauth2 });

// -------------------------
// Paths
// -------------------------
const APP_ROOT   = process.cwd();
const DATA_DIR   = path.join(APP_ROOT, 'data');
const ASSETS_DIR = path.join(APP_ROOT, 'assets');
const FONT_PATH  = path.join(ASSETS_DIR, 'BebasNeue-Regular.ttf'); // <-- you uploaded this

// Startup sanity logs (show in Render Logs)
try {
  console.log('FONT_PATH:', FONT_PATH, 'exists:', fs.existsSync(FONT_PATH));
  if (fs.existsSync(ASSETS_DIR)) {
    console.log('Assets dir contents:', fs.readdirSync(ASSETS_DIR));
  }
} catch (e) {
  console.log('Startup check error:', e.message);
}

// -------------------------
// Helpers
// -------------------------
function escText(s) {
  return String(s)
    .replace(/\\/g, '\\\\')   // backslashes
    .replace(/:/g, '\\:')     // colons (drawtext separators)
    .replace(/'/g, "\\\\'");  // single quotes
}

function dt(text, { x="(w-text_w)/2", y="(h-text_h)/2", size=56, color="white",
                    start=0, end=3, border=4, borderColor="black@0.9" } = {}) {
  const t = escText(text);
  return `drawtext=fontfile='${FONT_PATH}':text='${t}':fontcolor=${color}:fontsize=${size}:x=${x}:y=${y}:borderw=${border}:bordercolor=${borderColor}:enable='between(t,${start},${end})'`;
}

function pickBackground() {
  try {
    if (fs.existsSync(ASSETS_DIR)) {
      const imgs = fs.readdirSync(ASSETS_DIR)
        .filter(f => /^background.*\.(png|jpg|jpeg)$/i.test(f));
      if (imgs.length) {
        const chosen = imgs[Math.floor(Math.random() * imgs.length)];
        return { kind: 'image', path: path.join(ASSETS_DIR, chosen) };
      }
    }
  } catch (_) {}
  return { kind: 'solid', color: '0x101020' }; // deep blue fallback
}

function loadRiddle() {
  const file = path.join(DATA_DIR, 'riddles.json');
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  return list[Math.floor(Math.random() * list.length)];
}

async function downloadToFile(url, outPath) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed: ${r.status}`);
  const buf = await r.buffer();
  fs.writeFileSync(outPath, buf);
  return outPath;
}

// -------------------------
// Audio build (TTS)
// -------------------------
async function buildVoiceTrack(question, answer) {
  const tmp = path.join(APP_ROOT, 'tmp');
  if (!fs.existsSync(tmp)) fs.mkdirSync(tmp);

  const qUrl = getAudioUrl(question,            { lang: 'en', slow: false, host: 'https://translate.google.com' });
  const aUrl = getAudioUrl(`Answer: ${answer}`, { lang: 'en', slow: false, host: 'https://translate.google.com' });

  const qMp3 = path.join(tmp, `q_${Date.now()}.mp3`);
  const aMp3 = path.join(tmp, `a_${Date.now()}.mp3`);
  const pad  = path.join(tmp, `pad_${Date.now()}.mp3`);
  const out  = path.join(tmp, `speech_${Date.now()}.mp3`);

  await downloadToFile(qUrl, qMp3);
  await downloadToFile(aUrl, aMp3);

  // 1s silence
  let args = ['-f','lavfi','-i','anullsrc=r=24000:cl=mono','-t','1','-q:a','9','-acodec','libmp3lame', pad];
  let p = spawnSync(ffmpegPath, args, { encoding: 'utf8' });
  if (p.status !== 0) {
    const msg = `ffmpeg(silence) failed\nARGS: ${args.join(' ')}\nSTDERR: ${p.stderr}`;
    console.error(msg); throw new Error(msg);
  }

  // concat q + pad + a
  const listFile = path.join(tmp, `list_${Date.now()}.txt`);
  fs.writeFileSync(listFile, `file '${qMp3}'\nfile '${pad}'\nfile '${aMp3}'\n`);
  args = ['-f','concat','-safe','0','-i', listFile, '-c','copy', out];
  p = spawnSync(ffmpegPath, args, { encoding: 'utf8' });
  if (p.status !== 0) {
    const msg = `ffmpeg(concat) failed\nARGS: ${args.join(' ')}\nSTDERR: ${p.stderr}`;
    console.error(msg); throw new Error(msg);
  }

  return out;
}

// -------------------------
// Video build (ffmpeg)
// -------------------------
async function createVideo(question, answer, audioPath) {
  const bg = pickBackground();
  const tmp = path.join(APP_ROOT, 'tmp');
  if (!fs.existsSync(tmp)) fs.mkdirSync(tmp);
  const out = path.join(tmp, `out_${Date.now()}.mp4`);

  // Filter chain (clean, safe)
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

  // Build args
  let args = [];
  if (bg.kind === 'image') {
    args.push('-loop','1','-i', bg.path);
  } else {
    args.push('-f','lavfi','-i', `color=c=${bg.color}:s=1080x1920:r=30`);
  }
  args.push('-i', audioPath);

  args.push(
    '-t','11',
    '-r','30',
    '-vf', filters,
    '-c:v','libx264','-preset','veryfast','-crf','22',
    '-c:a','aac','-b:a','128k',
    '-movflags','+faststart',
    '-shortest',
    out
  );

  const proc = spawnSync(ffmpegPath, args, { encoding: 'utf8' });
  if (proc.status !== 0) {
    const msg = [
      'ffmpeg failed',
      'ARGS: '   + args.join(' '),
      'STDERR: ' + (proc.stderr || '(empty)'),
      'STDOUT: ' + (proc.stdout || '(empty)'),
    ].join('\n');
    console.error(msg);
    throw new Error(msg);
  }

  return out;
}

// -------------------------
// Upload to YouTube (private)
// -------------------------
async function uploadToYouTube(filePath, title, description) {
  const size = fs.statSync(filePath).size;
  const res = await youtube.videos.insert({
    part: ['snippet','status'],
    requestBody: {
      snippet: { title, description, categoryId: '27' }, // 27 = Education
      status:  { privacyStatus: 'private' }
    },
    media: { body: fs.createReadStream(filePath), mimeType: 'video/mp4' },
  }, { maxContentLength: size, maxBodyLength: Infinity });

  return res.data.id;
}

// -------------------------
// Express
// -------------------------
const app = express();

app.get('/', (_, res) => res.json({ ok: true, hint: 'Call /make to generate a Short.' }));

app.get('/make', async (req, res) => {
  try {
    const { question, answer } = loadRiddle();
    const speech = await buildVoiceTrack(question, answer);
    const video  = await createVideo(question, answer, speech);

    const title = question.length > 90 ? question.slice(0, 90) + '…' : question;
    const desc  = `${question}\nAnswer: ${answer}\n#riddle #brainteaser #shorts`;

    const videoId = await uploadToYouTube(video, title, desc);

    // Best-effort cleanup
    try { fs.unlinkSync(video); fs.unlinkSync(speech); } catch (_) {}

    res.json({ question, answer, videoId });
  } catch (e) {
    console.error('Error in /make:', e && e.stack || e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// (Optional) Cron – enable if you want autoposting 3x/day
// const LOCAL = `http://localhost:${PORT}/make`;
// require('node-cron').schedule('0 9,15,21 * * *', async () => {
//   try { const r = await fetch(LOCAL); console.log('Cron /make', r.status); } catch (e) { console.error('Cron error', e.message); }
// });

app.listen(PORT, () => console.log(`Brain Bender Daily running on :${PORT}`));
