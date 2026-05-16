/**
 * POST /.netlify/functions/create-form
 * Body: { clientName, title, text }
 *
 * Questionnaire format (one question per line):
 *   Question - TYPE
 *   Question - TYPE - option1, option2, option3
 *
 * Supported types:
 *   TEXT, PARAGRAPH_TEXT
 *   MULTIPLE_CHOICE - option1, option2
 *   CHECKBOX        - option1, option2
 *   DROPDOWN        - option1, option2
 *   SCALE           - minVal, maxVal, minLabel, maxLabel
 *   SCALE           (defaults to 1–5, no labels)
 */

const { GoogleAuth }  = require('google-auth-library');
const { google }      = require('googleapis');
const { MongoClient } = require('mongodb');

// ── MongoDB singleton ────────────────────────────────────────────────────────
let _mongoClient;
async function getMongo() {
  if (!_mongoClient) {
    _mongoClient = new MongoClient(process.env.MONGODB_URI);
    await _mongoClient.connect();
  }
  return _mongoClient.db(process.env.MONGODB_DB || 'dreamshift');
}

// ── Google auth ──────────────────────────────────────────────────────────────
let _formsClient;
async function getForms() {
  if (!_formsClient) {

    const hasOAuth =
      !!process.env.GOOGLE_CLIENT_ID &&
      !!process.env.GOOGLE_CLIENT_SECRET &&
      !!process.env.GOOGLE_REFRESH_TOKEN;

    // Log exactly what we have (lengths, not values — safe for logs)
    console.log('[AUTH] GOOGLE_CLIENT_ID      present:', !!process.env.GOOGLE_CLIENT_ID,   '| length:', (process.env.GOOGLE_CLIENT_ID   || '').length);
    console.log('[AUTH] GOOGLE_CLIENT_SECRET  present:', !!process.env.GOOGLE_CLIENT_SECRET,'| length:', (process.env.GOOGLE_CLIENT_SECRET|| '').length);
    console.log('[AUTH] GOOGLE_REFRESH_TOKEN  present:', !!process.env.GOOGLE_REFRESH_TOKEN,'| length:', (process.env.GOOGLE_REFRESH_TOKEN|| '').length);
    console.log('[AUTH] Refresh token starts with:', (process.env.GOOGLE_REFRESH_TOKEN || '').slice(0, 6));
    console.log('[AUTH] Path selected:', hasOAuth ? 'OAuth2 ✓' : 'Service account (fallback)');

    if (hasOAuth) {
      console.log('[AUTH] Building OAuth2 client...');
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET
      );
      oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
      _formsClient = google.forms({ version: 'v1', auth: oauth2Client });
      console.log('[AUTH] OAuth2 client ready');

    } else {
      console.log('[AUTH] OAuth2 vars missing — attempting service account fallback');
      console.log('[AUTH] GOOGLE_SERVICE_ACCOUNT_KEY present:', !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
      console.log('[AUTH] GOOGLE_IMPERSONATE_EMAIL   present:', !!process.env.GOOGLE_IMPERSONATE_EMAIL);

      const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '{}');
      const scopes = [
        'https://www.googleapis.com/auth/forms.body',
        'https://www.googleapis.com/auth/drive'
      ];
      const authConfig = { credentials, scopes };
      if (process.env.GOOGLE_IMPERSONATE_EMAIL) {
        authConfig.clientOptions = { subject: process.env.GOOGLE_IMPERSONATE_EMAIL };
      }
      const auth   = new GoogleAuth(authConfig);
      const client = await auth.getClient();
      _formsClient = google.forms({ version: 'v1', auth: client });
      console.log('[AUTH] Service account client ready');
    }
  }
  return _formsClient;
}

