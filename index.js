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
    let forwarded = false;
    try {
      if (MAKE_WEBHOOK_URL) { await postJson(MAKE_WEBHOOK_URL, payload); forwarded = true; }
      else console.error('MAKE_WEBHOOK_URL not set — order not forwarded.');
    } catch (err) {
      console.error('Forward to Make failed:', err.message);
    }
    // ---- GDPR AUTO-SCRUB (added 18 Jul 2026) --------------------------------
    // Once the order is safely handed to Make, wipe the free-text the customer
    // shared (and any gift recipient's details) from Stripe's stored metadata,
    // so no copy of it lingers in the payment record beyond processing. Stripe
    // then keeps only the basic purchase record (amount, date, buyer email,
    // and non-sensitive choices like focus/duration) for the 6-year UK tax
    // window. This makes the website's "personal details deleted within 30 days"
    // promise automatically true for paid orders — no manual clean-up needed.
    // We only scrub AFTER a successful forward, so a failed order keeps its data
    // for recovery. Stripe merges these keys, leaving the other metadata intact.
    if (forwarded && stripe) {
      try {
        await stripe.checkout.sessions.update(s.id, {
          metadata: {
            details: '',
            gift_message: '',
            recipient_name: '',
            recipient_email: '',
            gdpr_scrubbed: new Date().toISOString().slice(0, 10)
          }
        });
        console.log('GDPR: scrubbed free-text from Stripe metadata for', s.id);
      } catch (err) {
        console.error('Stripe metadata scrub failed (non-fatal):', err.message);
      }
    }
  }
  // ---- REFUND CONFIRMATION (19 Jul 2026) ----------------------------------
  // When a refund is issued in Stripe, forward it to the Make refund scenario,
  // which emails the customer a branded confirmation and the owner an FYI.
  // REQUIRES: 'charge.refunded' added to the Stripe webhook's listened events.
  if (event.type === 'charge.refunded') {
    const ch = event.data.object;
    const refundPayload = {
      email: (ch.billing_details && ch.billing_details.email) || ch.receipt_email || '',
      amount: (ch.amount_refunded || 0) / 100,
      charge_id: ch.id
    };
    try {
      await postJson('https://hook.eu1.make.com/9oaorq6cwktpfqe2ry7cnpu7k714klro', refundPayload);
      console.log('Refund forwarded to Make:', ch.id, refundPayload.amount);
    } catch (err) {
      console.error('Refund forward failed (non-fatal):', err.message);
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
// ---------------------------------------------------------------------------
// Per-tier mix levels (reworked 18 Jul 2026 PM2 — measurement + listening based,
// then RE-BALANCED 19 Jul 2026 after owner listening test — see notes below).
// The background is FIRST auto-levelled to a common loudness (loudnorm, in the
// filter below), and as of 19 Jul the VOICE is auto-levelled the same way, so
// these bg/voice values are offsets from a NORMALISED level and behave
// consistently for EVERY background sound AND every voice render — nothing to
// hand-tune per order. The background is also DUCKED under the voice
// (sidechaincompress) so the words stay clear while the bed fills the gaps.
// Ducking only triggers when the voice is loud enough, so Subliminal
// (voice -60dB) is unaffected and the background stays full there.
//   Subliminal: voice buried (inaudible), background full.
//   Whispered:  words lead gently, background present but eased under them.
//   Full voice: voice leads clearly, background a light bed.
//
// 19 Jul 2026 RE-BALANCE (owner listening test on Gentle Rain):
//   - Whispered was voice -18dB / bg -9dB, which put the RAIN LOUDER than the
//     whisper (voice sat UNDER the bed) — "rain too loud to hear the whisper".
//     Now voice -9dB / bg -16dB so the whisper gently leads.
//   - Full voice bg nudged -14dB -> -16dB to sit under the (now gentler) duck.
//   - These are listen-test starting values; adjust in ~2-3dB steps if needed.
// ---------------------------------------------------------------------------
const MIX_LEVELS = {
  'None (Subliminal only)': { voice: '-60dB', bg: '0dB'   },
  'A little (Whispered)':   { voice: '-12dB', bg: '-16dB' },  // -9 was still too loud for a whisper (owner listen-test 19 Jul); -12 approved
  'Fully (Clear voice)':    { voice: '0dB',   bg: '-16dB' }
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
// ---- LAUNCH22 promo ledger (added 17 Jul 2026): tiny JSON file on Bunny storage ----
const PROMO_FILE = 'promo-launch22.json';
function promoUses() {
  return new Promise((resolve) => {
    const r = https.request({
      hostname: BUNNY_STORAGE_URL,
      path: `/${BUNNY_STORAGE_ZONE}/${PROMO_FILE}`,
      method: 'GET',
      headers: { 'AccessKey': BUNNY_API_KEY }
    }, (resp) => {
      let body = '';
      resp.on('data', (c) => body += c);
      resp.on('end', () => {
        if (resp.statusCode !== 200) return resolve([]);
        try { const j = JSON.parse(body); resolve(Array.isArray(j) ? j : []); }
        catch (e) { resolve([]); }
      });
    });
    r.on('error', () => resolve([]));
    r.end();
  });
}
function savePromoUses(uses) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(uses, null, 2));
    const r = https.request({
      hostname: BUNNY_STORAGE_URL,
      path: `/${BUNNY_STORAGE_ZONE}/${PROMO_FILE}`,
      method: 'PUT',
      headers: { 'AccessKey': BUNNY_API_KEY, 'Content-Type': 'application/json', 'Content-Length': body.length }
    }, (resp) => { resp.resume(); resp.on('end', () => (resp.statusCode < 300 ? resolve() : reject(new Error('Promo save failed: ' + resp.statusCode)))); });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}
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
      reject(new Error('ffmpeg timed out after 45 minutes'));
    }, 45 * 60 * 1000);
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
    // ---- LAUNCH22 promo (added 17 Jul 2026): one free track of any length,
    // capped at 10 unique redemptions, ledger on Bunny storage. Same email
    // re-using the code doesn't burn an extra slot.
    let finalPrice = price;
    const promo = String(o.promo_code || '').trim().toUpperCase();
    if (promo) {
      if (promo !== 'LAUNCH22') return res.status(400).json({ error: "That code isn't recognised — please check it and try again." });
      const pEmail = String(o.email || '').trim();
      if (!pEmail) return res.status(400).json({ error: 'Please add your email so we can send your free track.' });
      const uses = await promoUses();
      const already = uses.some(u => String(u.email || '').toLowerCase() === pEmail.toLowerCase());
      if (!already && uses.length >= 12) return res.status(403).json({ error: 'This code has now been fully redeemed.' });
      if (!already) { uses.push({ email: pEmail, at: new Date().toISOString() }); await savePromoUses(uses); }
      finalPrice = 0;
    }
    // FREE path (member own track <=60 min, or a future promo code): no Stripe.
    // We need an email here since there's no Stripe page to collect one.
    if (finalPrice === 0) {
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
  const levels = MIX_LEVELS[volume];
  const voiceVolume = levels && levels.voice;
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
      // ---- AUDIO QUALITY FIXES (18 Jul 2026) ------------------------------
      // 1. White noise is now GENERATED inside ffmpeg (anoisesrc), not looped
      //    from an MP3 file: endless, perfectly seamless (no loop glitches),
      //    and mathematically clean (no compressed-noise "warble/alarm"
      //    artefacts from re-encoding an already-lossy noise file).
      // 2. amix previously halved the level of both inputs (its default
      //    normalisation) which made every track noticeably quiet even at
      //    full phone volume. normalize=0 keeps full loudness; a limiter
      //    guards against clipping.
      // 3. Output bitrate raised to constant 192k: low/variable bitrate on
      //    noise-heavy audio is what mangles the buried affirmation voice
      //    into audible "squeaks". Constant 192k keeps it smooth and masked.
      //    Pink noise (softer, warmer than white) is supported the same way:
      //    any background URL containing "pink-noise" generates pink noise —
      //    the URL doesn't need to point at a real file.
      // ---- BACKGROUND BALANCE FIX (18 Jul 2026 PM2) -----------------------
      // 4. Every background is first AUTO-LEVELLED (loudnorm) to a common
      //    loudness, so the different source recordings (which span ~34dB)
      //    all sit the same and one MIX_LEVELS setting fits them all.
      // 5. The background is DUCKED under the voice (sidechaincompress): it
      //    eases back whenever an affirmation plays and fills the gaps, so the
      //    words stay clear AND the background is audible. A light compressor
      //    tames peaks so a present bed doesn't spike over a whisper. This is
      //    what makes whisper-over-any-background come out balanced.
      // ---- 19 Jul 2026 RE-BALANCE (owner listening test) ------------------
      // 6. The VOICE is now auto-levelled too (loudnorm on [1:a]) so a quiet
      //    ElevenLabs render can't bury itself — the MIX_LEVELS numbers now
      //    mean the same thing every time.
      // 7. The duck was ratio 10:1 (threshold 0.03) which SLAMMED the bed to
      //    near-silence on every word — "the rain stops every time she speaks".
      //    Softened to ratio 2.5:1 (threshold 0.05) so the bed only eases a few
      //    dB under the voice and flows back naturally.
      const noiseColour = /pink-noise/i.test(background) ? 'pink'
                        : /white-noise/i.test(background) ? 'white' : null;
      const filterChain =
        `[bg0]loudnorm=I=-23:TP=-2:LRA=11[bgn];` +
        `[bgn]volume=${levels.bg}[bgv];` +
        `[bgv]acompressor=threshold=0.0316:ratio=6:attack=8:release=220[bgc];` +
        `[1:a]loudnorm=I=-19:TP=-2:LRA=11,apad=pad_dur=2,volume=${levels.voice}[padded];` +
        `[padded]aloop=loop=-1:size=2147483647[voiceloop];` +
        `[voiceloop]asplit=2[voicemix][voicekey];` +
        `[bgc][voicekey]sidechaincompress=threshold=0.05:ratio=2.5:attack=20:release=250[bgducked];` +
        `[bgducked][voicemix]amix=inputs=2:duration=first:normalize=0[mix];` +
        `[mix]alimiter=limit=0.95[out]`;
      let ffArgs;
      if (noiseColour) {
        ffArgs = [
          '-f', 'lavfi',
          '-i', `anoisesrc=colour=${noiseColour}:sample_rate=44100:amplitude=0.35:seed=1,aformat=channel_layouts=mono`,
          '-i', voicePath,
          '-filter_complex',
          `[0:a]pan=stereo|c0=c0|c1=c0[bg0];` + filterChain,
          '-map', '[out]',
          '-t', String(durationSecs),
          '-c:a', 'libmp3lame', '-b:a', '192k',
          outputPath, '-y'
        ];
      } else {
        await downloadFile(background, bgPath);
        ffArgs = [
          '-stream_loop', '-1', '-i', bgPath,
          '-i', voicePath,
          '-filter_complex',
          `[0:a]anull[bg0];` + filterChain,
          '-map', '[out]',
          '-t', String(durationSecs),
          '-c:a', 'libmp3lame', '-b:a', '192k',
          outputPath, '-y'
        ];
      }
      // ---- AUTO-VERIFY + AUTO-RETRY (19 Jul 2026) --------------------------
      // Verify inputs actually downloaded (a 0-byte voice or background file
      // would previously render a broken track and deliver it silently), then
      // render, then sanity-check the output size against the expected size
      // for a 192kbps CBR file of this duration (catches truncated/corrupt
      // renders). One automatic retry before escalating via the failure
      // callback — so the owner is only bothered by genuine repeat failures.
      const vSize = fs.statSync(voicePath).size;
      if (vSize < 1000) throw new Error(`Voice file too small (${vSize} bytes) — download failed?`);
      if (!noiseColour) {
        const bSize = fs.statSync(bgPath).size;
        if (bSize < 10000) throw new Error(`Background file too small (${bSize} bytes) — download failed?`);
      }
      const expectedBytes = durationSecs * 24000; // 192kbps ≈ 24,000 bytes/sec
      let renderAttempt = 0, renderOk = false, renderErr = null;
      while (renderAttempt < 2 && !renderOk) {
        renderAttempt++;
        try {
          await runFfmpeg(ffArgs);
          const outSize = fs.statSync(outputPath).size;
          if (outSize < expectedBytes * 0.8 || outSize > expectedBytes * 1.3) {
            throw new Error(`Output failed size sanity check (attempt ${renderAttempt}): ${outSize} bytes vs ~${expectedBytes} expected for ${durationSecs}s`);
          }
          renderOk = true;
        } catch (err) {
          renderErr = err;
          console.error(`Render attempt ${renderAttempt} failed:`, err.message);
        }
      }
      if (!renderOk) throw renderErr;
      await uploadToBunny(outputPath, remoteFilename);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      console.log(`Mix complete (attempt ${renderAttempt}):`, remoteFilename);
      await postCallback({ status: 'success', download_url: downloadUrl, ...passthrough });
    } catch (err) {
      console.error('MIX ERROR:', err.message);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      await postCallback({ status: 'failed', error: err.message, ...passthrough });
    }
  })();
});
// ---------------------------------------------------------------------------
// SOUND PREVIEW (added 18 Jul 2026) — hear any background exactly as the mixer
// renders it, WITHOUT ordering a track (no voice, no ElevenLabs credits, no
// Bunny upload). Open in a browser:
//   /preview?sound=white            (generated white noise)
//   /preview?sound=pink             (generated pink noise)
//   /preview?sound=<full mp3 URL>   (any background file, looped like a real mix)
// Optional &secs=90 (default 60, max 300).
// Optional &voice=<mp3 URL> layers an EXISTING voice recording under the sound
// exactly like a real mix (reuses voice files already on Bunny — no ElevenLabs
// spend). Optional &voicevol=0dB down to -99dB (default -60dB, subliminal).
// NOTE (18 Jul fix): the old validation regex only accepted 0..-39dB and
// SILENTLY fell back to the default for anything lower — which is why -45dB
// and -50dB tests sounded identical. Now accepts the full 0..-99dB range.
// ALIGNED WITH /mix (19 Jul 2026): previews now use the SAME processing chain
// as delivered tracks — background loudnorm to -23 LUFS, MIX_LEVELS offsets,
// light compressor, voice loudnorm + sidechain duck — so what customers hear
// in a preview is what they get in a track.
//   /preview?sound=<white|pink|mp3 url>                (background only, tier-levelled)
//   &tier=subliminal|whispered|full                    (default: subliminal)
//   &voice=<mp3 URL or order id>                       (optional voice layer)
//   &secs=90                                           (default 60, max 300)
// Legacy &voicevol= / &bgvol= raw-dB overrides still work and bypass the tier.
// ---------------------------------------------------------------------------
const PREVIEW_TIERS = {
  subliminal: 'None (Subliminal only)',
  whispered: 'A little (Whispered)',
  full: 'Fully (Clear voice)'
};
app.get('/preview', async (req, res) => {
  try {
    const sound = String(req.query.sound || '').trim();
    const voice = String(req.query.voice || '').trim();
    const dbOk = (v) => /^(0|-[1-9][0-9]?)dB$/.test(String(v || ''));
    const tierKey = PREVIEW_TIERS[String(req.query.tier || 'subliminal').toLowerCase()] || PREVIEW_TIERS.subliminal;
    const levels = MIX_LEVELS[tierKey];
    // Raw-dB overrides (legacy/testing) take precedence over the tier.
    const voicevol = dbOk(req.query.voicevol) ? req.query.voicevol : levels.voice;
    const bgvol = dbOk(req.query.bgvol) ? req.query.bgvol : levels.bg;
    const secs = Math.min(parseInt(req.query.secs, 10) || 60, 300);
    if (!sound) return res.status(400).send('Add ?sound=white, ?sound=pink, or ?sound=<mp3 url>');
    const colour = /^pink$/i.test(sound) || /pink-noise/i.test(sound) ? 'pink'
                 : /^white$/i.test(sound) || /white-noise/i.test(sound) ? 'white' : null;
    let inputArgs;
    const tmpFiles = [];
    if (colour) {
      inputArgs = ['-f', 'lavfi', '-i',
        `anoisesrc=colour=${colour}:sample_rate=44100:amplitude=0.35:seed=1,aformat=channel_layouts=mono`];
    } else {
      if (!/^https:\/\//i.test(sound)) return res.status(400).send('sound must be white, pink, or an https mp3 URL');
      const bgTmp = `/tmp/preview-bg-${Date.now()}.mp3`;
      await downloadFile(sound, bgTmp);
      tmpFiles.push(bgTmp);
      inputArgs = ['-stream_loop', '-1', '-i', bgTmp];
    }
    // Same background conditioning as /mix: loudnorm -> tier offset -> light compressor.
    const bgLabel = (colour ? '[0:a]pan=stereo|c0=c0|c1=c0[bg0];' : '[0:a]anull[bg0];') +
      `[bg0]loudnorm=I=-23:TP=-2:LRA=11[bgn];` +
      `[bgn]volume=${bgvol}[bgv];` +
      `[bgv]acompressor=threshold=0.0316:ratio=6:attack=8:release=220[bg];`;
    let filter, extraInputs = [];
    if (voice) {
      // voice can be a full https URL, or just an order/submission id — in
      // which case we build the CDN voice-file URL ourselves (this avoids
      // nested URLs in the query string, which some browsers/tools strip).
      const voiceUrl = /^https:\/\//i.test(voice)
        ? voice
        : `${CDN_BASE}/${voice.replace(/\.mp3$/i, '')}.mp3`;
      const vTmp = `/tmp/preview-voice-${Date.now()}.mp3`;
      await downloadFile(voiceUrl, vTmp);
      tmpFiles.push(vTmp);
      extraInputs = ['-i', vTmp];
      // Same voice conditioning + sidechain duck as /mix.
      filter = bgLabel +
        `[1:a]loudnorm=I=-19:TP=-2:LRA=11,apad=pad_dur=2,volume=${voicevol}[padded];` +
        `[padded]aloop=loop=-1:size=2147483647[voiceloop];` +
        `[voiceloop]asplit=2[voicemix][voicekey];` +
        `[bg][voicekey]sidechaincompress=threshold=0.05:ratio=2.5:attack=20:release=250[bgducked];` +
        `[bgducked][voicemix]amix=inputs=2:duration=first:normalize=0[mix];` +
        `[mix]alimiter=limit=0.95[out]`;
    } else {
      filter = bgLabel + '[bg]alimiter=limit=0.95[out]';
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    const args = [
      ...inputArgs,
      ...extraInputs,
      '-filter_complex', filter,
      '-map', '[out]',
      '-t', String(secs),
      '-c:a', 'libmp3lame', '-b:a', '192k',
      '-f', 'mp3', 'pipe:1'
    ];
    const proc = spawn('ffmpeg', args);
    proc.stdout.pipe(res);
    proc.stderr.on('data', () => {});
    proc.on('close', () => { tmpFiles.forEach(f => fs.unlink(f, () => {})); });
    req.on('close', () => proc.kill('SIGKILL'));
  } catch (err) {
    res.status(500).send('Preview failed: ' + err.message);
  }
});
app.get('/health', (req, res) => res.json({ status: 'ok', stripe: !!stripe }));
const server = app.listen(3000, () => console.log('BYIV Mixer + Checkout running on port 3000'));
server.requestTimeout = 0;
server.headersTimeout = 65000;
server.keepAliveTimeout = 65000;
