const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const app = express();

// ---------------------------------------------------------------------------
// Stripe setup (guarded so the mixer keeps running even before keys are added).
// Add these on Railway as environment variables:
//   STRIPE_SECRET_KEY       (sk_test_... to start, sk_live_... when going live)
//   STRIPE_WEBHOOK_SECRET   (whsec_...  from the Stripe webhook you create)
//   MAKE_WEBHOOK_URL        (the custom webhook URL from your Make scenario)
//   SITE_URL                (e.g. https://buildyourinnervoice.com)
// And add "stripe" to package.json dependencies (npm install stripe).
// ---------------------------------------------------------------------------
let stripe = null;
try {
  if (process.env.STRIPE_SECRET_KEY) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    console.log('Stripe initialised.');
  } else {
    console.log('STRIPE_SECRET_KEY not set — payment endpoints disabled for now.');
  }
} catch (e) {
  console.error('Stripe init failed:', e.message);
}

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || '';
const SITE_URL = process.env.SITE_URL || 'https://buildyourinnervoice.com';

// Server-side price table — the ONLY source of truth for what a track costs.
// Never trust a price sent from the browser.
const PRICE = {
  '5 min': 7,
  '10 min': 9,
  '30 min': 13,
  '60 min': 16,
  '4 hours': 25
};

// The wizard says "5 min" but the pipeline/mixer expect "5 minutes".
const DURATION_NORMALISE = {
  '5 min': '5 minutes',
  '10 min': '10 minutes',
  '30 min': '30 minutes',
  '60 min': '60 minutes',
  '4 hours': '4 hours'
};

// ---- Pricing brain (members + gifts) --------------------------------------
// Rules (mirrors the pricing we built on the old Tally form):
//   Non-member: pay the base price above (gift or own, same price).
//   Member + own track, 60 min or less:      FREE (£0)  -> skips Stripe.
//   Member + own track, 4 hours:             30% off.
//   Member + gift (any length):              30% off.
// Membership is only CLAIMED here; the Make engine validates it and holds
// delivery for false claims, so a fake "member" who pays £0 never gets a track.
function isMember(v) {
  return String(v || '').toLowerCase().indexOf('member') !== -1 &&
         String(v || '').toLowerCase().indexOf('not') === -1;
}
function isGift(o) {
  return String(o.who_for || '').toLowerCase().indexOf('gift') !== -1 ||
         !!(o.recipient_email || o.recipient_name);
}
function computePrice(o) {
  const base = PRICE[o.duration];
  if (base === undefined) return null;            // unknown duration
  const member = isMember(o.member);
  const gift = isGift(o);
  if (!member) return base;                        // non-member: base
  if (gift) return round2(base * 0.7);             // member gift: 30% off
return 0; // member own track (any length incl. 4hr): free — fair use applies
}
function round2(n) { return Math.round(n * 100) / 100; }

// Build the Tally-shaped payload the Make pipeline expects, from an order + email.
function buildPipelinePayload(o, email, orderId) {
  const durationFull = DURATION_NORMALISE[o.duration] || o.duration || '';
  return {
    submissionId: orderId,
    fields: {
      'Contact Information': email,
      'Area of Focus': o.focus || '',
      'Additional details': o.details || '',
      'Are you a member?': o.member || '',
      'Who is this track for?': o.who_for || 'Build My Inner Voice'
    },
    fieldsById: {
      question_WPjYoJ: email,
      question_6Rpvke: o.focus || '',
      question_k5kWA6: [durationFull],
      question_KLaDoM: [o.volume || ''],
      question_v4dLBA: [o.sound || ''],
      question_ELpk1N: o.recipient_email || '',
      question_PlodEb: o.recipient_name || '',
      question_rVXjKv: o.gift_message || '',
      question_KL25Bg: o.gift_date || ''
    }
  };
}

// ---------------------------------------------------------------------------
// STRIPE WEBHOOK — must be registered BEFORE express.json(), because Stripe
// signature verification needs the raw, unparsed request body.
// ---------------------------------------------------------------------------
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).send('Stripe not configured');
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const md = s.metadata || {};
    if (s.mode !== 'payment' || !md.duration) { console.log('Ignoring non-order session:', s.id); return res.json({ received: true }); }
    const email = (s.customer_details && s.customer_details.email) || s.customer_email || '';
    // Same Tally-shaped payload the free path uses, so the Make pipeline needs
    // ZERO field rewiring — it reads 2.fields.`...` and 2.fieldsById.question_...
    const payload = buildPipelinePayload(md, email, s.id);
    payload.amount_paid = (s.amount_total || 0) / 100;
    console.log('Payment complete, forwarding order:', payload.submissionId, email);
    try {
      if (MAKE_WEBHOOK_URL) await postJson(MAKE_WEBHOOK_URL, payload);
      else console.error('MAKE_WEBHOOK_URL not set — order not forwarded.');
    } catch (err) {
      console.error('Forward to Make failed:', err.message);
    }
  }
  res.json({ received: true });
});

// JSON parsing for every OTHER route. 
// Allow the website (a different domain) to call these endpoints from the browser.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
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

