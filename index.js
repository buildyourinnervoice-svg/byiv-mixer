const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const app = express();
app.use(express.json());
const BUNNY_STORAGE_URL = 'uk.storage.bunnycdn.com';
const BUNNY_STORAGE_ZONE = 'build-your-inner-voice';
const BUNNY_API_KEY = process.env.BUNNY_API_KEY;
const CDN_BASE = 'https://cdn.buildyourinnervoice.com';
const VOLUME_MAP = {
  'None (Subliminal only)': '-35dB',
  'A little (Whispered)': '-22dB',
  'Fully (Clear voice)': '0dB'
};
const DURATION_SECONDS = {
  '5 minutes': 300,
  '10 minutes': 600,
  '30 minutes': 1800,
  '60 minutes': 3600,
  '4 hours': 14400,
  '8 hours': 28800
};
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}
function uploadToBunny(localPath, remotePath) {
  const fileData = fs.readFileSync(localPath);
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BUNNY_STORAGE_URL,
      path: `/${BUNNY_STORAGE_ZONE}/${remotePath}`,
      method: 'PUT',
      headers: {
        'AccessKey': BUNNY_API_KEY,
        'Content-Type': 'audio/mpeg',
        'Content-Length': fileData.length
      }
    };
    const req = https.request(options, res => {
      if (res.statusCode === 201) resolve();
      else reject(new Error(`Bunny upload failed: ${res.statusCode}`));
    });
    req.on('error', reject);
    req.write(fileData);
    req.end();
  });
}
app.post('/mix', async (req, res) => {
  const { voice_url, volume, duration, respondent_id } = req.body;
  const background = Array.isArray(req.body.background)
    ? String(req.body.background[0]).trim()
    : String(req.body.background).trim();
  console.log("background =", background);
  console.log("voice_url =", voice_url);
  const tmpDir = `/tmp/${respondent_id}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  const voicePath = path.join(tmpDir, 'voice.mp3');
  const bgPath = path.join(tmpDir, 'background.mp3');
  const outputPath = path.join(tmpDir, 'mixed.mp3');
  try {
    await downloadFile(voice_url, voicePath);
    const bgUrl = background;
    console.log("bgUrl =", bgUrl);
    await downloadFile(bgUrl, bgPath);
    const durationSecs = DURATION_SECONDS[duration];
    const voiceVolume = VOLUME_MAP[volume];
    execSync(
      `ffmpeg -stream_loop -1 -i "${bgPath}" -i "${voicePath}" ` +
      `-filter_complex "[1:a]apad=pad_dur=2,volume=${voiceVolume}[padded];` +
      `[padded]aloop=loop=-1:size=2147483647[voiceloop];` +
      `[0:a][voiceloop]amix=inputs=2:duration=first[out]" ` +
      `-map "[out]" -t ${durationSecs} -c:a libmp3lame -q:a 2 "${outputPath}" -y`
    );
    const remoteFilename = `mixed/${respondent_id}-${Date.now()}-mixed.mp3`;
    await uploadToBunny(outputPath, remoteFilename);
    const downloadUrl = `${CDN_BASE}/${remoteFilename}`;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.json({ success: true, download_url: downloadUrl });
  } catch (err) {
    console.error("ERROR:", err.message);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.status(500).json({ success: false, error: err.message });
  }
});
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.listen(3000, () => console.log('BYIV Mixer running on port 3000'));
