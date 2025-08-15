const express = require('express');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const Jimp = require('jimp');
const axios = require('axios');
const googleTTS = require('google-tts-api');
const cron = require('node-cron');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

/*
 * Brain Bender Daily – Voice and Animation
 *
 * This server builds on the cron implementation by adding a
 * narration soundtrack and simple fade animations.  After
 * selecting a random riddle, it renders a 640×640 image with
 * both the question and answer, synthesises voice via
 * google-tts-api, and uses ffmpeg to merge the two into a 20
 * second MP4.  Fade‑in and fade‑out effects are applied to the
 * video, and the audio drives the duration.  A built‑in cron
 * schedule triggers generation three times daily.  The YouTube
 * upload uses a refresh token for authentication.
 */

const app = express();
const port = process.env.PORT || 3000;

// OAuth configuration
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

// Helper to wrap text for the image
function wrapText(text, maxChars) {
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';
  words.forEach(word => {
    if ((current + word).length > maxChars) {
      lines.push(current.trim());
      current = '';
    }
    current += word + ' ';
  });
  if (current.trim()) lines.push(current.trim());
  return lines;
}

// Create an image for the riddle
async function generateImage(text, outPath) {
  const size = 640;
  const img = new Jimp(size, size, 0xffffffff);
  const font = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK);
  const lines = wrapText(text, 40);
  const lineHeight = Jimp.measureTextHeight(font, 'A', size);
  const totalHeight = lines.length * lineHeight + (lines.length - 1) * 10;
  let y = (size - totalHeight) / 2;
  for (const line of lines) {
    const w = Jimp.measureText(font, line);
    const x = (size - w) / 2;
    img.print(font, x, y, line);
    y += lineHeight + 10;
  }
  await img.writeAsync(outPath);
}

// Generate speech using google-tts-api.  The voice includes both
// question and answer.  A temporary MP3 is returned.
async function generateVoice(riddle) {
  const phrase = `${riddle.question}. Answer: ${riddle.answer}.`;
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

// Merge image and audio with simple fade animations
function generateVideo(imagePath, audioPath, outPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-loop', '1',
      '-i', imagePath,
      '-i', audioPath,
      '-filter_complex',
      // Apply fade in and fade out on the video stream
      // fade=in at 0 for 1 second, fade=out at t=end-1 for 1 second
      "[0:v]format=yuv420p,fade=t=in:st=0:d=1,fade=t=out:st=19:d=1[v]",
      '-map', '[v]',
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

// Upload to YouTube
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

// Core function to create and upload a video
async function createAndUpload() {
  const riddles = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'data', 'riddles.json'), 'utf8')
  );
  const random = riddles[Math.floor(Math.random() * riddles.length)];
  const combinedText = `${random.question}\n\nAnswer: ${random.answer}`;
  const imagePath = path.join(__dirname, 'frame.png');
  const audioPath = await generateVoice(random);
  const videoPath = path.join(__dirname, 'video.mp4');
  await generateImage(combinedText, imagePath);
  await generateVideo(imagePath, audioPath, videoPath);
  const videoId = await uploadVideo(videoPath, random.question, random.answer);
  // Clean up
  try { fs.unlinkSync(imagePath); } catch {}
  try { fs.unlinkSync(audioPath); } catch {}
  try { fs.unlinkSync(videoPath); } catch {}
  return { question: random.question, videoId };
}

// HTTP endpoint for ad hoc generation
app.get('/make', async (req, res) => {
  try {
    const result = await createAndUpload();
    res.json(result);
  } catch (err) {
    console.error('Generation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Health endpoint
app.get('/', (req, res) => {
  res.send('Brain Bender Daily voice+anim API is running');
});

// OAuth routes
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

// Schedule generation at 9, 15, 21 UTC daily
cron.schedule('0 9,15,21 * * *', async () => {
  console.log('Scheduled job: creating video...');
  try {
    const result = await createAndUpload();
    console.log('Scheduled upload:', result.videoId);
  } catch (err) {
    console.error('Scheduled job failed:', err);
  }
}, { timezone: 'UTC' });

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});