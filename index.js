const express = require('express');
const app = express();
const port = process.env.PORT || 3000;
// Placeholder server: responds to GET / with JSON
app.get('/', (req, res) => {
  res.json({ message: 'Brain Bender Daily server running. Please replace with video rendering logic.' });
});
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
