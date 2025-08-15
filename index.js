const express = require('express');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { getAudioUrl } = require('google-tts-api');
const fetch = require('node-fetch');
const { spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const cron = require('node-cron');

/*
 * Brain Bender Daily automated content creator
 *
 * This script uses only free/open‑source libraries to generate engaging
 * YouTube Shorts. It synthesizes a voice‑over with Google TTS, overlays
 * multiple lines of text with countdown timers on top of a random
 * background and mixes the audio with the footage via ffmpeg. The
 * resulting video is uploaded privately to the configured channel via
 * the YouTube Data API. A built‑in cron job runs three times per day
 * to keep the channel active without human intervention.
 */

// Load environment variables
const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.YOUTUBE_REFRESH_TOKEN;
const REDIRECT_URI = process.env.REDIRECT_URI || `https://${process.env.RENDER_INTERNAL_HOSTNAME || 'localhost'}/oauth2callback`;

// OAuth2 client for YouTube API
const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);
if (REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
}

const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

const app = express();
app.use(express.json());

/**
 * Choose a random riddle from the data file.
 */
function getRandomRiddle() {
  const riddles = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'data', 'riddles.json'), 'utf8')
  );
  return riddles[Math.floor(Math.random() * riddles.length)];
}

/**
 * Select a random background image from the assets folder. If none exist, return
 * a solid colour background (white).
 */
function getRandomBackground() {
  const assetsDir = path.join(__dirname, 'assets');
  const files = fs.readdirSync(assetsDir).filter((f) => /\.(png|jpe?g)$/i.test(f));
  if (files.length === 0) {
    return null;
  }
  return path.join(assetsDir, files[Math.floor(Math.random() * files.length)]);
}

/**
 * Generate a temporary MP3 file for the narration using Google TTS. The
 * returned promise resolves with the path to the saved file.
 */
async function generateSpeech(question, answer) {
  // Combine the question and answer into one narration string. We leave a
  // short pause by adding a period and a short phrase.
  const narration = `${question} Answer: ${answer}`;
  const url = await getAudioUrl(narration, {
    lang: 'en',
    slow: false,
    host: 'https://translate.google.com',
  });
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch TTS audio: ${response.statusText}`);
  }
  const buffer = await response.buffer();
  const tmpPath = path.join(__dirname, `speech_${Date.now()}.mp3`);
  fs.writeFileSync(tmpPath, buffer);
  return tmpPath;
}

/**
 * Create a video using ffmpeg with dynamic overlays. The video will be
 * vertical (1080x1920) and last ~16 seconds. It shows an intro slide,
 * the riddle question, a countdown, the answer, and a call‑to‑action.
 */
function createVideo({ question, answer }, bgImage, audioFile, outputPath) {
  // Escape single quotes and colons in text for ffmpeg drawtext filters.
  const esc = (text) => text.replace(/'/g, "\\'").replace(/:/g, '\\:');
  const questionText = esc(question);
  const answerText = esc(`Answer: ${answer}`);
  const callToAction = esc('Follow for daily brain benders!');
  const introTitle = esc('Brain Bender Daily');
  const subtitle = esc("Today's Riddle");
  // Choose a font installed in the container; DejaVu Sans is widely available.
  const font = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  // Build the ffmpeg filter_complex string. Each drawtext uses the enable
  // expression to show during a specific time range.
  const filter = [
    // Intro (0–2s)
    `drawtext=fontfile=${font}:text='${introTitle}':fontsize=72:fontcolor=white:x=(w-text_w)/2:y=h*0.3:enable='between(t,0,2)'`,
    `drawtext=fontfile=${font}:text='${subtitle}':fontsize=40:fontcolor=white:x=(w-text_w)/2:y=h*0.4:enable='between(t,0,2)'`,
    // Question (2–7s)
    `drawtext=fontfile=${font}:text='${questionText}':fontsize=48:fontcolor=yellow:x=(w-text_w)/2:y=h*0.35:enable='between(t,2,7)'`,
    `drawtext=fontfile=${font}:text='Think about it...':fontsize=32:fontcolor=white:x=(w-text_w)/2:y=h*0.45:enable='between(t,2,7)'`,
    // Countdown (7–10s)
    `drawtext=fontfile=${font}:text='Answer in 3':fontsize=64:fontcolor=red:x=(w-text_w)/2:y=h*0.5:enable='between(t,7,8)'`,
    `drawtext=fontfile=${font}:text='Answer in 2':fontsize=64:fontcolor=red:x=(w-text_w)/2:y=h*0.5:enable='between(t,8,9)'`,
    `drawtext=fontfile=${font}:text='Answer in 1':fontsize=64:fontcolor=red:x=(w-text_w)/2:y=h*0.5:enable='between(t,9,10)'`,
    // Answer reveal (10–14s)
    `drawtext=fontfile=${font}:text='${answerText}':fontsize=48:fontcolor=cyan:x=(w-text_w)/2:y=h*0.4:enable='between(t,10,14)'`,
    `drawtext=fontfile=${font}:text='Did you get it right?':fontsize=32:fontcolor=white:x=(w-text_w)/2:y=h*0.5:enable='between(t,10,14)'`,
    // Call to action (14–16s)
    `drawtext=fontfile=${font}:text='${callToAction}':fontsize=36:fontcolor=white:x=(w-text_w)/2:y=h*0.45:enable='between(t,14,16)'`,
    // Fade in/out
    `fade=t=in:st=0:d=0.5`,
    `fade=t=out:st=15.5:d=0.5`,
  ].join(',');
  // Build arguments
  const args = [
    '-y',
    '-loop', '1',
    '-i', bgImage || path.join(__dirname, 'assets', 'bg.png'),
    '-i', audioFile,
    '-t', '16', // total duration (sec)
    '-vf', filter,
    '-s', '1080x1920',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-shortest',
    outputPath,
  ];
  const result = spawnSync(ffmpegPath, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed with code ${result.status}`);
  }
}

