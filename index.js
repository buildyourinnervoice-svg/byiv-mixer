const express = require('express');
const { spawn } = require('child_process');
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
  'None (Subliminal only)': '-45dB',
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
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`Download failed (${res.statusCode}) for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

// Run ffmpeg WITHOUT blocking the event loop (this is the core fix).
// spawn streams stderr instead of buffering it, and the Node process stays
// responsive to Railway's health checks while the encode runs.
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let lastErr = '';
    proc.stderr.on('data', d => { lastErr = d.toString().slice(-500); });
    // Safety valve: never let a runaway encode hang forever.
    const killTimer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('ffmpeg timed out after 20 minutes'));
    }, 20 * 60 * 1000);
    proc.on('error', err => { clearTimeout(killTimer); reject(err); });
    proc.on('close', code => {
      clearTimeout(killTimer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${lastErr}`));
    });
  });
}

// Stream the finished file to Bunny instead of loading it all into memory.
function uploadToBunny(localPath, remotePath) {
  const stat = fs.statSync(localPath);
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BUNNY_STORAGE_URL,
      path: `/${BUNNY_STORAGE_ZONE}/${remotePath}`,
      method: 'PUT',
      headers: {
        'AccessKey': BUNNY_API_KEY,
        'Content-Type': 'audio/mpeg',
        'Content-Length': stat.size
      }
    };
    const req = https.request(options, res => {
      if (res.statusCode === 201) resolve();
      else reject(new Error(`Bunny upload failed: ${res.statusCode}`));
    });
    req.on('error', reject);
    fs.createReadStream(localPath).pipe(req);
  });
}

app.post('/mix', async (req, res) => {
  const { voice_url, volume, duration, respondent_id } = req.body;
  const background = Array.isArray(req.body.background)
    ? String(req.body.background[0]).trim()
    : String(req.body.background || '').trim();

  // Validate inputs up front so we fail clearly instead of producing a broken command.
  const durationSecs = DURATION_SECONDS[duration];
  const voiceVolume = VOLUME_MAP[volume];
  if (!voice_url || !background || !respondent_id) {
    return res.status(400).json({ success: false, error: 'Missing voice_url, background, or respondent_id' });
  }
  if (!durationSecs) {
    return res.status(400).json({ success: false, error: `Unknown duration: ${duration}` });
  }
  if (!voiceVolume) {
    return res.status(400).json({ success: false, error: `Unknown volume: ${volume}` });
  }

  console.log('background =', background);
  console.log('voice_url =', voice_url);

  const tmpDir = `/tmp/${respondent_id}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  const voicePath = path.join(tmpDir, 'voice.mp3');
  const bgPath = path.join(tmpDir, 'background.mp3');
  const outputPath = path.join(tmpDir, 'mixed.mp3');

  try {
    await downloadFile(voice_url, voicePath);
    await downloadFile(background, bgPath);

    // Same mix as before: loop background + voice, apply the chosen voice volume,
    // trim to the paid duration, encode to mp3. Only difference is it runs async.
    await runFfmpeg([
      '-stream_loop', '-1', '-i', bgPath,
      '-i', voicePath,
      '-filter_complex',
      `[1:a]apad=pad_dur=2,volume=${voiceVolume}[padded];` +
      `[padded]aloop=loop=-1:size=2147483647[voiceloop];` +
      `[0:a][voiceloop]amix=inputs=2:duration=first[out]`,
      '-map', '[out]',
      '-t', String(durationSecs),
      '-c:a', 'libmp3lame', '-q:a', '2',
      outputPath, '-y'
    ]);

    const remoteFilename = `mixed/${respondent_id}-${Date.now()}-mixed.mp3`;
    await uploadToBunny(outputPath, remoteFilename);
    const downloadUrl = `${CDN_BASE}/${remoteFilename}`;

    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.json({ success: true, download_url: downloadUrl });
  } catch (err) {
    console.error('ERROR:', err.message);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const server = app.listen(3000, () => console.log('BYIV Mixer running on port 3000'));
// Allow long-running mixes to hold the connection without the server cutting them off.
server.requestTimeout = 0;      // don't cap total request time
server.headersTimeout = 65000;  // keep header timeout sane
server.keepAliveTimeout = 65000;
