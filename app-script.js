app-script.js

// app-script.js
const RENDER_URL = "https://dukan-pro.onrender.com"; // Change to your deployed server
const API_VALIDATE = `${RENDER_URL}/validate-key`;
const API_LOG = `${RENDER_URL}/log-invoice`;

const activateBtn = document.getElementById('activate-btn');
const licenseKeyInput = document.getElementById('license-key');
const notificationBar = document.getElementById('notification-bar');
const licenseStatus = document.getElementById('license-status');
const appDiv = document.getElementById('app');

let invoiceItems = [];

activateBtn.addEventListener('click', ()=> {
  const key = licenseKeyInput.value.trim();
  if (!key) { showStatus('कृपया लाइसेंस कुंजी डालें', true); return; }
  validateKey(key);
});

async function validateKey(key) {
  showStatus('सत्यापित किया जा रहा है...', false);
  try {
    const res = await fetch(API_VALIDATE, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key })
    });
    const data = await res.json();
    if (data.isValid) {
      localStorage.setItem('licenseKey', key);
      localStorage.setItem('licenseVerified', 'true');
      showStatus(`लाइसेंस मान्य (${data.plan}). वैध: ${new Date(data.expiryDate).toLocaleString()}`, false);
      openApp();
    } else {
      showStatus(data.message || 'लाइसेंस अमान्य', true);
      closeApp();
    }
  } catch (err) {
    console.error('validate err', err);
    const cached = localStorage.getItem('licenseVerified');
    const saved = localStorage.getItem('licenseKey');
    if (cached === 'true' && saved) {
      showStatus('Offline: Cached license active', false);
      openApp();
    } else {
      showStatus('नेटवर्क त्रुटि: ' + err.message, true);
      closeApp();
    }
  }
}

function showStatus(msg, isError=false) {
  licenseStatus.innerText = msg;
  licenseStatus.className = isError ? 'text-danger' : 'text-success';
  notificationBar.classList.remove('d-none');
  notificationBar.innerText = msg;
  if (!isError) notificationBar.classList.replace('alert-warning','alert-success');
  else notificationBar.classList.replace('alert-success','alert-warning');
}

function openApp() {
  appDiv.style.display = 'block';
  updateInvoicePreview();
}

function closeApp() {
  appDiv.style.display = 'none';
}

// Item UI
const itemsContainer = document.getElementById('items-container');
function addItemRow() {
  const div = document.createElement('div');
  div.className = 'row g-2 mb-2 item-row';
  div.innerHTML = `
    <div class="col-5"><input class="form-control item-name" placeholder="Item description" oninput="updateInvoicePreview()"></div>
    <div class="col-2"><input type="number" class="form-control item-qty" value="1" min="1" oninput="updateInvoicePreview()"></div>
    <div class="col-2"><input type="number" class="form-control item-price" value="0" min="0" oninput="updateInvoicePreview()"></div>
    <div class="col-2"><input type="number" class="form-control item-gst" value="0" min="0" oninput="updateInvoicePreview()"></div>
    <div class="col-1 d-flex align-items-center"><button class="btn btn-danger btn-sm" onclick="removeItemRow(this)">X</button></div>
  `;
  itemsContainer.appendChild(div);
  updateInvoicePreview();
}

function removeItemRow(btn) { btn.closest('.item-row').remove(); updateInvoicePreview(); }

function calculateTotals() {
  const rows = document.querySelectorAll('.item-row');
  let subtotal = 0, totalTax = 0;
  invoiceItems = [];
  rows.forEach(r=>{
    const name = r.querySelector('.item-name')?.value || '';
    const qty = parseFloat(r.querySelector('.item-qty')?.value) || 0;
    const price = parseFloat(r.querySelector('.item-price')?.value) || 0;
    const gst = parseFloat(r.querySelector('.item-gst')?.value) || 0;
    const gross = qty * price;
    const tax = gross * gst / 100;
    subtotal += gross;
    totalTax += tax;
    invoiceItems.push({ name, qty, price, gst, gross, tax, total: gross + tax });
  });
  const roundOff = parseFloat(document.getElementById('roundOff')?.value) || 0;
  const final = subtotal + totalTax + roundOff;
  window.invoiceTotals = { subtotal, totalTax, roundOff, final };
  document.getElementById('final-total').innerText = final.toFixed(2);
  return window.invoiceTotals;
}

function updateInvoicePreview() {
  calculateTotals();
  const preview = document.getElementById('invoice-preview');
  if (!preview) return;
  const shopName = document.getElementById('shopName')?.value || 'Your Shop';
  const invoiceNo = document.getElementById('invoice-number')?.value || 'INV-0000';
  const date = new Date().toLocaleDateString('hi-IN');
  const rowsHtml = invoiceItems.map((it,i)=>`<tr><td>${i+1}</td><td>${it.name}</td><td>${it.qty}</td><td>₹${it.price.toFixed(2)}</td><td>${it.gst}%</td><td>₹${(it.total).toFixed(2)}</td></tr>`).join('');
  preview.innerHTML = `
    <div><h4>${shopName}</h4><div>Invoice: ${invoiceNo} | Date: ${date}</div></div>
    <table class="table table-bordered mt-2"><thead><tr><th>#</th><th>Item</th><th>Qty</th><th>Price</th><th>GST</th><th>Total</th></tr></thead><tbody>${rowsHtml || '<tr><td colspan="6">No items</td></tr>'}</tbody></table>
    <div class="text-end"><strong>Total: ₹${(window.invoiceTotals?.final||0).toFixed(2)}</strong></div>
  `;
}

function clearAll() {
  document.getElementById('shopName').value = 'Digital Store';
  document.getElementById('invoice-number').value = 'INV-0001';
  document.getElementById('customer-name').value = '';
  document.getElementById('roundOff').value = '0';
  itemsContainer.innerHTML = '';
  addItemRow();
  updateInvoicePreview();
}

async function downloadPDF() {
  const preview = document.getElementById('invoice-preview');
  if (!preview) return;
  const filename = `Invoice-${document.getElementById('invoice-number')?.value || 'INV'}.pdf`;
  html2pdf().from(preview).set({ margin:0.5, filename, html2canvas:{scale:2} }).save().then(()=> {
    // call log invoice
    const payload = { invoiceNumber: document.getElementById('invoice-number')?.value || 'INV', customerName: document.getElementById('customer-name')?.value || '', totalAmount: window.invoiceTotals?.final || 0, items: invoiceItems, date: new Date().toLocaleString() };
    // send in background (no blocking)
    fetch(API_LOG, { method:'POST', headers:{ 'Content-Type':'application/json', 'x-api-key': localStorage.getItem('INTERNAL_API_KEY') || '' }, body: JSON.stringify(payload) }).catch(e=>console.warn('Log invoice failed', e));
  });
}

// init
document.addEventListener('DOMContentLoaded', ()=>{
  if (document.querySelectorAll('.item-row').length === 0) addItemRow();
  updateInvoicePreview();

  // If cached verified license exists -> auto open
  const savedKey = localStorage.getItem('licenseKey');
  const verified = localStorage.getItem('licenseVerified');
  if (savedKey && verified === 'true') {
    showStatus('Cached license active', false);
    openApp();
  }
});