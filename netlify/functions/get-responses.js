/**
 * GET /.netlify/functions/get-responses?formId=<googleFormId>
 * Fetches form responses from Google Forms API on demand
 * Also pulls question titles from MongoDB to map answer IDs → readable labels
 */

const { GoogleAuth }  = require('google-auth-library');
const { google }      = require('googleapis');
const { MongoClient } = require('mongodb');

let _mongoClient;
async function getMongo() {
  if (!_mongoClient) {
    _mongoClient = new MongoClient(process.env.MONGODB_URI);
    await _mongoClient.connect();
  }
  return _mongoClient.db(process.env.MONGODB_DB || 'dreamshift');
}

let _formsClient;
async function getForms() {
  if (!_formsClient) {
    const scopes = [
      'https://www.googleapis.com/auth/forms.responses.readonly',
      'https://www.googleapis.com/auth/forms.body.readonly'
    ];

    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN) {
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET
      );
      oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
      _formsClient = google.forms({ version: 'v1', auth: oauth2Client });
    } else {
      const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
      const authConfig = { credentials, scopes };
      if (process.env.GOOGLE_IMPERSONATE_EMAIL) {
        authConfig.clientOptions = { subject: process.env.GOOGLE_IMPERSONATE_EMAIL };
      }
      const auth   = new GoogleAuth(authConfig);
      const client = await auth.getClient();
      _formsClient = google.forms({ version: 'v1', auth: client });
    }
  }
  return _formsClient;
}

// Extract human-readable answer from a Google Forms response answer object
function extractAnswer(answer) {
  if (!answer) return '';
  const tv = answer.textAnswers;
  if (tv?.answers?.length) return tv.answers.map(a => a.value).join(', ');
  const fv = answer.fileUploadAnswers;
  if (fv?.answers?.length) return fv.answers.map(a => a.fileName).join(', ');
  return '';
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const formId = event.queryStringParameters?.formId;
  if (!formId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'formId is required' }) };
  }

  let formsApi;
  try { formsApi = await getForms(); }
  catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: `Auth failed: ${e.message}` }) };
  }

  // Fetch form structure (to get question ID → title mapping)
  let questionMap = {}; // questionId → title
  try {
    const formRes = await formsApi.forms.get({ formId });
    const items   = formRes.data.items || [];
    for (const item of items) {
      if (item.questionItem?.question?.questionId) {
        questionMap[item.questionItem.question.questionId] = item.title;
      }
      // Handle question groups
      if (item.questionGroupItem?.questions) {
        for (const q of item.questionGroupItem.questions) {
          if (q.questionId) questionMap[q.questionId] = q.rowQuestion?.title || item.title;
        }
      }
    }
  } catch {
    // Fallback: try to get question titles from MongoDB
    try {
      const db   = await getMongo();
      const form = await db.collection('forms').findOne({ formId });
      if (form?.questions) {
        form.questions.forEach((q, i) => {
          // MongoDB questions don't have questionIds — we'll match by index later
          questionMap[`q_${i}`] = q.title;
        });
      }
    } catch { /* ignore */ }
  }

  // Fetch responses
  let rawResponses;
  try {
    const res    = await formsApi.forms.responses.list({ formId });
    rawResponses = res.data.responses || [];
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: `Responses fetch failed: ${e.message}` }) };
  }

  // Shape into a clean format
  const responses = rawResponses.map(r => {
    const answers = Object.entries(r.answers || {}).map(([qId, ans]) => ({
      question: questionMap[qId] || qId,
      answer:   extractAnswer(ans)
    }));

    return {
      responseId:  r.responseId,
      email:       r.respondentEmail || null,
      submittedAt: r.createTime,
      answers
    };
  });

  // Update responseCount in MongoDB (fire-and-forget)
  getMongo()
    .then(db => db.collection('forms').updateOne(
      { formId },
      { $set: { responseCount: responses.length } }
    ))
    .catch(() => {});

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ formId, responses })
  };
};
