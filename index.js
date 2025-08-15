const express = require('express');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const Jimp = require('jimp');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

/*
 * Minimal Brain Bender Daily API
 *
 * This server exposes a handful of HTTP endpoints to support an
 * automated, faceless YouTube channel.  The heavy lifting of
 * synthesising video from text has been stripped down to the bare
 * essentials: generate a simple image with the riddle and answer
 * using Jimp, then convert that image into a short silent video
 * using ffmpeg.  This drastically reduces memory usage compared
 * with more complex pipelines while still producing a valid MP4
 * suitable for YouTube Shorts.  OAuth credentials are provided via
 * environment variables, and you only need to authorise once to
 * obtain a refresh token.  See README for usage.
 */

const app = express();
const port = process.env.PORT || 3000;

// OAuth2 configuration.  A redirect URI can be customised via
// REDIRECT_URI, but defaults to the standard Render callback.  You
// must set YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET and
// YOUTUBE_REFRESH_TOKEN in your environment.
const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://brain-bender-daily.onrender.com/oauth2callback';
const REFRESH_TOKEN = process.env.YOUTUBE_REFRESH_TOKEN;

// Configure the OAuth2 client and YouTube API client
const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);
if (REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
}
const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

/**
 * Split a string into lines no longer than maxChars per line.
 * This helps ensure the text fits neatly onto the generated image.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]}
 */
function wrapText(text, maxChars) {
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';
  words.forEach(word => {
    // If adding this word would exceed the limit, push the current
    // line and start a new one.
    if ((current + word).length > maxChars) {
      lines.push(current.trim());
      current = '';
    }
    current += word + ' ';
  });
  if (current.trim()) lines.push(current.trim());
  return lines;
}

/**
 * Generate an image containing the riddle and its answer.  Uses a
 * square canvas to ensure proper aspect ratio when converting to
 * video.  Text is centred vertically and horizontally.
 *
 * @param {string} text Combined question and answer
 * @param {string} outPath Path to save the PNG file
 */
async function generateImage(text, outPath) {
  const size = 640; // 640x640 square canvas
  const background = 0xffffffff; // white background
  const image = new Jimp(size, size, background);
  const font = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK);
  const lines = wrapText(text, 40);
  // Calculate total text height to centre vertically
  const lineHeight = Jimp.measureTextHeight(font, 'A', size);
  const totalHeight = lines.length * lineHeight + (lines.length - 1) * 10;
  let y = (size - totalHeight) / 2;
  lines.forEach(line => {
    const textWidth = Jimp.measureText(font, line);
    const x = (size - textWidth) / 2;
    image.print(font, x, y, line);
    y += lineHeight + 10;
  });
  await image.writeAsync(outPath);
}

/**
 * Convert a still image into a short MP4 using ffmpeg.  Uses
 * a single image looped for the duration with libx264 encoding.
 *
 * @param {string} imagePath Path to the input PNG
 * @param {string} outPath Path to save the MP4
 * @param {number} durationSeconds Video duration
 */
function generateVideo(imagePath, outPath, durationSeconds = 20) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-loop', '1',
      '-i', imagePath,
      '-c:v', 'libx264',
      '-t', String(durationSeconds),
      '-pix_fmt', 'yuv420p',
      outPath
    ];
    execFile(ffmpegPath, args, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

/**
 * Upload a video to YouTube.  Expects the OAuth2 client to have
 * valid refresh credentials.  The video will be uploaded as
 * unlisted by default.
 *
 * @param {string} videoPath Path to the MP4 file
 * @param {string} title Video title
 * @param {string} description Video description
 * @returns {Promise<string>} Video ID
 */
async function uploadVideo(videoPath, title, description) {
  const response = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title,
        description
      },
      status: {
        privacyStatus: 'private'
      }
    },
    media: {
      mimeType: 'video/mp4',
      body: fs.createReadStream(videoPath)
    }
  });
  return response.data.id;
}

/**
 * Primary endpoint: generate a video from a random riddle and upload
 * it to YouTube.  Responds with the chosen riddle and the video ID.
 */
app.get('/make', async (req, res) => {
  try {
    const riddles = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'data', 'riddles.json'), 'utf8')
    );
    const random = riddles[Math.floor(Math.random() * riddles.length)];
    const combinedText = `${random.question}\n\nAnswer: ${random.answer}`;
    const imagePath = path.join(__dirname, 'temp.png');
    const videoPath = path.join(__dirname, 'output.mp4');
    await generateImage(combinedText, imagePath);
    await generateVideo(imagePath, videoPath);
    const videoId = await uploadVideo(
      videoPath,
      random.question,
      random.answer
    );
    // Clean up temporary files
    try { fs.unlinkSync(imagePath); } catch {}
    try { fs.unlinkSync(videoPath); } catch {}
    res.json({ question: random.question, videoId });
  } catch (error) {
    console.error('Error in /make:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check route
app.get('/', (req, res) => {
  res.send('Brain Bender Daily minimal API is running');
});

// OAuth routes for obtaining a new refresh token.  These are only
// needed if you need to re-authorise the application.  The
// authorised redirect URI must match the one configured in Google
// Cloud.
app.get('/auth', (req, res) => {
  const scopes = ['https://www.googleapis.com/auth/youtube.upload'];
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
  });
  res.redirect(authUrl);
});

app.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('No code provided');
  try {
    const { tokens } = await oauth2Client.getToken(String(code));
    console.log('New tokens acquired:', tokens);
    // Refresh token is logged; you must store it in YOUTUBE_REFRESH_TOKEN env
    res.send('Tokens acquired. Check your server logs for the refresh token.');
  } catch (error) {
    console.error('Error exchanging code:', error);
    res.status(500).send('Error retrieving access token');
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});