// ── Key/value parser ─────────────────────────────────────────────────────────
// Format: "Question text - TYPE" or "Question text - TYPE - option1, option2"
function parseKeyValue(text) {
  const questions = [];
  const errors    = [];
  const lines     = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

  console.log(`[PARSE] Processing ${lines.length} lines`);

  for (let i = 0; i < lines.length; i++) {
    const line  = lines[i];
    const parts = line.split(' - ').map(p => p.trim());

    if (parts.length < 2) {
      errors.push(`Line ${i + 1}: missing " - " separator → "${line}"`);
      continue;
    }

    const questionText = parts[0];
    const typeRaw      = parts[1];
    const typeStr      = typeRaw.toUpperCase();
    const optionsStr   = parts[2]; // may be undefined

    // Section header
    if (typeStr === 'SECTION') {
      questions.push({ _isSection: true, title: questionText });
      continue;
    }

    const validTypes = ['TEXT', 'PARAGRAPH_TEXT', 'MULTIPLE_CHOICE', 'CHECKBOX', 'DROPDOWN', 'SCALE'];
    if (!validTypes.includes(typeStr)) {
      errors.push(`Line ${i + 1}: unknown type "${typeRaw}" — valid types: ${validTypes.join(', ')}`);
      continue;
    }

    const q = { title: questionText, type: typeStr, required: true };

    // Choice types — need options
    if (['MULTIPLE_CHOICE', 'CHECKBOX', 'DROPDOWN'].includes(typeStr)) {
      if (!optionsStr) {
        errors.push(`Line ${i + 1}: ${typeStr} needs options after a second " - "`);
        continue;
      }
      q.options = optionsStr.split(',').map(o => o.trim()).filter(Boolean);
      if (!q.options.length) {
        errors.push(`Line ${i + 1}: no valid options found for ${typeStr}`);
        continue;
      }
    }

    // Scale — optional params
    if (typeStr === 'SCALE' && optionsStr) {
      const sp = optionsStr.split(',').map(p => p.trim());
      q.scaleMin      = parseInt(sp[0], 10) || 1;
      q.scaleMax      = parseInt(sp[1], 10) || 5;
      q.scaleMinLabel = sp[2] || '';
      q.scaleMaxLabel = sp[3] || '';
    } else if (typeStr === 'SCALE') {
      q.scaleMin = 1;
      q.scaleMax = 5;
    }

    questions.push(q);
  }

  console.log(`[PARSE] ${questions.length} questions parsed, ${errors.length} errors`);
  if (errors.length) console.log('[PARSE] Errors:', errors);

  return { questions, errors };
}

// ── Build Google Forms batchUpdate requests ──────────────────────────────────
function buildRequests(questions) {
  const requests = [];
  let index = 0;

  for (const q of questions) {

    if (q._isSection) {
      requests.push({
        createItem: {
          item: { title: q.title, pageBreakItem: {} },
          location: { index: index++ }
        }
      });
      continue;
    }

    const item = {
      title: q.title,
      questionItem: { question: { required: q.required ?? true } }
    };

    switch (q.type) {
      case 'TEXT':
        item.questionItem.question.textQuestion = { paragraph: false };
        break;
      case 'PARAGRAPH_TEXT':
        item.questionItem.question.textQuestion = { paragraph: true };
        break;
      case 'MULTIPLE_CHOICE':
      case 'CHECKBOX':
      case 'DROPDOWN': {
        // Deduplicate options — Google Forms API rejects duplicate values
        const seen    = new Set();
        const deduped = (q.options || [])
          .map(o => String(o).trim())
          .filter(o => o && !seen.has(o) && seen.add(o));

        if (deduped.length !== (q.options || []).length) {
          console.warn(`[BUILD] Duplicates removed from "${q.title}":`, q.options);
        }

        const choiceType =
          q.type === 'MULTIPLE_CHOICE' ? 'RADIO' :
          q.type === 'CHECKBOX'        ? 'CHECKBOX' : 'DROP_DOWN';

        item.questionItem.question.choiceQuestion = {
          type:    choiceType,
          options: deduped.map(o => ({ value: o })),
          shuffle: false
        };
        break;
      }
      case 'SCALE':
        item.questionItem.question.scaleQuestion = {
          low:       q.scaleMin      ?? 1,
          high:      q.scaleMax      ?? 5,
          lowLabel:  q.scaleMinLabel ?? '',
          highLabel: q.scaleMaxLabel ?? ''
        };
        break;
      default:
        item.questionItem.question.textQuestion = { paragraph: false };
    }

    requests.push({ createItem: { item, location: { index: index++ } } });
  }

  return requests;
}

