/**
 * server.js
 * Dukaan Pro backend (ES module style)
 * Endpoints:
 *  GET  /health
 *  GET  /plans
 *  GET  /generate-key  (admin use — optional INTERNAL_API_KEY)
 *  POST /validate-key  (body: { key })
 *  POST /log-invoice   (body: invoice data) (optional INTERNAL_API_KEY)
 *
 * Env variables used (see .env.example)
 */

import express from 'express';
import cors from 'cors';
import { google } from 'googleapis';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

const PORT = process.env.PORT || 3000;
const APP_SECRET_KEY = process.env.APP_SECRET_KEY || 'CHANGE_ME_SECRET_123!';
const CUSTOMER_SPREADSHEET_ID = process.env.CUSTOMER_SPREADSHEET_ID || '';
const INVOICE_SPREADSHEET_ID = process.env.INVOICE_SPREADSHEET_ID || '';
const CUSTOMER_SHEET_NAME = process.env.CUSTOMER_SHEET_NAME || 'Customers';
const INVOICE_SHEET_NAME = process.env.INVOICE_SHEET_NAME || 'Invoices';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';

const isGoogleConfigured = !!(process.env.GOOGLE_CREDENTIALS && CUSTOMER_SPREADSHEET_ID && INVOICE_SPREADSHEET_ID);

// derive 32-byte key
const KEY = createHash('sha256').update(APP_SECRET_KEY).digest();
const ALGO = 'aes-256-cbc';

