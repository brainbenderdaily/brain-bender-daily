import express from 'express';
import { google } from 'googleapis';
import googleTTS from 'google-tts-api';
import fetch from 'node-fetch';
import editly from 'editly';
import cron from 'node-cron';
import fs from 'fs/promises';
import path from 'path';

// Load riddles dataset
const riddles = JSON.parse(
  await fs.readFile(new URL('./data/riddles.json', import.meta.url), 'utf8'),
);

// Environment variables for YouTube and Pexels
const {
  YOUTUBE_CLIENT_ID,
  YOUTUBE_CLIENT_SECRET,
  YOUTUBE_REFRESH_TOKEN,
  PEXELS_API_KEY,
  PORT = 3000,
} = process.env;

// Configure OAuth2 client for YouTube uploads
function getOAuthClient() {
  const oauth2Client = new google.auth.OAuth2(
    YOUTUBE_CLIENT_ID,
    YOUTUBE_CLIENT_SECRET,
    `${process.env.REDIRECT_URI || ''}`,
  );
  if (YOUTUBE_REFRESH_TOKEN) {
    oauth2Client.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });
  }
  return oauth2Client;
}

// Fetch a random background. Prefer a local asset; fall back to Pexels API if available.
async function getRandomBackground(query = 'abstract background') {
  try {
    // Look for bundled backgrounds in the assets directory
    const assetsDir = new URL('./assets', import.meta.url);
    const files = await fs.readdir(assetsDir);
    const candidates = files.filter((f) =>
      f.match(/\.(png|jpg|jpeg)$/i),
    );
    if (candidates.length > 0) {
      const choice = candidates[Math.floor(Math.random() * candidates.length)];
      const localPath = path.join(path.dirname(assetsDir.pathname), choice);
      return localPath;
    }
  } catch (err) {
    // ignore local errors and try remote
  }
  // Attempt to download from Pexels if API key is provided
  if (!PEXELS_API_KEY) return null;
  try {
    const apiUrl = `https://api.pexels.com/v1/search?query=${encodeURIComponent(
      query,
    )}&orientation=portrait&per_page=30`;
    const response = await fetch(apiUrl, {
      headers: { Authorization: PEXELS_API_KEY },
    });
    if (!response.ok) throw new Error(`Pexels API error ${response.status}`);
    const data = await response.json();
    const photos = data.photos || [];
    if (photos.length) {
      const randomPhoto = photos[Math.floor(Math.random() * photos.length)];
      const imageUrl =
        randomPhoto.src.portrait || randomPhoto.src.large || randomPhoto.src.original;
      const imgRes = await fetch(imageUrl);
      const buffer = await imgRes.arrayBuffer();
      const filePath = path.join(process.cwd(), 'background.jpg');
      await fs.writeFile(filePath, Buffer.from(buffer));
      return filePath;
    }
  } catch (err) {
    console.error('Failed to fetch remote background:', err.message);
  }
  return null;
}

// Generate speech using google-tts-api and save to mp3
async function generateSpeech(text) {
  try {
    const url = googleTTS.getAudioUrl(text, {
      lang: 'en',
      slow: false,
      host: 'https://translate.google.com',
    });
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    const audioPath = path.join(process.cwd(), 'voice.mp3');
    await fs.writeFile(audioPath, Buffer.from(buffer));
    return audioPath;
  } catch (err) {
    console.error('Failed to generate speech:', err.message);
    return null;
  }
}

