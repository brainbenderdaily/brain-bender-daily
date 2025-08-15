const express = require('express');
const { google } = require('googleapis');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const Jimp = require('jimp');
const fs = require('fs');
const path = require('path');

const riddles = require('./data/riddles.json');

const app = express();
const port = process.env.PORT || 3000;

const oauth2Client = new google.auth.OAuth2(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
  process.env.REDIRECT_URI || 'https://brain-bender-daily.onrender.com/oauth2callback'
);

if (process.env.YOUTUBE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });
}

async function generateImage(text, outputPath) {
  const width = 1080;
  const height = 1920;
  const image = new Jimp(width, height, 0x000000FF);
  const font = await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE);
  const margin = 50;
  const maxWidth = width - margin * 2;
  const words = text.split(' ');
  let lines = [];
  let currentLine = '';
  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const testWidth = Jimp.measureText(font, testLine);
    if (testWidth > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);
  const lineHeight = Jimp.measureTextHeight(font, 'A', maxWidth);
  const totalHeight = lines.length * lineHeight;
  let y = (height - totalHeight) / 2;
  for (const line of lines) {
    const lineWidth = Jimp.measureText(font, line);
    const x = (width - lineWidth) / 2;
    image.print(font, x, y, line);
    y += lineHeight;
  }
  await image.writeAsync(outputPath);
}

async function generateVideo(imagePath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.setFfmpegPath(ffmpegStatic);
    ffmpeg()
      .addInput(imagePath)
      .loop(20)
      .outputOptions(['-c:v libx264', '-pix_fmt yuv420p', '-t 20'])
      .save(outputPath)
      .on('end', resolve)
      .on('error', reject);
  });
}

async function uploadVideo(filePath, title, description) {
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: { title, description, categoryId: '27' },
      status: { privacyStatus: 'private' }
    },
    media: { body: fs.createReadStream(filePath) }
  });
  return res.data;
}

app.get('/make', async (req, res) => {
  try {
    const riddle = riddles[Math.floor(Math.random() * riddles.length)];
    const text = `${riddle.question}\n\nAnswer: ${riddle.answer}`;
    const imgPath = path.join(__dirname, 'temp_image.png');
    const videoPath = path.join(__dirname, 'temp_video.mp4');
    await generateImage(text, imgPath);
    await generateVideo(imgPath, videoPath);
    const result = await uploadVideo(videoPath, riddle.question, riddle.answer);
    fs.unlinkSync(imgPath);
    fs.unlinkSync(videoPath);
    res.json({ message: 'Video uploaded successfully', videoId: result.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/auth', (req, res) => {
  const scopes = ['https://www.googleapis.com/auth/youtube.upload'];
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes
  });
  res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('Missing code parameter');
  }
  try {
    const { tokens } = await oauth2Client.getToken(code);
    if (tokens.refresh_token) {
      console.log('REFRESH_TOKEN:', tokens.refresh_token);
    }
    oauth2Client.setCredentials(tokens);
    res.send('Authorization successful. Refresh token logged to server logs.');
  } catch (err) {
    console.error('Error exchanging code for tokens:', err);
    res.status(500).send('Authentication error');
  }
});

app.get('/', (req, res) => {
  res.send('Brain Bender Daily API is running.');
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