/**
 * Upload a local video to YouTube as a private short.
 */
async function uploadToYouTube(videoPath, title, description) {
  const fileSize = fs.statSync(videoPath).size;
  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    notifySubscribers: false,
    requestBody: {
      snippet: {
        title,
        description,
        categoryId: '24', // categoryId 24 = Entertainment
      },
      status: {
        privacyStatus: 'private',
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: fs.createReadStream(videoPath),
    },
  }, {
    // Use the onUploadProgress event to log progress
    onUploadProgress: (evt) => {
      const progress = (evt.bytesRead / fileSize) * 100;
      process.stdout.write(`Uploading to YouTube: ${progress.toFixed(2)}%\r`);
    },
  });
  return res.data.id;
}

/**
 * Orchestrate the entire video creation and upload process.
 */
async function handleRequest() {
  const riddle = getRandomRiddle();
  // Generate speech
  const audioPath = await generateSpeech(riddle.question, riddle.answer);
  // Choose a background (fallback to default if null)
  const bgPath = getRandomBackground() || path.join(__dirname, 'assets', 'bg.png');
  // Output video
  const videoPath = path.join(__dirname, `video_${Date.now()}.mp4`);
  try {
    createVideo(riddle, bgPath, audioPath, videoPath);
    const title = riddle.question;
    const description = `${riddle.question} ${riddle.answer} #shorts #riddle`;
    const videoId = await uploadToYouTube(videoPath, title, description);
    return { question: riddle.question, answer: riddle.answer, videoId };
  } finally {
    // Clean up temporary files
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
  }
}

// Routes
app.get('/', (req, res) => {
  res.send('Brain Bender Daily API is running.');
});

app.get('/make', async (req, res) => {
  try {
    const result = await handleRequest();
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// OAuth route to initiate YouTube auth if needed
app.get('/auth', (req, res) => {
  const scopes = ['https://www.googleapis.com/auth/youtube.upload'];
  const authUrl = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: scopes });
  res.redirect(authUrl);
});

// OAuth callback route
app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing code');
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    console.log('REFRESH_TOKEN:', tokens.refresh_token);
    res.send('Authorization successful! You can close this window.');
  } catch (err) {
    console.error(err);
    res.status(500).send('Authentication failed');
  }
});

// Cron schedule: run 3 times per day at 09:00, 15:00, and 21:00 UTC
cron.schedule('0 9,15,21 * * *', async () => {
  console.log('Cron: creating scheduled short...');
  try {
    const result = await handleRequest();
    console.log('Scheduled video created:', result.videoId);
  } catch (err) {
    console.error('Scheduled run failed:', err);
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});