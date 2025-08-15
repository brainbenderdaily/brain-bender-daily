const express = require('express');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const axios = require('axios');
const googleTTS = require('google-tts-api');
const cron = require('node-cron');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

/*
 * Brain Bender Daily – Dynamic Shorts Generator
 *
 * This server produces engaging YouTube Shorts featuring a riddle,
 * dynamic text overlays, a spoken narration and simple countdown
 * animations.  Compared to the prior version, we leverage ffmpeg
 * filters to overlay the question, a countdown (3…2…1), the answer
 * reveal and a call‑to‑action, while applying fade‑in/out
 * transitions.  A cron scheduler triggers three uploads per day.
 */

const app = express();
const port = process.env.PORT || 3000;

// OAuth configuration (values supplied via environment variables)
const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://brain-bender-daily.onrender.com/oauth2callback';
const REFRESH_TOKEN = process.env.YOUTUBE_REFRESH_TOKEN;

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);
if (REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
}
const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

// Read riddles dataset from data directory
function loadRiddles() {
  const file = path.join(__dirname, 'data', 'riddles.json');
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

// Fetch the TTS audio for a riddle using google-tts-api.  The audio
// includes both question and answer.  Returns the path to a
// temporary MP3 file.
async function generateVoice(riddle) {
  const phrase = `${riddle.question}. Answer: ${riddle.answer}. Follow for more brain teasers.`;
  const url = await googleTTS.getAudioUrl(phrase, {
    lang: 'en',
    slow: false,
    host: 'https://translate.google.com'
  });
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  const voicePath = path.join(__dirname, 'voice.mp3');
  fs.writeFileSync(voicePath, Buffer.from(response.data));
  return voicePath;
}

// Generate a dynamic video combining a background image, voice
// narration and multiple timed text overlays.  We use ffmpeg's
// drawtext filter with enable expressions to show the question,
// countdown numbers, answer and call‑to‑action at specific times.
// The video lasts 20 seconds and applies fade in/out.
function generateVideo(riddle, audioPath, outPath) {
  return new Promise((resolve, reject) => {
    // Path to a static background.  Use a plain colour if the
    // provided background is missing.
    const bg = path.join(__dirname, 'assets', 'bg.png');
    const bgInput = fs.existsSync(bg) ? ['-loop', '1', '-i', bg] : ['-f', 'lavfi', '-i', 'color=white:s=640x640'];

    // Prepare the text for ffmpeg (escape single quotes)
    const question = riddle.question.replace(/'/g, "\\'");
    const answer = riddle.answer.replace(/'/g, "\\'");

    // Build the complex filter string.  We use a single video stream
    // with fade effects, countdown numbers (3,2,1), reveal of the
    // answer and a call to action.  The countdown appears between
    // seconds 8–11.  The answer appears between seconds 13–18.  The
    // call to action appears for the last two seconds.
    const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
    const filter = [
      // Fade in/out on the base video
      "[0:v]format=yuv420p,fade=t=in:st=0:d=1,fade=t=out:st=19:d=1[v]",
      // Draw question from 0–12s
      `[v]drawtext=fontfile=${font}:text='${question}':fontcolor=white:fontsize=36:x=(w-text_w)/2:y=h*0.3:enable='between(t,0,12)'[v1]`,
      // Countdown numbers
      `[v1]drawtext=fontfile=${font}:text='3':fontcolor=red:fontsize=60:x=(w-text_w)/2:y=h*0.55:enable='between(t,8,9)'[v2]`,
      `[v2]drawtext=fontfile=${font}:text='2':fontcolor=red:fontsize=60:x=(w-text_w)/2:y=h*0.55:enable='between(t,9,10)'[v3]`,
      `[v3]drawtext=fontfile=${font}:text='1':fontcolor=red:fontsize=60:x=(w-text_w)/2:y=h*0.55:enable='between(t,10,11)'[v4]`,
      // Answer reveal between 13–18s
      `[v4]drawtext=fontfile=${font}:text='Answer: ${answer}':fontcolor=yellow:fontsize=36:x=(w-text_w)/2:y=h*0.6:enable='between(t,13,18)'[v5]`,
      // Call to action in the last 2 seconds
      `[v5]drawtext=fontfile=${font}:text='Follow for daily brain benders!':fontcolor=cyan:fontsize=28:x=(w-text_w)/2:y=h*0.9:enable='between(t,18,20)'[vout]`
    ].join(';');

    const args = [
      '-y',
      // Background input
      ...bgInput,
      // Audio input
      '-i', audioPath,
      '-filter_complex', filter,
      '-map', '[vout]',
      '-map', '1:a',
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-shortest',
      outPath
    ];
    execFile(ffmpegPath, args, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// Upload a video to YouTube as private
async function uploadVideo(videoPath, title, description) {
  const response = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: { title, description },
      status: { privacyStatus: 'private' }
    },
    media: {
      mimeType: 'video/mp4',
      body: fs.createReadStream(videoPath)
    }
  });
  return response.data.id;
}

// Main function to create and upload a short
async function createAndUpload() {
  const riddles = loadRiddles();
  const chosen = riddles[Math.floor(Math.random() * riddles.length)];
  const audioPath = await generateVoice(chosen);
  const videoPath = path.join(__dirname, 'video.mp4');
  await generateVideo(chosen, audioPath, videoPath);
  const videoId = await uploadVideo(videoPath, chosen.question, chosen.answer);
  // Clean up
  try { fs.unlinkSync(audioPath); } catch {}
  try { fs.unlinkSync(videoPath); } catch {}
  return { question: chosen.question, videoId };
}

// API endpoint for manual generation
app.get('/make', async (req, res) => {
  try {
    const result = await createAndUpload();
    res.json(result);
  } catch (err) {
    console.error('Generation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Health route
app.get('/', (req, res) => {
  res.send('Brain Bender Daily dynamic API is running');
});

// OAuth endpoints
app.get('/auth', (req, res) => {
  const scopes = ['https://www.googleapis.com/auth/youtube.upload'];
  const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: scopes, prompt: 'consent' });
  res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing code');
  try {
    const { tokens } = await oauth2Client.getToken(code);
    console.log('New refresh token:', tokens.refresh_token);
    res.send('Authorised successfully.  Check logs for refresh token.');
  } catch (err) {
    console.error('OAuth error:', err);
    res.status(500).send('OAuth failure');
  }
});

// Schedule: runs at 9, 15, and 21 UTC daily
cron.schedule('0 9,15,21 * * *', async () => {
  console.log('Scheduled job starting...');
  try {
    const result = await createAndUpload();
    console.log('Scheduled upload succeeded:', result.videoId);
  } catch (err) {
    console.error('Scheduled job failed:', err);
  }
});

// Start server
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});