// ── TinyURL shorten ──────────────────────────────────────────────────────────
async function shorten(url) {
  try {
    const r    = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`);
    const text = await r.text();
    return text.startsWith('http') ? text.trim() : url;
  } catch {
    return url;
  }
}

// ── Handler ──────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  console.log('[HANDLER] create-form invoked:', event.httpMethod);

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { clientName, title, text } = body;
  if (!text?.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Questionnaire text is required' }) };
  }

  const formTitle = title?.trim() || `DreamShift — ${clientName || 'Client'} Intake`;
  console.log('[HANDLER] Client:', clientName, '| Title:', formTitle);

  // 1. Parse
  const { questions, errors: parseErrors } = parseKeyValue(text);

  if (!questions.length) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'No questions parsed. Format: "Question - TYPE" or "Question - TYPE - option1, option2"',
        parseErrors
      })
    };
  }

  const parseWarnings = parseErrors.length ? parseErrors : undefined;

  // 2. Auth + create form
  let forms;
  try {
    forms = await getForms();
  } catch (e) {
    console.error('[AUTH] Failed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: `Google auth failed: ${e.message}` }) };
  }

  let formId, responderUri;
  try {
    console.log('[FORMS] Creating form...');
    const createRes = await forms.forms.create({
      requestBody: { info: { title: formTitle, documentTitle: formTitle } }
    });
    formId       = createRes.data.formId;
    responderUri = createRes.data.responderUri;
    console.log('[FORMS] Created formId:', formId);
  } catch (e) {
    console.error('[FORMS] Create failed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: `Form create failed: ${e.message}` }) };
  }

  // 3. Add questions
  try {
    const requests = buildRequests(questions);
    console.log(`[FORMS] Adding ${requests.length} items via batchUpdate...`);
    if (requests.length) {
      await forms.forms.batchUpdate({ formId, requestBody: { requests } });
    }
    console.log('[FORMS] batchUpdate complete');
  } catch (e) {
    console.error('[FORMS] batchUpdate failed:', e.message);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: `Questions failed: ${e.message}`,
        editUrl: `https://docs.google.com/forms/d/${formId}/edit`
      })
    };
  }

  const editUrl      = `https://docs.google.com/forms/d/${formId}/edit`;
  const responderUrl = responderUri || `https://docs.google.com/forms/d/${formId}/viewform`;

  // 4. Shorten
  console.log('[TINYURL] Shortening responder URL...');
  const shortUrl = await shorten(responderUrl);
  console.log('[TINYURL] shortUrl:', shortUrl);

  // 5. MongoDB
  try {
    console.log('[MONGO] Saving form document...');
    const db = await getMongo();
    await db.collection('forms').insertOne({
      formId,
      clientName:    clientName || 'Unknown',
      title:         formTitle,
      editUrl,
      responderUrl,
      shortUrl,
      questionCount: questions.filter(q => !q._isSection).length,
      questions,
      responseCount: 0,
      createdAt:     new Date()
    });
    console.log('[MONGO] Saved');
  } catch (e) {
    console.error('[MONGO] Write failed (non-fatal):', e.message);
  }

  console.log('[HANDLER] Done — returning success');

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      formId,
      editUrl,
      responderUrl,
      shortUrl,
      parseWarnings,
      questions: questions
        .filter(q => !q._isSection)
        .map(q => ({ title: q.title, type: q.type }))
    })
  };
};