// Create a more dynamic video using Editly with countdown, answer and CTA
async function createVideo(question, answer, backgroundPath, audioPath) {
  const outputPath = path.join(process.cwd(), 'output.mp4');

  // Choose a fallback solid colour background if none is provided
  const bgLayer = backgroundPath
    ? { type: 'image', path: backgroundPath }
    : { type: 'solid-color', color: '#101010' };

  // Helper to clone bg layer for each clip (editly expects independent objects)
  function cloneBg() {
    return { ...bgLayer };
  }

  // Build the edit specification with multiple scenes, countdown and CTA
  const spec = {
    outPath: outputPath,
    width: 1080,
    height: 1920,
    fps: 30,
    audioFilePath: audioPath || undefined,
    defaultTransition: { duration: 0.5, name: 'fade' },
    clips: [
      // Intro slide
      {
        duration: 2,
        layers: [
          cloneBg(),
          {
            type: 'title',
            text: 'Brain Bender',
            fontSize: 80,
            color: '#FFD700',
            x: 0.5,
            y: 0.3,
            alignX: 'center',
            alignY: 'middle',
          },
          {
            type: 'title',
            text: "Today's Riddle",
            fontSize: 40,
            color: '#AAAAFF',
            x: 0.5,
            y: 0.55,
            alignX: 'center',
            alignY: 'middle',
          },
        ],
      },
      // Question slide
      {
        duration: 5,
        layers: [
          cloneBg(),
          {
            type: 'title',
            text: question,
            fontSize: 60,
            color: '#FFFFFF',
            x: 0.5,
            y: 0.4,
            alignX: 'center',
            alignY: 'middle',
            wrap: true,
          },
          {
            type: 'title',
            text: 'Think about it…',
            fontSize: 32,
            color: '#BBBBBB',
            x: 0.5,
            y: 0.8,
            alignX: 'center',
            alignY: 'middle',
          },
        ],
      },
      // Countdown: 3
      {
        duration: 1,
        layers: [
          cloneBg(),
          {
            type: 'title',
            text: 'Answer in…',
            fontSize: 36,
            color: '#DDDDDD',
            x: 0.5,
            y: 0.2,
            alignX: 'center',
            alignY: 'middle',
          },
          {
            type: 'title',
            text: '3',
            fontSize: 120,
            color: '#FF5555',
            x: 0.5,
            y: 0.5,
            alignX: 'center',
            alignY: 'middle',
          },
        ],
      },
      // Countdown: 2
      {
        duration: 1,
        layers: [
          cloneBg(),
          {
            type: 'title',
            text: 'Answer in…',
            fontSize: 36,
            color: '#DDDDDD',
            x: 0.5,
            y: 0.2,
            alignX: 'center',
            alignY: 'middle',
          },
          {
            type: 'title',
            text: '2',
            fontSize: 120,
            color: '#FFAA33',
            x: 0.5,
            y: 0.5,
            alignX: 'center',
            alignY: 'middle',
          },
        ],
      },
      // Countdown: 1
      {
        duration: 1,
        layers: [
          cloneBg(),
          {
            type: 'title',
            text: 'Answer in…',
            fontSize: 36,
            color: '#DDDDDD',
            x: 0.5,
            y: 0.2,
            alignX: 'center',
            alignY: 'middle',
          },
          {
            type: 'title',
            text: '1',
            fontSize: 120,
            color: '#FFFF55',
            x: 0.5,
            y: 0.5,
            alignX: 'center',
            alignY: 'middle',
          },
        ],
      },
      // Answer slide
      {
        duration: 5,
        layers: [
          cloneBg(),
          {
            type: 'title',
            text: `Answer: ${answer}`,
            fontSize: 60,
            color: '#00FFAA',
            x: 0.5,
            y: 0.4,
            alignX: 'center',
            alignY: 'middle',
            wrap: true,
          },
          {
            type: 'title',
            text: 'Did you get it right?',
            fontSize: 32,
            color: '#8888FF',
            x: 0.5,
            y: 0.8,
            alignX: 'center',
            alignY: 'middle',
          },
        ],
      },
      // Call-to-action slide
      {
        duration: 3,
        layers: [
          cloneBg(),
          {
            type: 'title',
            text: 'Follow @BrainBenderDaily',
            fontSize: 50,
            color: '#00BFFF',
            x: 0.5,
            y: 0.4,
            alignX: 'center',
            alignY: 'middle',
          },
          {
            type: 'title',
            text: 'for daily brain benders!',
            fontSize: 32,
            color: '#FF77FF',
            x: 0.5,
            y: 0.6,
            alignX: 'center',
            alignY: 'middle',
          },
        ],
      },
    ],
  };
  // Render video
  await editly(spec);
  return outputPath;
}

// Upload MP4 to YouTube
async function uploadToYouTube(videoPath, title, description) {
  const oauth2Client = getOAuthClient();
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  const fileSize = (await fs.stat(videoPath)).size;
  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    notifySubscribers: false,
    requestBody: {
      snippet: {
        title,
        description,
        categoryId: '27', // Education
      },
      status: {
        privacyStatus: 'private',
      },
    },
    media: {
      mimeType: 'video/mp4',
      body: fs.createReadStream(videoPath),
    },
  }, {
    // Provide the media upload's length for the resumable uploader.
    onUploadProgress: (evt) => {
      const progress = (evt.bytesRead / fileSize) * 100;
      process.stdout.write(`Uploading: ${progress.toFixed(2)}%\r`);
    },
  });
  return res.data.id;
}

// Primary function to generate and upload a riddle video
async function generateAndUpload() {
  try {
    const { question, answer } = riddles[Math.floor(Math.random() * riddles.length)];
    // Combine question and answer in voice text
    const voiceText = `${question} Answer: ${answer}`;
    // Fetch background; fallback to null
    const bgFile = await getRandomBackground('abstract');
    const audioPath = await generateSpeech(voiceText);
    const videoPath = await createVideo(question, answer, bgFile, audioPath);
    const videoId = await uploadToYouTube(
      videoPath,
      question,
      `Brain teaser and solution. Follow for more brain benders!`,
    );
    // Clean up temporary files
    if (bgFile) await fs.unlink(bgFile).catch(() => {});
    if (audioPath) await fs.unlink(audioPath).catch(() => {});
    await fs.unlink(videoPath).catch(() => {});
    return { question, videoId };
  } catch (err) {
    console.error('Error generating or uploading:', err);
    return { error: err.message };
  }
}

// Express server setup
const app = express();
app.get('/', (req, res) => {
  res.send('Brain Bender Daily Editly API is running.');
});

// Endpoint to trigger video creation on demand
app.get('/make', async (req, res) => {
  const result = await generateAndUpload();
  res.json(result);
});

// OAuth routes for initial authentication (optional reauth)
app.get('/auth', (req, res) => {
  const oauth2Client = getOAuthClient();
  const scopes = ['https://www.googleapis.com/auth/youtube.upload'];
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent',
  });
  res.redirect(authUrl);
});

app.get('/oauth2callback', async (req, res) => {
  try {
    const oauth2Client = getOAuthClient();
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    console.log('Received tokens:', tokens);
    res.send('Authorization successful. Check server logs for tokens.');
  } catch (err) {
    console.error(err);
    res.status(500).send('OAuth callback error');
  }
});

// Schedule three uploads per day at 09:00, 15:00, 21:00 UTC
cron.schedule('0 9,15,21 * * *', async () => {
  console.log('Scheduled generation triggered.');
  await generateAndUpload();
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});