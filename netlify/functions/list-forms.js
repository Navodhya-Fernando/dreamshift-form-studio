/**
 * GET /.netlify/functions/list-forms
 * Returns all forms from MongoDB sorted by createdAt desc
 * Also refreshes responseCount from Google Forms API for each form
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
    const scopes = ['https://www.googleapis.com/auth/forms.responses.readonly'];

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

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let db;
  try { db = await getMongo(); }
  catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: `DB connection failed: ${e.message}` }) };
  }

  // Fetch forms from MongoDB
  const forms = await db.collection('forms')
    .find({})
    .sort({ createdAt: -1 })
    .toArray();

  // Optionally refresh response counts in background
  // We do this fire-and-forget so the list returns fast
  if (forms.length) {
    try {
      const formsApi = await getForms();
      const updates  = await Promise.allSettled(
        forms.map(async f => {
          const res = await formsApi.forms.responses.list({ formId: f.formId });
          const count = (res.data.responses || []).length;
          if (count !== f.responseCount) {
            await db.collection('forms').updateOne(
              { formId: f.formId },
              { $set: { responseCount: count } }
            );
            f.responseCount = count;
          }
        })
      );
    } catch {
      // Non-fatal — return whatever is in MongoDB
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      forms: forms.map(f => ({
        _id:           f._id,
        formId:        f.formId,
        clientName:    f.clientName,
        title:         f.title,
        editUrl:       f.editUrl,
        responderUrl:  f.responderUrl,
        shortUrl:      f.shortUrl,
        questionCount: f.questionCount,
        responseCount: f.responseCount || 0,
        createdAt:     f.createdAt
      }))
    })
  };
};
