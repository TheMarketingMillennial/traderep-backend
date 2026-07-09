// TradeRep Pro — Railway Backend Server
// Handles: Stripe subscriptions, Twilio SMS, GBP posting
// All sensitive keys live in Railway environment variables — never in the app.

'use strict';
require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const stripe     = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin      = require('firebase-admin');
const { OpenAI } = require('openai');

// ── OpenAI client ─────────────────────────────────────────────────────────────
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;
if (openai) {
  console.log('[OpenAI] Client initialized ✅');
} else {
  console.warn('[OpenAI] OPENAI_API_KEY not set — caption generation disabled');
}

// ── Firebase Admin init ───────────────────────────────────────────────────────
let db = null;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  if (serviceAccount.project_id) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    console.log('[Firebase] Initialized ✅ — project:', serviceAccount.project_id);
  } else {
    console.warn('[Firebase] FIREBASE_SERVICE_ACCOUNT not set — Firestore sync disabled');
  }
} catch (e) {
  console.error('[Firebase] Init error:', e.message);
}

// ── Express setup ─────────────────────────────────────────────────────────────
const app = express();

// IMPORTANT: raw body required for Stripe webhook signature verification.
// Must be registered BEFORE express.json() middleware.
app.use('/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(cors());
app.use(express.json());

// ── Price ID map ──────────────────────────────────────────────────────────────
const PRICE_IDS = {
  starter: process.env.STRIPE_PRICE_STARTER || 'price_1TcTIkCnWFtpnJDSLagxlQCu',
  growth:  process.env.STRIPE_PRICE_GROWTH  || 'price_1TcTJXCnWFtpnJDSXlZpYOs9',
  pro:     process.env.STRIPE_PRICE_PRO     || 'price_1TcTKICnWFtpnJDSmXw4CrWZ',
};

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const twilioConfigured = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);
  res.json({
    status:            'ok',
    server:            'TradeRep Pro',
    version:           '1.0.0',
    firebase:          db ? 'connected' : 'disabled',
    stripe:            !!process.env.STRIPE_SECRET_KEY,
    twilio:            twilioConfigured,
    twilio_configured: twilioConfigured,   // Flutter SmsService reads this field
    mock_mode:         !twilioConfigured,  // Flutter SmsService reads this field
    messages_sent:     0,                  // Twilio doesn't expose a simple counter
    openai:            !!openai,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OPENAI — GENERATE CAPTION
//
// Generates a unique Google Business Profile post caption based on job context.
// Called by the Flutter app when an admin reviews a photo submission.
//
// POST /generate-caption
// Body: {
//   companyName,          // "Smith Roofing"
//   trade,                // "Roofing"
//   serviceArea,          // "Austin, TX"
//   jobType,              // "Roof Replacement"
//   jobDescription,       // optional crew note (composed from work type + crew note)
//   tone,                 // one of 9 brand voice keys (default: professional)
//   customerHighlight,    // optional one-sentence customer highlight
//   customerCity,         // optional city for geographic relevance
//   season,               // optional "spring"|"summer"|"fall"|"winter"
//   previousPosts,        // optional array of {opening, closing, hashtags} for anti-repetition
// }
// Returns: { caption, hashtags }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/generate-caption', async (req, res) => {
  if (!openai) {
    return res.status(503).json({ error: 'OpenAI not configured on server' });
  }

  try {
    const {
      companyName        = '',
      trade              = 'contractor',
      serviceArea        = '',
      jobType            = 'project',
      jobDescription     = '',
      tone               = 'professional',
      customerHighlight  = '',
      customerCity       = '',
      season             = '',
      previousPosts      = [],
    } = req.body;

    if (!jobType) {
      return res.status(400).json({ error: 'jobType is required' });
    }

    // Brand voice guidance — each has a distinct, opinionated style
    const toneGuide = {
      professional:    'professional and trustworthy — highlight quality, reliability, and expertise. Use clear language that builds confidence.',
      friendly:        'warm and conversational — write like a neighbor recommending a trusted contractor. Feel genuine and approachable.',
      family_owned:    'personal and community-rooted — emphasize the family business angle, local roots, and personal investment in every job.',
      luxury:          'premium and sophisticated — focus on craftsmanship, quality materials, and elevated results. Avoid casual language.',
      educational:     'informative and helpful — briefly explain the work or why it matters. Teach the reader something useful without being preachy.',
      straightforward: 'direct and no-nonsense — state what was done, why it matters, move on. Short sentences. No filler.',
      premium:         'high-quality and exclusive — position the company as the best choice, not just a good one. Confident without being arrogant.',
      bold:            'punchy and confident — short sentences, strong verbs, energy. Make them want to call right now.',
      local_community: 'neighborly and place-based — weave the local community into the story. Feel like it was written by someone who lives there.',
    }[tone] || 'professional and trustworthy';

    // Geographic context
    const locationLine = customerCity
      ? `Customer location: ${customerCity} (incorporate naturally — once, not repeatedly)`
      : serviceArea ? `Service area: ${serviceArea}` : '';

    // Context lines
    const noteStr      = jobDescription     ? `Crew notes: "${jobDescription}"` : '';
    const highlightStr = customerHighlight  ? `Customer highlight: "${customerHighlight}" — weave this in authentically` : '';
    const seasonStr    = season             ? `Current season: ${season} — reference if relevant` : '';

    // Anti-repetition block — inject up to 40 previous posts
    let antiRepetitionBlock = '';
    if (previousPosts && previousPosts.length > 0) {
      const recent = previousPosts.slice(0, 40);
      const prevOpenings = recent.map(p => p.opening).filter(Boolean).join('\n- ');
      const prevClosings = recent.map(p => p.closing).filter(Boolean).join('\n- ');
      const prevHashtags = [...new Set(
        recent.flatMap(p => (p.hashtags || '').split(' ').filter(h => h.startsWith('#')))
      )].join(' ');

      antiRepetitionBlock = `
ANTI-REPETITION RULES (CRITICAL):
Previous post openings to NEVER repeat or closely imitate:
- ${prevOpenings || 'none yet'}

Previous post closings to NEVER repeat or closely imitate:
- ${prevClosings || 'none yet'}

Previously used hashtags (rotate — use no more than 2 of these):
${prevHashtags || 'none yet'}

Every post must feel like it was written fresh — different sentence structure, different opening, different CTA, different hashtags.`;
    }

    // Diverse opening strategies
    const openingStyles = [
      'Start mid-story — drop the reader into the job as if they\'re already there.',
      'Start with a specific before-condition that the homeowner dealt with (e.g. "The drain had been backing up for weeks.")',
      'Start with the result — what does it look like now that the job is done?',
      'Start with a question the homeowner was probably asking themselves.',
      'Start with a specific, concrete detail about the craft or materials.',
      'Start with a time element — "Last week," "Yesterday morning," "Three days ahead of schedule"',
      'Start with the customer\'s situation, not the company\'s action.',
      'Open with a trade-specific observation that shows expertise.',
    ];
    const openingStyle = openingStyles[Math.floor(Math.random() * openingStyles.length)];

    // CTA variety pool
    const ctaOptions = [
      'End with: "Need something similar? Give us a call."',
      'End with: "Planning a project? We\'d love to take a look."',
      'End with: "Questions about your home? Reach out — no pressure."',
      'End with: "Thinking about upgrading? Let\'s talk."',
      'End with: "Ready when you are. Just give us a ring."',
      'End with a simple invitation to connect — no hard sell.',
      'End with something that references the local community or service area.',
    ];
    const ctaStyle = ctaOptions[Math.floor(Math.random() * ctaOptions.length)];

    const prompt = `You are writing a Google Business Profile post for a trade contractor. Your goal is to produce content that sounds like it was written by a real business owner documenting real work — not by an AI following a template.

COMPANY CONTEXT:
Company: ${companyName || 'a local contractor'}
Trade: ${trade}
${locationLine}
Job completed: ${jobType}
${noteStr}
${highlightStr}
${seasonStr}

BRAND VOICE: ${toneGuide}

OPENING APPROACH: ${openingStyle}
CALL TO ACTION: ${ctaStyle}
${antiRepetitionBlock}

CONTENT RULES:
- Length: 120–250 words. No shorter, no longer.
- Write conversationally. No corporate speak.
- No clichés: "thrilled", "delighted", "excited", "proud to announce", "we are pleased"
- No template openings: "We recently completed", "Another successful", "Our team just", "We are happy to"
- Mention location at most once — only if it fits naturally
- Use 1–2 emojis max, placed mid-sentence or end — never at the start
- No exclamation marks unless the CTA genuinely calls for one
- The post should feel like authentic local storytelling
- Future image analysis hook (for internal use): <!-- image_context: none -->

HASHTAGS:
- Generate exactly 3–5 hashtags
- Mix trade-specific, location-relevant, and general home improvement tags
- Avoid generic: #Contractor #HomeImprovement (use more specific ones)
- No hashtag should repeat a word from the previous posts list above

Respond in this exact JSON format:
{
  "caption": "the post text here",
  "hashtags": ["#Tag1", "#Tag2", "#Tag3", "#Tag4", "#Tag5"]
}`;

    console.log(`[OpenAI] Generating caption — trade: ${trade}, job: ${jobType}, voice: ${tone}, prevPosts: ${previousPosts.length}`);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',          // fast and cheap — ~$0.0002 per caption
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8,              // enough creativity to vary posts
      max_tokens: 400,
      response_format: { type: 'json_object' },
    });

    const raw = completion.choices[0].message.content;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error('[OpenAI] JSON parse error — raw:', raw);
      return res.status(500).json({ error: 'Failed to parse AI response' });
    }

    const caption   = (parsed.caption   || '').trim();
    const hashtags  = Array.isArray(parsed.hashtags) ? parsed.hashtags : [];

    if (!caption) {
      return res.status(500).json({ error: 'Empty caption from AI' });
    }

    console.log(`[OpenAI] Caption generated — ${caption.length} chars, ${hashtags.length} hashtags`);
    res.json({ caption, hashtags });

  } catch (err) {
    console.error('[OpenAI] generate-caption error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STRIPE — CREATE SUBSCRIPTION
//
// Called by the Flutter app when a user starts a TradeRep Pro trial.
// Single plan only — no price key selection.
//
// Subscription items built as:
//   - Always: 1× PRICE_IDS.starter ($75/mo base)
//   - If extraSeats > 0: +N× PRICE_IDS.growth ($14.99/seat/mo)
//
// POST /create-subscription
// Body: { companyId, email, name, extraSeats? }
// Returns: { subscriptionId, customerId, clientSecret, trialEnd, status }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/create-subscription', async (req, res) => {
  try {
    const { companyId, email, name, extraSeats = 0 } = req.body;

    if (!companyId || !email) {
      return res.status(400).json({ error: 'companyId and email are required' });
    }

    const extraSeatCount = Math.max(0, parseInt(extraSeats, 10) || 0);
    console.log(`[Stripe] create-subscription — company: ${companyId}, email: ${email}, extraSeats: ${extraSeatCount}`);

    // ── 1. Find or create Stripe Customer ─────────────────────────────────────
    let customerId = null;

    if (db) {
      const companyDoc = await db.collection('companies').doc(companyId).get();
      if (companyDoc.exists) {
        customerId = companyDoc.data()?.stripe_customer_id || null;
      }
    }

    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        name: name || '',
        metadata: { companyId },
      });
      customerId = customer.id;
      console.log(`[Stripe] Created customer: ${customerId}`);

      if (db) {
        await db.collection('companies').doc(companyId).update({
          stripe_customer_id: customerId,
        });
      }
    } else {
      console.log(`[Stripe] Reusing customer: ${customerId}`);
    }

    // ── 2. Build subscription items ───────────────────────────────────────────
    // Always include the base plan. Add seat price only if extra seats requested.
    const items = [{ price: PRICE_IDS.starter }];
    if (extraSeatCount > 0) {
      items.push({ price: PRICE_IDS.growth, quantity: extraSeatCount });
    }

    // ── 3. Create Subscription with 14-day trial ──────────────────────────────
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items,
      trial_period_days: 14,
      payment_behavior: 'default_incomplete',
      payment_settings: {
        save_default_payment_method: 'on_subscription',
        payment_method_types: ['card'],
      },
      expand: ['latest_invoice.payment_intent'],
      metadata: { companyId, extraSeats: String(extraSeatCount) },
    });

    console.log(`[Stripe] Subscription created: ${subscription.id} — status: ${subscription.status}, items: ${items.length}`);

    // ── 4. Extract client_secret for Flutter payment sheet ────────────────────
    const paymentIntent = subscription.latest_invoice?.payment_intent;
    const clientSecret  = paymentIntent?.client_secret || null;

    // ── 5. Compute seat totals and persist to Firestore ───────────────────────
    const includedSeats  = 3;
    const purchasedSeats = includedSeats + extraSeatCount;

    if (db) {
      const trialEnd = new Date(subscription.trial_end * 1000);
      await db.collection('companies').doc(companyId).update({
        subscription: {
          stripe_subscription_id: subscription.id,
          stripe_customer_id:     customerId,
          status:                 'trialing',
          trial_start:            admin.firestore.Timestamp.fromDate(new Date(subscription.trial_start * 1000)),
          trial_end:              admin.firestore.Timestamp.fromDate(trialEnd),
          current_period_end:     admin.firestore.Timestamp.fromDate(new Date(subscription.current_period_end * 1000)),
          updated_at:             admin.firestore.FieldValue.serverTimestamp(),
        },
      });

      // Also write to saas_metrics for seat tracking
      await db.collection('saas_metrics').doc('metrics_current').set({
        subscription_status:     'trialing',
        stripe_subscription_id:  subscription.id,
        stripe_customer_id:      customerId,
        purchased_seats:         purchasedSeats,
        extra_seats:             extraSeatCount,
        updated_at:              admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      console.log(`[Firestore] Subscription written — trial ends: ${trialEnd.toISOString()}, seats: ${purchasedSeats}`);
    }

    res.json({
      subscriptionId: subscription.id,
      customerId,
      clientSecret,
      trialEnd: subscription.trial_end,
      status: subscription.status,
    });

  } catch (err) {
    console.error('[Stripe] create-subscription error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STRIPE — ADD SEAT
//
// Called when an admin invites a team member but all included seats are used.
// Modifies the existing subscription IN-PLACE — never cancels or recreates.
//
// Logic:
//   1. Retrieve existing subscription from Stripe
//   2. Find the growth (per-seat) item if it exists, or add it fresh
//   3. Increment its quantity by 1 via stripe.subscriptions.update()
//   4. Write updated purchased_seats / extra_seats to Firestore saas_metrics
//
// POST /add-seat
// Body: { subscriptionId, companyId }
// Returns: { success, purchasedSeats, extraSeats, subscriptionId }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/add-seat', async (req, res) => {
  try {
    const { subscriptionId, companyId } = req.body;

    if (!subscriptionId || !companyId) {
      return res.status(400).json({ error: 'subscriptionId and companyId are required' });
    }

    console.log(`[Stripe] add-seat — company: ${companyId}, subscription: ${subscriptionId}`);

    // ── 1. Retrieve the existing subscription ─────────────────────────────────
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);

    if (!subscription || subscription.status === 'canceled') {
      return res.status(400).json({ error: 'Subscription not found or already cancelled.' });
    }

    // ── 2. Find the per-seat (growth) item in the subscription ────────────────
    const seatPriceId = PRICE_IDS.growth;
    const existingSeatItem = subscription.items.data.find(
      (item) => item.price.id === seatPriceId
    );

    let updatedSubscription;

    if (existingSeatItem) {
      // Increment the existing seat item quantity by 1
      const newQuantity = existingSeatItem.quantity + 1;
      console.log(`[Stripe] Incrementing seat item ${existingSeatItem.id} quantity: ${existingSeatItem.quantity} → ${newQuantity}`);

      updatedSubscription = await stripe.subscriptions.update(subscriptionId, {
        items: [{
          id:       existingSeatItem.id,
          quantity: newQuantity,
        }],
        proration_behavior: 'create_prorations',
      });
    } else {
      // No seat item yet — add one with quantity 1
      console.log(`[Stripe] Adding new seat item (quantity: 1) to subscription ${subscriptionId}`);

      updatedSubscription = await stripe.subscriptions.update(subscriptionId, {
        items: [{
          price:    seatPriceId,
          quantity: 1,
        }],
        proration_behavior: 'create_prorations',
      });
    }

    // ── 3. Compute updated seat totals ────────────────────────────────────────
    const includedSeats = 3;
    const updatedSeatItem = updatedSubscription.items.data.find(
      (item) => item.price.id === seatPriceId
    );
    const extraSeats     = updatedSeatItem ? updatedSeatItem.quantity : 0;
    const purchasedSeats = includedSeats + extraSeats;

    console.log(`[Stripe] Seat added — extra: ${extraSeats}, total: ${purchasedSeats}`);

    // ── 4. Write updated seat counts to Firestore ─────────────────────────────
    if (db) {
      await db.collection('saas_metrics').doc('metrics_current').set({
        purchased_seats: purchasedSeats,
        extra_seats:     extraSeats,
        updated_at:      admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      console.log(`[Firestore] Seat counts updated — purchased: ${purchasedSeats}, extra: ${extraSeats}`);
    }

    res.json({
      success:        true,
      subscriptionId: updatedSubscription.id,
      purchasedSeats,
      extraSeats,
    });

  } catch (err) {
    console.error('[Stripe] add-seat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STRIPE — WEBHOOK
//
// Stripe calls this endpoint when subscription events occur.
// Signature verification ensures requests are genuinely from Stripe.
// Updates Firestore so the app always reflects the true subscription state.
//
// POST /stripe-webhook
// ─────────────────────────────────────────────────────────────────────────────
app.post('/stripe-webhook', async (req, res) => {
  const sig     = req.headers['stripe-signature'];
  const secret  = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    console.warn('[Webhook] STRIPE_WEBHOOK_SECRET not set — skipping verification');
    return res.status(400).json({ error: 'Webhook secret not configured' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('[Webhook] Signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  console.log(`[Webhook] Event received: ${event.type}`);

  try {
    switch (event.type) {

      // ── Trial will end soon (3 days warning) ─────────────────────────────
      case 'customer.subscription.trial_will_end': {
        const sub       = event.data.object;
        const companyId = sub.metadata?.companyId;
        if (companyId && db) {
          await db.collection('companies').doc(companyId).update({
            'subscription.status':    'trial_ending',
            'subscription.updated_at': admin.firestore.FieldValue.serverTimestamp(),
          });
          console.log(`[Webhook] Trial ending soon — company: ${companyId}`);
        }
        break;
      }

      // ── Subscription updated (trial → active, plan change, seat add, etc.) ──
      case 'customer.subscription.updated': {
        const sub       = event.data.object;
        const companyId = sub.metadata?.companyId;
        if (companyId && db) {
          // Compute seat counts from subscription items
          const seatPriceId    = PRICE_IDS.growth;
          const seatItem       = sub.items?.data?.find((i) => i.price?.id === seatPriceId);
          const extraSeats     = seatItem ? (seatItem.quantity || 0) : 0;
          const includedSeats  = 3;
          const purchasedSeats = includedSeats + extraSeats;

          // Update company subscription record
          await db.collection('companies').doc(companyId).update({
            'subscription.status':             sub.status,
            'subscription.current_period_end': admin.firestore.Timestamp.fromDate(
              new Date(sub.current_period_end * 1000)
            ),
            'subscription.updated_at': admin.firestore.FieldValue.serverTimestamp(),
          });

          // Sync seat counts to saas_metrics
          await db.collection('saas_metrics').doc('metrics_current').set({
            subscription_status:    sub.status,
            stripe_subscription_id: sub.id,
            purchased_seats:        purchasedSeats,
            extra_seats:            extraSeats,
            updated_at:             admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });

          console.log(`[Webhook] Subscription updated — company: ${companyId}, status: ${sub.status}, seats: ${purchasedSeats} (${extraSeats} extra)`);
        }
        break;
      }

      // ── Payment succeeded (trial ended, card charged successfully) ────────
      case 'invoice.payment_succeeded': {
        const invoice   = event.data.object;
        const subId     = invoice.subscription;
        if (!subId) break;

        const sub       = await stripe.subscriptions.retrieve(subId);
        const companyId = sub.metadata?.companyId;

        if (companyId && db) {
          await db.collection('companies').doc(companyId).update({
            'subscription.status':             'active',
            'subscription.current_period_end': admin.firestore.Timestamp.fromDate(
              new Date(sub.current_period_end * 1000)
            ),
            'subscription.last_payment':       admin.firestore.FieldValue.serverTimestamp(),
            'subscription.updated_at':         admin.firestore.FieldValue.serverTimestamp(),
          });
          console.log(`[Webhook] Payment succeeded — company: ${companyId}`);
        }
        break;
      }

      // ── Payment failed (card declined after trial) ────────────────────────
      case 'invoice.payment_failed': {
        const invoice   = event.data.object;
        const subId     = invoice.subscription;
        if (!subId) break;

        const sub       = await stripe.subscriptions.retrieve(subId);
        const companyId = sub.metadata?.companyId;

        if (companyId && db) {
          await db.collection('companies').doc(companyId).update({
            'subscription.status':     'past_due',
            'subscription.updated_at': admin.firestore.FieldValue.serverTimestamp(),
          });
          console.log(`[Webhook] Payment failed — company: ${companyId}`);
        }
        break;
      }

      // ── Subscription cancelled ────────────────────────────────────────────
      case 'customer.subscription.deleted': {
        const sub       = event.data.object;
        const companyId = sub.metadata?.companyId;
        if (companyId && db) {
          await db.collection('companies').doc(companyId).update({
            'subscription.status':     'canceled',
            'subscription.updated_at': admin.firestore.FieldValue.serverTimestamp(),
          });
          console.log(`[Webhook] Subscription cancelled — company: ${companyId}`);
        }
        break;
      }

      default:
        console.log(`[Webhook] Unhandled event type: ${event.type}`);
    }
  } catch (err) {
    console.error('[Webhook] Handler error:', err.message);
    // Still return 200 so Stripe doesn't retry — log the error for investigation
  }

  res.json({ received: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// OPENAI — GENERATE SMS
//
// Generates a personalized SMS message for a specific message type.
//
// POST /generate-sms
// Body: {
//   type,          // 'review_request' | 'scheduled' | 'crew_on_way' |
//                  // 'in_progress' | 'completed' | 'thank_you'
//   customerName,  // "John"
//   jobType,       // "Roof Replacement"
//   companyName,   // "Smith Roofing"
//   reviewLink,    // optional — Google review URL
//   crewNote,      // optional — any context the crew added
// }
// Returns: { message }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/generate-sms', async (req, res) => {
  if (!openai) {
    return res.status(503).json({ error: 'OpenAI not configured on server' });
  }

  try {
    const {
      type         = 'review_request',
      customerName = 'there',
      jobType      = 'project',
      companyName  = 'our company',
      reviewLink   = '',
      crewNote     = '',
    } = req.body;

    const typeDescriptions = {
      review_request: 'asking the customer to leave a Google review now that the job is done',
      scheduled:      'letting the customer know their job is scheduled and we\'ll reach out before we come',
      crew_on_way:    'telling the customer the crew just left and is on the way to their property',
      in_progress:    'letting the customer know the crew is on site and work has started',
      completed:      'letting the customer know the job is done and crew has cleaned up',
      thank_you:      'a genuine personal thank you for their business after the job is complete',
    };

    const typeContext = typeDescriptions[type] || 'a job status update';
    const reviewStr  = reviewLink ? `\nInclude this review link naturally: ${reviewLink}` : '';
    const noteStr    = crewNote   ? `\nCrew note about the job: "${crewNote}"` : '';

    const prompt = `You are writing a text message from a trade contractor to their customer.

Contractor company: ${companyName}
Customer first name: ${customerName}
Job type: ${jobType}
Message purpose: ${typeContext}${reviewStr}${noteStr}

Write a single SMS text message that:
- Sounds like a real person texting, not a corporation
- Is warm, professional, and brief (2-4 sentences max)
- Starts naturally — NOT with "I hope this message finds you well" or "Dear ${customerName}"
- Uses the customer's first name once, naturally
- Does NOT use the word "thrilled", "delighted", "excited", or "pleased"
- Feels personal, like it came from the owner or crew lead personally
- Includes 1 emoji max, only if it fits naturally
${reviewLink ? '- The review link should be on its own line after the request' : ''}

Respond in this exact JSON format:
{ "message": "the text message here" }`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.85,
      max_tokens: 200,
      response_format: { type: 'json_object' },
    });

    const raw = completion.choices[0].message.content;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(500).json({ error: 'Failed to parse AI response' });
    }

    const message = (parsed.message || '').trim();
    if (!message) return res.status(500).json({ error: 'Empty message from AI' });

    console.log(`[OpenAI] SMS generated — type: ${type}, customer: ${customerName}, ${message.length} chars`);
    res.json({ message });

  } catch (err) {
    console.error('[OpenAI] generate-sms error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TWILIO — SEND SMS
//
// Flutter SmsService calls POST /sms/send
// Also aliased as POST /send-sms for compatibility.
//
// Body: { to_phone, body, job_id, template_key, customer_name, type }
// Returns: { success, message: { id, sid, to, from, body, status, ... } }
// ─────────────────────────────────────────────────────────────────────────────
async function handleSendSms(req, res) {
  try {
    const {
      to_phone,
      body,
      job_id       = '',
      template_key = '',
      customer_name = '',
      type         = 'statusUpdate',
    } = req.body;

    // Support both 'to' and 'to_phone' field names
    const to = to_phone || req.body.to;

    if (!to || !body) {
      return res.status(400).json({ error: 'to_phone and body are required' });
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken  = process.env.TWILIO_AUTH_TOKEN;
    const from       = process.env.TWILIO_PHONE_NUMBER;

    if (!accountSid || !authToken || !from) {
      return res.status(503).json({ error: 'Twilio not configured' });
    }

    const twilio  = require('twilio')(accountSid, authToken);
    const msg     = await twilio.messages.create({ to, from, body });

    console.log(`[Twilio] SMS sent — sid: ${msg.sid}, to: ${to}, template: ${template_key}`);

    // Return message object in the shape Flutter SmsService._parseMessage() expects
    res.json({
      success: true,
      message: {
        id:            msg.sid,
        sid:           msg.sid,
        job_id:        job_id,
        company_id:    '',
        customer_name: customer_name,
        to:            msg.to,
        from:          msg.from,
        to_phone:      msg.to,
        from_phone:    msg.from,
        body:          body,
        type:          type,
        status:        msg.status,
        template_key:  template_key,
        is_mock:       false,
        sent_at:       new Date().toISOString(),
      },
    });

  } catch (err) {
    console.error('[Twilio] send-sms error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

// Register both routes — Flutter uses /sms/send
app.post('/sms/send',  handleSendSms);
app.post('/send-sms',  handleSendSms);

// ─── SMS log (stub — Twilio handles real delivery tracking) ───────────────────
app.get('/sms/log', (req, res) => {
  res.json({ messages: [] });
});

// ─────────────────────────────────────────────────────────────────────────────
// GBP — PUBLISH GOOGLE POST
//
// POST /publish-google-post
// Body: { companyId, locationId, text, imageUrl }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/publish-google-post', async (req, res) => {
  try {
    const { companyId, locationId, text, imageUrl } = req.body;

    if (!locationId || !text) {
      return res.status(400).json({ error: 'locationId and text are required' });
    }

    // Retrieve company's GBP access token from Firestore
    if (!db) {
      return res.status(503).json({ error: 'Firebase not configured' });
    }

    const companyDoc = await db.collection('companies').doc(companyId).get();
    const accessToken = companyDoc.data()?.gbp_access_token;

    if (!accessToken) {
      return res.status(401).json({ error: 'GBP not connected for this company' });
    }

    // Post to Google Business Profile API
    const fetch = (await import('node-fetch')).default;
    const body = {
      languageCode: 'en-US',
      summary: text,
      topicType: 'STANDARD',
    };
    if (imageUrl) {
      body.media = [{ mediaFormat: 'PHOTO', sourceUrl: imageUrl }];
    }

    const response = await fetch(
      `https://mybusiness.googleapis.com/v4/${locationId}/localPosts`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );

    const result = await response.json();
    if (!response.ok) {
      console.error('[GBP] Post failed:', result);
      return res.status(response.status).json({ error: result.error?.message || 'GBP post failed' });
    }

    console.log(`[GBP] Post published — company: ${companyId}`);
    res.json({ success: true, post: result });

  } catch (err) {
    console.error('[GBP] publish error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Server] TradeRep Pro backend running on port ${PORT}`);
  console.log(`[Server] Stripe:  ${process.env.STRIPE_SECRET_KEY ? '✅' : '❌ not configured'}`);
  console.log(`[Server] Twilio:  ${process.env.TWILIO_ACCOUNT_SID ? '✅' : '⚠️  not configured'}`);
  console.log(`[Server] Firebase:${db ? '✅' : '⚠️  not configured'}`);
  console.log(`[Server] OpenAI:  ${openai ? '✅' : '⚠️  not configured — add OPENAI_API_KEY'}`);
});