let GOOGLE_CLIENT_EMAIL = '';
let GOOGLE_PRIVATE_KEY = '';
if (process.env.GOOGLE_CREDENTIALS) {
  try {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    GOOGLE_CLIENT_EMAIL = creds.client_email;
    GOOGLE_PRIVATE_KEY = creds.private_key?.replace(/\\n/g, '\n');
  } catch (e) {
    console.error('Invalid GOOGLE_CREDENTIALS env JSON.');
  }
}

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let sheets = null;
if (isGoogleConfigured && GOOGLE_CLIENT_EMAIL && GOOGLE_PRIVATE_KEY) {
  const auth = new google.auth.JWT({
    email: GOOGLE_CLIENT_EMAIL,
    key: GOOGLE_PRIVATE_KEY,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  sheets = google.sheets({ version: 'v4', auth });
}

function encryptPayload(text) {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGO, KEY, iv);
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  return iv.toString('hex') + enc; // iv + ciphertext
}

function decryptPayload(keyHex) {
  try {
    if (!keyHex || keyHex.length < 64) return null;
    const iv = Buffer.from(keyHex.slice(0, 32), 'hex');
    const cipherText = keyHex.slice(32);
    if (iv.length !== 16) return null;
    const decipher = createDecipheriv(ALGO, KEY, iv);
    let dec = decipher.update(cipherText, 'hex', 'utf8');
    dec += decipher.final('utf8');
    return dec;
  } catch (e) {
    return null;
  }
}

function calculateExpiry(plan) {
  const now = new Date();
  const expiry = new Date(now);
  const p = (plan || '').toString().toLowerCase();
  if (p.includes('month')) {
    const n = parseInt(p.match(/(\\d+)/)?.[0] || '1');
    expiry.setMonth(now.getMonth() + n);
  } else if (p.includes('year')) {
    const n = parseInt(p.match(/(\\d+)/)?.[0] || '1');
    expiry.setFullYear(now.getFullYear() + n);
  } else if (p.includes('day') || p.includes('trial')) {
    const n = parseInt(p.match(/(\\d+)/)?.[0] || '1');
    expiry.setDate(now.getDate() + n);
  } else {
    expiry.setMonth(now.getMonth() + 1);
  }
  expiry.setHours(23,59,59,999);
  return expiry;
}

async function readSheet(sheetId, sheetName) {
  if (!sheets) throw new Error('Google Sheets not configured');
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${sheetName}!A:Z` });
  const rows = resp.data.values || [];
  if (rows.length <= 1) return [];
  const headers = rows[0];
  return rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h,i)=> obj[h.toString().toLowerCase().replace(/\s/g,'')] = r[i] || '');
    return obj;
  });
}

function requireInternalKey(req, res, next) {
  if (!INTERNAL_API_KEY) return next();
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (!key || key !== INTERNAL_API_KEY) return res.status(401).json({ message: 'Unauthorized' });
  next();
}

// Health
app.get('/health', (req,res) => res.json({ ok:true }));

app.get('/plans', (req,res) => {
  res.json([
    { name: 'Monthly', price: 999 },
    { name: '6 Month', price: 4500 },
    { name: '1 Year', price: 8500 },
    { name: 'Lifetime', price: 15000 }
  ]);
});

// Generate Key (admin)
app.get('/generate-key', requireInternalKey, async (req,res) => {
  const { name, contact, plan, address } = req.query;
  if (!name || !contact || !plan) return res.status(400).json({ isValid:false, message:'name, contact and plan required' });
  try {
    const start = new Date();
    const expiry = calculateExpiry(plan);
    const payload = JSON.stringify({ name, contact, plan: plan.toUpperCase(), generated: start.toISOString(), expiry: expiry.toISOString(), rand: randomBytes(4).toString('hex') });
    const licenseKey = encryptPayload(payload);

    // append to customers sheet if configured
    if (sheets) {
      const rows = await readSheet(CUSTOMER_SPREADSHEET_ID, CUSTOMER_SHEET_NAME).catch(()=>[]);
      const lastSerial = rows.length>0 ? rows.reverse().find(r=>r.serialnumber?.startsWith('CUST-'))?.serialnumber : 'CUST-0000';
      const lastNum = lastSerial?.match(/(\\d+)$/)?.[0] || '0';
      const next = 'CUST-' + String(parseInt(lastNum)+1).padStart(4,'0');
      const rowData = [next, licenseKey, name, address||'', contact, plan, start.toLocaleString('en-US'), expiry.toLocaleString('en-US')];
      await sheets.spreadsheets.values.append({ spreadsheetId: CUSTOMER_SPREADSHEET_ID, range: `${CUSTOMER_SHEET_NAME}!A:H`, valueInputOption: 'USER_ENTERED', requestBody:{ values:[rowData] } }).catch(e=>console.error('sheet append err', e.message));
    }

    return res.json({ isValid:true, licenseKey, expiryDate: expiry.toISOString(), message:'License created' });
  } catch (err) {
    console.error('generate-key err', err.message);
    return res.status(500).json({ isValid:false, message: 'Server error: ' + err.message });
  }
});

// Validate Key (POST)
app.post('/validate-key', async (req,res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ isValid:false, message:'key required' });

  // Support quick trial keys like "TRIAL" or "TRIAL 1"
  if (key.toString().toUpperCase().startsWith('TRIAL')) {
    const expiry = calculateExpiry(key);
    return res.json({ isValid:true, plan:'TRIAL', message:'Trial valid', expiryDate: expiry.toISOString() });
  }

  try {
    const dec = decryptPayload(key);
    if (!dec) return res.json({ isValid:false, message:'Invalid key or secret mismatch' });
    const data = JSON.parse(dec);
    const exp = new Date(data.expiry);
    if (new Date() > exp) return res.json({ isValid:false, status:'expired', message:'License expired', expiryDate: exp.toISOString() });
    return res.json({ isValid:true, plan: data.plan || 'UNKNOWN', name: data.name || '', contact: data.contact || '', expiryDate: exp.toISOString(), message:'Key valid' });
  } catch (err) {
    console.error('validate-key err', err.message);
    return res.status(500).json({ isValid:false, message:'Server error during validation' });
  }
});

// Log invoice
app.post('/log-invoice', requireInternalKey, async (req,res) => {
  const { invoiceNumber, customerName, totalAmount, items, date } = req.body;
  if (!invoiceNumber || !totalAmount || !items || !date) return res.status(400).json({ success:false, message:'Missing invoice fields' });
  try {
    if (sheets) {
      const row = [ new Date().toLocaleString('en-US'), invoiceNumber, customerName||'N/A', parseFloat(totalAmount).toFixed(2), items.length, JSON.stringify(items), date ];
      await sheets.spreadsheets.values.append({ spreadsheetId: INVOICE_SPREADSHEET_ID, range: `${INVOICE_SHEET_NAME}!A:G`, valueInputOption:'USER_ENTERED', requestBody:{ values:[row] } }).catch(e=>console.error('sheet append err', e.message));
    }
    return res.json({ success:true, message:`Invoice ${invoiceNumber} logged` });
  } catch (err) {
    console.error('log-invoice err', err.message);
    return res.status(500).json({ success:false, message: 'Server error: ' + err.message });
  }
});

app.listen(PORT, ()=> console.log(`✅ Dukaan Pro server listening on ${PORT}`));