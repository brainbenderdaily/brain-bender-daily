const express = require('express');
const { google } = require('googleapis');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const Jimp = require('jimp');
const fs = require('fs');
const path = require('path');

// Load riddles from JSON data folder
const riddles = require('./data/riddles.json');

const app = express();
const port = process.env.PORT || 3000;

// Configure OAuth2 client for YouTube uploads.  The refresh token
// should be stored in the environment so uploads can occur without
// further user interaction.  The redirect URI defaults to the
// Render deployment URL but can be overridden via ENV.
const oauth2Client = new google.auth.OAuth2(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
  process.env.REDIRECT_URI || 'https://brain-bender-daily.onrender.com/oauth2callback'
);

// If a refresh token is available, set it so API calls will use it
if (process.env.YOUTUBE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });
}

/**
 * Generate an image with the given text.  The image is a black
 * rectangle sized for a vertical short (1080×1920) with white
 * centered text.  Lines are automatically wrapped to fit.
 *
 * @param {string} text The text to render on the image
 * @param {string} outputPath Path where the image should be written
 */
async function generateImage(text, outputPath) {
  const width = 1080;
  const height = 1920;
  // Create a blank black image
  const image = new Jimp(width, height, 0x000000ff);
  const font = await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE);
  const margin = 50;
  const maxWidth = width - margin * 2;
  const words = text.split(' ');
  let lines = [];
  let currentLine = '';
  // Construct lines that fit within maxWidth
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

/**
 * Convert a single frame image into a silent video using ffmpeg.  The
 * resulting video will be 20 seconds long to satisfy YouTube Shorts
 * duration requirements.
 *
 * @param {string} imagePath Path to the PNG file to convert
 * @param {string} outputPath Path where the MP4 should be written
 */
async function generateVideo(imagePath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.setFfmpegPath(ffmpegStatic);
    ffmpeg()
      .addInput(imagePath)
      .loop(20)
      .outputOptions([
        '-c:v libx264',
        '-pix_fmt yuv420p',
        '-t 20'
      ])
      .save(outputPath)
      .on('end', resolve)
      .on('error', reject);
  });
}

/**
 * Upload a video file to YouTube as a private video.  Requires
 * authenticated oauth2Client with a valid refresh token.
 *
 * @param {string} filePath Path to the MP4 to upload
 * @param {string} title Title for the YouTube video
 * @param {string} description Description for the YouTube video
 */
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

// Endpoint to generate and upload a short video.  A random riddle is
// chosen, an image is rendered with the riddle and answer, a video
// is produced, uploaded to YouTube, then temporary files are removed.
app.get('/make', async (req, res) => {
  try {
    const riddle = riddles[Math.floor(Math.random() * riddles.length)];
    const text = `${riddle.question}\n\nAnswer: ${riddle.answer}`;
    const imgPath = path.join(__dirname, 'temp_image.png');
    const videoPath = path.join(__dirname, 'temp_video.mp4');
    await generateImage(text, imgPath);
    await generateVideo(imgPath, videoPath);
    const result = await uploadVideo(videoPath, riddle.question, riddle.answer);
    // Clean up temporary files
    fs.unlinkSync(imgPath);
    fs.unlinkSync(videoPath);
    res.json({ message: 'Video uploaded successfully', videoId: result.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint to begin OAuth2 flow
app.get('/auth', (req, res) => {
  const scopes = ['https://www.googleapis.com/auth/youtube.upload'];
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes
  });
  res.redirect(url);
});

// Endpoint to handle OAuth2 callback
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

// Basic health check
app.get('/', (req, res) => {
  res.send('Brain Bender Daily API is running.');
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});