const express = require('express');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const Jimp = require('jimp');
const axios = require('axios');
const googleTTS = require('google-tts-api');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const cron = require('node-cron');

/*
 * Brain Bender Daily – Cron‑enabled API
 *
 * This implementation expands on the minimal server by adding
 * narration and a built‑in scheduler.  It converts a riddle into
 * an image using Jimp, synthesises speech via the free
 * google‑tts‑api package, combines them into a short video with
 * ffmpeg and uploads the result to YouTube.  A cron job runs the
 * generation three times per day (09:00, 15:00 and 21:00 UTC) so
 * you can keep your channel populated without any external
 * automation service.  Use environment variables for OAuth and
 * refresh tokens as described in the README.  Health check and
 * OAuth routes are provided for diagnostics and re‑authorisation.
 */

const app = express();
const port = process.env.PORT || 3000;

// OAuth2 configuration.  The client ID, client secret and
// refresh token must be set in the environment.  Optionally, the
// redirect URI can be customised via REDIRECT_URI.  See the
// README for instructions on obtaining these values.
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

/**
 * Split text into an array of lines with a maximum number of
 * characters per line.  Ensures text wraps neatly on the image.
 *
 * @param {string} text The full string to wrap
 * @param {number} maxChars Maximum characters per line
 * @returns {string[]} The wrapped lines
 */
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

/**
 * Generate an image containing the given text.  A square 640×640
 * canvas is used for Shorts, with the text centred.  The text
 * should include both question and answer.
 *
 * @param {string} text The question and answer combined
 * @param {string} outPath Output PNG path
 */
async function generateImage(text, outPath) {
  const size = 640;
  const bgColour = 0xffffffff; // white
  const image = new Jimp(size, size, bgColour);
  const font = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK);
  const lines = wrapText(text, 40);
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
 * Synthesize speech for a riddle using the google-tts-api.  The
 * synthesised text includes both the question and the answer so
 * that viewers hear the solution at the end.  The returned file
 * path points to a temporary MP3 on disk.  Temporary files are
 * overwritten each time.
 *
 * @param {{question: string, answer: string}} riddle
 * @returns {Promise<string>} Absolute path to the saved MP3 file
 */
async function generateVoice(riddle) {
  const phrase = `${riddle.question}. Answer: ${riddle.answer}.`;
  const url = await googleTTS.getAudioUrl(phrase, { lang: 'en', slow: false, host: 'https://translate.google.com' });
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  const voicePath = path.join(__dirname, 'voice.mp3');
  fs.writeFileSync(voicePath, Buffer.from(response.data));
  return voicePath;
}

/**
 * Use ffmpeg to merge a still image and an audio track into a
 * short video.  The video will end when the audio ends.  Both
 * inputs are assumed to be local files.  Temporary output files
 * are overwritten on each call.
 *
 * @param {string} imagePath Path to PNG file
 * @param {string} audioPath Path to MP3 file
 * @param {string} outPath Path to save MP4 file
 */
function generateVideo(imagePath, audioPath, outPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-loop', '1',
      '-i', imagePath,
      '-i', audioPath,
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-shortest',
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
 * Upload a video to YouTube.  The video is uploaded as private.
 * Returns the YouTube video ID on success.
 *
 * @param {string} videoPath MP4 file
 * @param {string} title Video title
 * @param {string} description Video description
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
 * Main function to generate and upload a riddle video.  This
 * function is used both by the /make endpoint and the cron job.
 * It reads all riddles, picks one randomly, synthesises the
 * assets, uploads the result and cleans up temporary files.
 *
 * @returns {Promise<{question: string, videoId: string}>}
 */
async function createAndUpload() {
  const riddles = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'data', 'riddles.json'), 'utf8')
  );
  const random = riddles[Math.floor(Math.random() * riddles.length)];
  const combinedText = `${random.question}\n\nAnswer: ${random.answer}`;
  const imagePath = path.join(__dirname, 'temp.png');
  const audioPath = await generateVoice(random);
  const videoPath = path.join(__dirname, 'output.mp4');
  await generateImage(combinedText, imagePath);
  await generateVideo(imagePath, audioPath, videoPath);
  const videoId = await uploadVideo(videoPath, random.question, random.answer);
  // Clean up temporary files
  try { fs.unlinkSync(imagePath); } catch {}
  try { fs.unlinkSync(audioPath); } catch {}
  try { fs.unlinkSync(videoPath); } catch {}
  return { question: random.question, videoId };
}

// HTTP endpoint to generate and upload a single video on demand
app.get('/make', async (req, res) => {
  try {
    const result = await createAndUpload();
    res.json(result);
  } catch (err) {
    console.error('Error generating video:', err);
    res.status(500).json({ error: err.message });
  }
});

// Basic health check
app.get('/', (req, res) => {
  res.send('Brain Bender Daily cron API is running');
});

// OAuth helper routes
app.get('/auth', (req, res) => {
  const scopes = ['https://www.googleapis.com/auth/youtube.upload'];
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing code');
  try {
    const { tokens } = await oauth2Client.getToken(code);
    console.log('New refresh token:', tokens.refresh_token);
    res.send('Authorization successful.  Check logs for refresh token.');
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send('OAuth error');
  }
});

// Schedule automatic generation at 09:00, 15:00 and 21:00 UTC daily
cron.schedule('0 9,15,21 * * *', async () => {
  console.log('Cron job: generating daily video');
  try {
    const result = await createAndUpload();
    console.log('Cron job uploaded video:', result.videoId);
  } catch (err) {
    console.error('Cron job error:', err);
  }
}, { timezone: 'UTC' });

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});