// ---- small JSON POST helper (used to forward paid orders to Make) ----
function postJson(url, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const r = https.request(options, resp => {
      let out = '';
      resp.on('data', d => (out += d));
      resp.on('end', () => resolve({ status: resp.statusCode, body: out }));
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}

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

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let lastErr = '';
    proc.stderr.on('data', d => { lastErr = d.toString().slice(-500); });
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

// ---------------------------------------------------------------------------
// CREATE CHECKOUT — the website wizard calls this when the customer clicks
// "Continue to payment". We compute the price server-side, stash the order in
// the Stripe session metadata, and return the hosted Stripe checkout URL.
// ---------------------------------------------------------------------------
app.post('/create-checkout', async (req, res) => {
  try {
    const o = req.body || {};
    const price = computePrice(o);
    if (price === null) return res.status(400).json({ error: `Unknown duration: ${o.duration}` });

    // FREE path (member own track <=60 min, or a future promo code): no Stripe.
    // We need an email here since there's no Stripe page to collect one.
    if (price === 0) {
      const email = String(o.email || '').trim();
      if (!email) return res.status(400).json({ error: 'Email required for a free track.' });
      const payload = buildPipelinePayload(o, email, 'free-' + Date.now());
      payload.amount_paid = 0;
      if (MAKE_WEBHOOK_URL) await postJson(MAKE_WEBHOOK_URL, payload);
      else console.error('MAKE_WEBHOOK_URL not set — free order not forwarded.');
      return res.json({ free: true, url: `${SITE_URL}/?paid=1` });
    }

    if (!stripe) return res.status(503).json({ error: 'Payments are not configured yet.' });

    // Stripe metadata: max 50 keys, 500 chars per value. Trim the free-text fields.
    const md = {
      focus: String(o.focus || '').slice(0, 480),
      duration: String(o.duration || ''),
      sound: String(o.sound || '').slice(0, 200),
      volume: String(o.volume || ''),
      who_for: String(o.who_for || 'Build My Inner Voice'),
      member: String(o.member || ''),
      details: String(o.details || '').slice(0, 480),
      gift_message: String(o.gift_message || '').slice(0, 480),
      gift_date: String(o.gift_date || ''),
      recipient_name: String(o.recipient_name || '').slice(0, 200),
      recipient_email: String(o.recipient_email || '').slice(0, 200)
    };

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'gbp',
          unit_amount: price * 100,
          product_data: {
            name: `Personalised ${o.duration} affirmations track`,
            description: (o.focus ? `Focus: ${o.focus}` : 'Build Your Inner Voice')
          }
        },
        quantity: 1
      }],
      metadata: md,
      success_url: `${SITE_URL}/?paid=1`,
      cancel_url: `${SITE_URL}/?canceled=1`
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('create-checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/mix', async (req, res) => {
  const { voice_url, volume, duration, respondent_id, callback_url } = req.body;
  const background = Array.isArray(req.body.background)
    ? String(req.body.background[0]).trim()
    : String(req.body.background || '').trim();

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

  // ---- ASYNC MIXING (added 17 Jul 2026) ----------------------------------
  // Long tracks (4 hours) take far longer than Make's 5-minute HTTP ceiling,
  // so we fix the output filename NOW, reply immediately, render in the
  // background, and tell Make via callback_url when the track is ready.
  const remoteFilename = `mixed/${respondent_id}-${Date.now()}-mixed.mp3`;
  const downloadUrl = `${CDN_BASE}/${remoteFilename}`;

  // Fields echoed back to the Make "Track Ready" webhook.
  const passthrough = {
    respondent_id,
    email: req.body.email || '',
    focus: req.body.focus || '',
    duration_label: req.body.duration_label || duration || '',
    affirmations: req.body.affirmations || '',
    risk: req.body.risk || ''
  };
  if (req.body.gift_date) passthrough.gift_date = req.body.gift_date; // omit when empty: delivery filter relies on absence

  function postCallback(payload) {
    if (!callback_url) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        const body = JSON.stringify(payload);
        const u = new URL(callback_url);
        const reqOpts = {
          hostname: u.hostname,
          path: u.pathname + u.search,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        };
        const cbReq = https.request(reqOpts, (cbRes) => { cbRes.resume(); cbRes.on('end', resolve); });
        cbReq.on('error', (e) => { console.error('Callback failed:', e.message); resolve(); });
        cbReq.write(body);
        cbReq.end();
      } catch (e) { console.error('Callback error:', e.message); resolve(); }
    });
  }

  // Reply straight away so Make never times out.
  res.json({ success: true, status: 'processing', download_url: downloadUrl });

  // Render + upload in the background.
  (async () => {
    const tmpDir = `/tmp/${respondent_id}-${Date.now()}`;
    fs.mkdirSync(tmpDir, { recursive: true });
    const voicePath = path.join(tmpDir, 'voice.mp3');
    const bgPath = path.join(tmpDir, 'background.mp3');
    const outputPath = path.join(tmpDir, 'mixed.mp3');
    try {
      await downloadFile(voice_url, voicePath);
      await downloadFile(background, bgPath);

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

      await uploadToBunny(outputPath, remoteFilename);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      console.log('Mix complete:', remoteFilename);
      await postCallback({ status: 'success', download_url: downloadUrl, ...passthrough });
    } catch (err) {
      console.error('MIX ERROR:', err.message);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      await postCallback({ status: 'failed', error: err.message, ...passthrough });
    }
  })();
});

app.get('/health', (req, res) => res.json({ status: 'ok', stripe: !!stripe }));

const server = app.listen(3000, () => console.log('BYIV Mixer + Checkout running on port 3000'));
server.requestTimeout = 0;
server.headersTimeout = 65000;
server.keepAliveTimeout = 65000;
