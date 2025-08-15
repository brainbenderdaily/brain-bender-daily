const express = require('express');
const { google } = require('googleapis');

const app = express();
const port = process.env.PORT || 3000;

// OAuth2 client setup using environment variables
const oauth2Client = new google.auth.OAuth2(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
  process.env.REDIRECT_URI || `https://brain-bender-daily.onrender.com/oauth2callback`
);

// Redirect user to Google's OAuth consent page
app.get('/auth', (req, res) => {
  const scopes = ['https://www.googleapis.com/auth/youtube.upload'];
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
  });
  res.redirect(url);
});

// OAuth2 callback route to exchange code for tokens
app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('Missing code parameter');
  }
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    // Log the refresh token so it can be copied into Render environment vars
    console.log('REFRESH_TOKEN:', tokens.refresh_token);
    res.send('Authorization successful! Refresh token has been logged to the server logs.');
  } catch (err) {
    console.error('Error retrieving tokens:', err);
    res.status(500).send('Error retrieving tokens');
  }
});

// Default route for server health
app.get('/', (req, res) => {
  res.json({ message: 'Brain Bender Daily server running. OAuth endpoints available at /auth and /oauth2callback.' });
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
