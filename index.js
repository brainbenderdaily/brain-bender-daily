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

// Create video using Editly with countdown, answer and CTA
async function createVideo(question, answer, backgroundPath, audioPath) {
  const outputPath = path.join(process.cwd(), 'output.mp4');
  // Build the edit specification
  const clips = [];
  // Intro with question
  clips.push({
    duration: 4,
    layers: [
      backgroundPath
        ? { type: 'image', path: backgroundPath }
        : { type: 'solid-color', color: '#1d1d1d' },
      {
        type: 'title',
        text: question,
        color: 'white',
        fontSize: 60,
        x: 0.5,
        y: 0.4,
        alignX: 'center',
        alignY: 'middle',
      },
    ],
  });
  // Countdown 3,2,1
  ['3', '2', '1'].forEach((num) => {
    clips.push({
      duration: 1,
      layers: [
        backgroundPath
          ? { type: 'image', path: backgroundPath }
          : { type: 'solid-color', color: '#0f0f0f' },
        {
          type: 'title',
          text: num,
          color: '#ff5555',
          fontSize: 120,
          x: 0.5,
          y: 0.5,
          alignX: 'center',
          alignY: 'middle',
        },
      ],
    });
  });
  // Reveal answer
  clips.push({
    duration: 4,
    layers: [
      backgroundPath
        ? { type: 'image', path: backgroundPath }
        : { type: 'solid-color', color: '#1d1d1d' },
      {
        type: 'title',
        text: `Answer: ${answer}`,
        color: '#ffdd00',
        fontSize: 60,
        x: 0.5,
        y: 0.4,
        alignX: 'center',
        alignY: 'middle',
      },
    ],
  });
  // Call to action
  clips.push({
    duration: 3,
    layers: [
      backgroundPath
        ? { type: 'image', path: backgroundPath }
        : { type: 'solid-color', color: '#0f0f0f' },
      {
        type: 'title',
        text: 'Follow for daily brain benders!',
        color: '#00ddff',
        fontSize: 40,
        x: 0.5,
        y: 0.6,
        alignX: 'center',
        alignY: 'middle',
      },
    ],
  });
  // Build and render video
  await editly({
    outPath: outputPath,
    width: 1080,
    height: 1920,
    fps: 30,
    audioFilePath: audioPath || undefined,
    clips,
    defaultTransition: { duration: 0.5 },
  });
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