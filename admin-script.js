admin-script.js

// admin-script.js
const RENDER_URL = "https://dukan-pro.onrender.com";
const generateBtn = document.getElementById('btn-gen');
const refreshBtn = document.getElementById('btn-refresh');
const keysList = document.getElementById('keys-list');
const genResult = document.getElementById('gen-result');
const exportBtn = document.getElementById('btn-export');
const officeToggle = document.getElementById('office-toggle');
const filterInput = document.getElementById('filter-input');

async function generateKey() {
  const name = document.getElementById('admin-name').value.trim();
  const contact = document.getElementById('admin-contact').value.trim();
  const plan = document.getElementById('admin-plan').value;
  const address = document.getElementById('admin-address').value.trim();
  const apiKey = document.getElementById('admin-api-key').value.trim();

  if(!name || !contact) { genResult.innerHTML = `<div class="text-danger">Name & contact required</div>`; return; }
  try {
    const params = new URLSearchParams({ name, contact, plan });
    if (address) params.set('address', address);
    if (apiKey) params.set('apiKey', apiKey);
    const res = await fetch(`${RENDER_URL}/generate-key?${params.toString()}`);
    const data = await res.json();
    if (data.isValid) {
      genResult.innerHTML = `<pre>${data.licenseKey}</pre><div>Valid Till: ${new Date(data.expiryDate).toLocaleString()}</div>`;
      await refreshKeys(apiKey);
    } else {
      genResult.innerHTML = `<div class="text-danger">${data.message || 'Error'}</div>`;
    }
  } catch (e) {
    genResult.innerHTML = `<div class="text-danger">Network error: ${e.message}</div>`;
  }
}

async function refreshKeys(apiKey='') {
  keysList.innerHTML = 'Loading...';
  // As we are storing keys in Google Sheet, admin can read the sheet via server route (not implemented read-only)
  // For simplicity, we will show last-generated stored in localStorage (best-effort)
  const stored = JSON.parse(localStorage.getItem('admin_keys') || '[]');
  if(stored.length===0) keysList.innerHTML = '<div class="text-muted">No stored keys in admin cache.</div>';
  else {
    const q = filterInput.value.trim().toLowerCase();
    keysList.innerHTML = stored.filter(k=>{
      if(!q) return true;
      return (k.name||'').toLowerCase().includes(q) || (k.plan||'').toLowerCase().includes(q) || (k.licenseKey||'').toLowerCase().includes(q);
    }).map(k=>`<div class="key-row"><div><strong>${k.name}</strong> — <span class="meta">${k.plan} • ${new Date(k.expiry).toLocaleString()}</span></div><pre style="background:#f8f9fb;padding:6px;border-radius:6px;">${k.licenseKey}</pre></div>`).join('');
  }
}

generateBtn.addEventListener('click', async ()=> {
  await generateKey();
});

refreshBtn.addEventListener('click', ()=> refreshKeys(document.getElementById('admin-api-key').value.trim()));

exportBtn.addEventListener('click', ()=> {
  const data = JSON.parse(localStorage.getItem('admin_keys') || '[]');
  if (!data.length) return alert('No keys to export');
  const csv = ['name,contact,plan,expiry,licenseKey', ...data.map(d=>`${(d.name||'').replace(/,/g,' ')} , ${(d.contact||'')}, ${(d.plan||'')}, ${(d.expiry||'')}, "${(d.licenseKey||'')}"`)].join('\n');
  const blob = new Blob([csv], { type:'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `dukaanpro-keys-${Date.now()}.csv`; a.click();
});

// store generated keys in local admin cache (simple)
(function patchLocalSave() {
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const res = await originalFetch.apply(this, args);
    try {
      const url = args[0].toString();
      if (url.includes('/generate-key') && res.ok) {
        const clone = res.clone();
        const data = await clone.json().catch(()=>null);
        if (data && data.isValid) {
          const stored = JSON.parse(localStorage.getItem('admin_keys') || '[]');
          stored.unshift({ name: (new URL(url).searchParams.get('name')||''), contact: (new URL(url).searchParams.get('contact')||''), plan: (new URL(url).searchParams.get('plan')||''), expiry: data.expiryDate, licenseKey: data.licenseKey });
          if (stored.length>500) stored.length = 500;
          localStorage.setItem('admin_keys', JSON.stringify(stored));
        }
      }
    } catch(e){}
    return res;
  };
})();

filterInput.addEventListener('input', ()=> refreshKeys());
window.addEventListener('DOMContentLoaded', ()=> refreshKeys());