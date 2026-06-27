/* ==========================================================================
   PARKEXPERT INTERACTION SYSTEM
   Author: Antigravity AI
   ========================================================================== */

const STORAGE_KEY = 'parkexpert_applications';
const ADMIN_USERS_KEY = 'parkexpert_admin_users';
let currentAdminUser = 'superadmin';

// OCR Integration States
let ocrCache = {};
let currentRotation = {};

// Safe JWT decode on client side
function decodeJWT(base64) {
  try {
    const binString = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(binString.length);
    for (let i = 0; i < binString.length; i++) {
      bytes[i] = binString.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch (e) {
    return "";
  }
}

// Session expiration helper
function isTokenExpired(token) {
  if (!token) return true;
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return true;
    const decoded = decodeJWT(parts[0]);
    if (!decoded) return true;
    const payload = JSON.parse(decoded);
    if (payload.exp && payload.exp < Date.now()) {
      return true;
    }
    return false;
  } catch (e) {
    return true;
  }
}

// Global fetch interceptor for session management
const originalFetch = window.fetch;
window.fetch = async function(...args) {
  const response = await originalFetch(...args);
  if (response.status === 401 || response.status === 403) {
    const url = args[0];
    const urlString = typeof url === 'string' ? url : (url instanceof Request ? url.url : '');
    const isLoginEndpoint = urlString.includes('/api/login') || urlString.includes('/api/verify_otp') || urlString.includes('/api/send_otp_channel');
    
    if (!isLoginEndpoint && urlString.includes('/api/')) {
      const adminLayout = document.querySelector('.admin-layout');
      const overlay = document.getElementById('modal-login-overlay');
      
      if (adminLayout) adminLayout.style.display = 'none';
      if (overlay) overlay.style.display = 'flex';
      
      if (!window.isSessionAlerting) {
        window.isSessionAlerting = true;
        alert("Oturumunuz sonlandırıldı veya geçersiz. Lütfen tekrar giriş yapın.");
        // Clear session and reload
        localStorage.removeItem('parkexpert_token');
        localStorage.removeItem('parkexpert_user');
        localStorage.removeItem('parkexpert_current_admin');
        location.reload();
      }
    }
  }
  return response;
};

// Session countdown timer implementation
function startSessionCountdown() {
  const token = localStorage.getItem('parkexpert_token');
  if (!token) return;

  try {
    const parts = token.split('.');
    if (parts.length !== 2) return;
    const decoded = decodeJWT(parts[0]);
    if (!decoded) return;
    const payload = JSON.parse(decoded);
    if (!payload.exp) return;

    const timerSpan = document.getElementById('session-countdown-timer');
    const container = document.getElementById('session-countdown-container');
    if (!timerSpan || !container) return;

    // Clear any existing countdown
    if (window.sessionCountdownInterval) {
      clearInterval(window.sessionCountdownInterval);
    }

    function update() {
      const now = Date.now();
      const diff = payload.exp - now;
      if (diff <= 0) {
        timerSpan.textContent = '00:00:00';
        clearInterval(window.sessionCountdownInterval);
        if (!window.isSessionAlerting) {
          window.isSessionAlerting = true;
          alert("Oturumunuz sonlandırıldı veya geçersiz. Lütfen tekrar giriş yapın.");
          handleAdminLogout();
        }
        return;
      }

      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);

      const format = (num) => String(num).padStart(2, '0');
      timerSpan.textContent = `${format(hours)}:${format(minutes)}:${format(seconds)}`;

      if (diff < 15 * 60 * 1000) {
        // Less than 15 minutes: flashing red
        timerSpan.style.color = '#ef4444';
        timerSpan.style.animation = 'shakeBadge 0.5s infinite';
      } else if (diff < 60 * 60 * 1000) {
        // Less than 1 hour: orange
        timerSpan.style.color = '#f59e0b';
        timerSpan.style.animation = '';
      } else {
        // Safe: primary color
        timerSpan.style.color = 'var(--color-primary)';
        timerSpan.style.animation = '';
      }
    }

    update();
    window.sessionCountdownInterval = setInterval(update, 1000);

  } catch (e) {
    console.error("Countdown init failed:", e);
  }
}

let inactivityTimeout;

function resetInactivityTimer() {
  clearTimeout(inactivityTimeout);
  
  // 15 minutes = 15 * 60 * 1000 ms = 900000 ms
  inactivityTimeout = setTimeout(async () => {
    console.log("[Inactivity] User has been inactive for 15 minutes. Logging out...");
    alert("Uzun süre işlem yapmadığınız için oturumunuz güvenlik nedeniyle sonlandırılmıştır.");
    await handleAdminLogout('inactivity');
  }, 15 * 60 * 1000);
}

function initInactivityTimer() {
  const token = localStorage.getItem('parkexpert_token');
  if (!token) return;

  clearTimeout(inactivityTimeout);

  const events = ['mousemove', 'mousedown', 'keypress', 'scroll', 'touchstart'];
  events.forEach(eventName => {
    document.addEventListener(eventName, resetInactivityTimer, { passive: true });
  });

  resetInactivityTimer();
}

document.addEventListener('DOMContentLoaded', () => {
  // Initialize Lucide Icons
  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }

  // Automatically clear old mock data once to update to a fresh clean empty state
  if (!localStorage.getItem('parkexpert_fresh_empty_v3')) {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.setItem('parkexpert_fresh_empty_v3', 'true');
  }

  // Initialize Global Navigation & Common Utilities
  initGlobalNav();

  // Initialize LocalStorage Mock Data
  initMockData();

  // Populate active locations marquee ticker from DB
  populateTickerLocations();

  // Route page-specific controllers
  const formElement = document.getElementById('subscription-apply-form');
  const adminTable = document.getElementById('admin-table');

  if (formElement) {
    initWizardController();
  } else if (adminTable) {
    initAdminController();
  }

  // Initialize Hero Live Ticker Simulation if elements are present
  initHeroLiveSimulation();
});

/* ==========================================================================
   GLOBAL COMMON FUNCTIONS & NAV LOGIC
   ========================================================================== */

function initGlobalNav() {
  const toggleBtn = document.getElementById('mobile-nav-toggle');
  const navMenu = document.getElementById('nav-menu');

  if (toggleBtn && navMenu) {
    toggleBtn.addEventListener('click', () => {
      const isExpanded = toggleBtn.getAttribute('aria-expanded') === 'true';
      toggleBtn.setAttribute('aria-expanded', !isExpanded);
      navMenu.classList.toggle('active');
    });
  }
}

function initHeroLiveSimulation() {
  const plateEl = document.getElementById('live-sim-plate');
  const statusEl = document.getElementById('live-sim-status');
  
  if (!plateEl || !statusEl) return;

  const plates = ["34 PE 2026", "34 CAN 88", "34 EXP 99", "34 AVM 34", "34 PLK 88"];
  const states = [
    { 
      text: "OKUNUYOR", 
      bg: "rgba(255, 208, 0, 0.15)", 
      color: "#ff9f00", 
      iconSvg: `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#ff9f00" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block; vertical-align:middle; margin-right: 2px;"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/></svg>`
    },
    { 
      text: "EŞLEŞTİ", 
      bg: "rgba(15, 59, 162, 0.12)", 
      color: "#0f3ba2", 
      iconSvg: `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#0f3ba2" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block; vertical-align:middle; margin-right: 2px;"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m16 11 2 2 4-4"/></svg>`
    },
    { 
      text: "GEÇİŞ AKTİF", 
      bg: "rgba(37, 211, 102, 0.15)", 
      color: "#25d366", 
      iconSvg: `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#25d366" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block; vertical-align:middle; margin-right: 2px;"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`
    }
  ];

  let plateIndex = 0;
  let stateIndex = 2; // Start with unlock active

  setInterval(() => {
    stateIndex = (stateIndex + 1) % states.length;
    
    if (stateIndex === 0) {
      plateIndex = (plateIndex + 1) % plates.length;
      plateEl.textContent = plates[plateIndex];
    }

    const currentState = states[stateIndex];
    statusEl.style.backgroundColor = currentState.bg;
    statusEl.style.color = currentState.color;
    
    statusEl.innerHTML = `${currentState.iconSvg}<span style="vertical-align:middle;">${currentState.text}</span>`;
  }, 2200);
}

function populateTickerLocations() {
  const spans = document.querySelectorAll('.ticker-span');
  if (spans.length === 0) return;

  const OTOPARKS_KEY = 'parkexpert_otoparks';
  const otoparks = JSON.parse(localStorage.getItem(OTOPARKS_KEY)) || [];

  if (otoparks.length === 0) {
    spans.forEach(span => {
      span.textContent = "🔥 DİJİTAL OTOPARK VE ABONELİK SİSTEMİ AKTİF";
    });
    return;
  }

  const locationNames = otoparks.map(p => p.name.toLocaleUpperCase('tr-TR'));
  const tickerText = `🔥 AKTİF DİJİTAL LOKASYONLARIMIZ: ${locationNames.join(' • ')}`;

  spans.forEach(span => {
    span.textContent = tickerText;
  });
}

  // Secret Admin Portal Shortcut: Smart single-click vs double-click handler
  const logo = document.getElementById('nav-logo');
  if (logo) {
    let clickTimeout;
    logo.addEventListener('click', (e) => {
      e.preventDefault(); // Stop immediate href redirect on first click
      console.log(`[Logo Click] detail (count): ${e.detail}`);

      // 1. Modifier keys shortcut (Alt + Click or Ctrl + Shift + Click)
      if (e.altKey || (e.ctrlKey && e.shiftKey)) {
        console.log('[Logo Click] Modifier key shortcut detected. Redirecting to admin...');
        clearTimeout(clickTimeout);
        window.location.href = 'admin.html';
        return;
      }

      // 2. Double-click check (using e.detail which is the click count)
      if (e.detail === 2) {
        console.log('[Logo Click] Double-click detected! Redirecting to admin...');
        clearTimeout(clickTimeout);
        window.location.href = 'admin.html';
      } else if (e.detail === 1) {
        // First click: wait briefly to see if a second click follows
        clickTimeout = setTimeout(() => {
          console.log('[Logo Click] Single-click threshold passed. Going to homepage...');
          window.location.href = 'index.html';
        }, 350); // 350ms is standard double-click threshold
      }
    });
  }

// Global modal helpers
function openModal(id, event) {
  if (event) event.preventDefault();
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.add('active');
    document.body.style.overflow = 'hidden'; // Stop body scrolling
    
    // Setup and trigger scroll check on open dynamically
    setTimeout(() => {
      if (id === 'modal-kvkk') {
        checkScrollRequirement('modal-body-kvkk', 'btn-approve-kvkk', 'scroll-indicator-kvkk');
      } else if (id === 'modal-terms') {
        checkScrollRequirement('modal-body-terms', 'btn-approve-terms', 'scroll-indicator-terms');
      } else if (id === 'modal-consent') {
        checkScrollRequirement('modal-body-consent', 'btn-approve-consent', 'scroll-indicator-consent');
      }
    }, 150);
  }
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.remove('active');
    document.body.style.overflow = ''; // Restore scrolling
  }
}

function closeModalOnOverlay(event) {
  if (event.target.classList.contains('modal-overlay')) {
    event.target.classList.remove('active');
    document.body.style.overflow = '';
  }
}

function clearAndResetData(event) {
  if (event) event.preventDefault();
  
  if (currentAdminUser !== 'superadmin') {
    alert("Bu işlem için Süper Yönetici yetkiniz bulunmalıdır.");
    return;
  }
  
  if (confirm("Yönetici panelindeki tüm abonelik başvurularını silmek ve sistemi sıfırlamak istediğinize emin misiniz?\n\nBu işlem geri alınamaz!")) {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.setItem(STORAGE_KEY, JSON.stringify([]));
    
    alert("Yönetici paneli verileri başarıyla temizlendi. Sayfa yenileniyor...");
    location.reload();
  }
}

/* ==========================================================================
   LOCALSTORAGE INITIALIZATION & MOCK DATA
   ========================================================================== */


function initMockData() {
  const existingData = localStorage.getItem(STORAGE_KEY);
  if (!existingData) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([]));
  }

  const OTOPARKS_KEY = 'parkexpert_otoparks';
  const existingOtoparks = localStorage.getItem(OTOPARKS_KEY);
  if (!existingOtoparks) {
    const defaultOtoparks = [
      {
        id: "birlik-sanayi",
        name: "Birlik Sanayi Sitesi - Beylikdüzü",
        category: "OSB / Sanayi Sitesi Otoparkları",
        companyTitle: "BİRLİK SANAYİ SİTESİ KOOPERATİFİ YÖNETİMİ",
        taxOffice: "Beylikdüzü",
        taxNumber: "2910398492",
        bankName: "Vakıfbank",
        iban: "TR23 0001 5001 5800 7302 9104 88",
        priceEmployee: "1200 TL",
        priceExternal: "2400 TL",
        supportPhone: "0212 875 34 56"
      },
      {
        id: "dersankoop",
        name: "Dersankoop & Trios 2023 – İkitelli OSB",
        category: "OSB / Sanayi Sitesi Otoparkları",
        companyTitle: "DERSANKOOP İKİTELLİ ORGANİZE SANAYİ YÖNETİMİ",
        taxOffice: "İkitelli",
        taxNumber: "8820194852",
        bankName: "Halkbank",
        iban: "TR45 0001 2009 4500 1200 9988 77",
        priceEmployee: "1500 TL",
        priceExternal: "3000 TL",
        supportPhone: "0212 549 12 34"
      },
      {
        id: "aymakoop",
        name: "Aymakoop – İkitelli OSB",
        category: "OSB / Sanayi Sitesi Otoparkları",
        companyTitle: "AYMAKOOP SİTE İŞLETMECİLİĞİ KOOPERATİFİ",
        taxOffice: "İkitelli",
        taxNumber: "1290382942",
        bankName: "Ziraat Bankası",
        iban: "TR88 0001 0000 4567 8901 2345 67",
        priceEmployee: "1400 TL",
        priceExternal: "2800 TL",
        supportPhone: "0212 549 56 78"
      },
      {
        id: "aykosan",
        name: "Aykosan – İkitelli OSB",
        category: "OSB / Sanayi Sitesi Otoparkları",
        companyTitle: "AYKOSAN SANAYİ SİTESİ KOOPERATİFİ",
        taxOffice: "İkitelli",
        taxNumber: "3892019283",
        bankName: "İş Bankası",
        iban: "TR12 0006 2000 7890 1234 5678 90",
        priceEmployee: "1300 TL",
        priceExternal: "2600 TL",
        supportPhone: "0212 549 90 12"
      },
      {
        id: "tumsan-2",
        name: "Tümsan 2– İkitelli OSB",
        category: "OSB / Sanayi Sitesi Otoparkları",
        companyTitle: "TÜMSAN 2 SANAYİ SİTESİ KOOPERATİFİ",
        taxOffice: "İkitelli",
        taxNumber: "9102839281",
        bankName: "Yapı Kredi",
        iban: "TR56 0003 2000 9012 3456 7890 12",
        priceEmployee: "1400 TL",
        priceExternal: "2800 TL",
        supportPhone: "0212 549 34 56"
      },
      {
        id: "tumsan-1",
        name: "Tümsan 1 – İkitelli OSB",
        category: "OSB / Sanayi Sitesi Otoparkları",
        companyTitle: "TÜMSAN 1 SANAYİ SİTESİ KOOPERATİFİ",
        taxOffice: "İkitelli",
        taxNumber: "8293029103",
        bankName: "Garanti BBVA",
        iban: "TR34 0006 2000 1234 5678 9012 34",
        priceEmployee: "1400 TL",
        priceExternal: "2800 TL",
        supportPhone: "0212 549 78 90"
      },
      {
        id: "matbaacilar",
        name: "Matbaacılar Sitesi – Bağcılar OSB",
        category: "OSB / Sanayi Sitesi Otoparkları",
        companyTitle: "MATBAACILAR SİTESİ KOOPERATİFİ",
        taxOffice: "Güneşli",
        taxNumber: "7293829102",
        bankName: "Akbank",
        iban: "TR76 0004 6000 5678 9012 3456 78",
        priceEmployee: "1600 TL",
        priceExternal: "3200 TL",
        supportPhone: "0212 629 12 34"
      },
      {
        id: "samsun-piazza",
        name: "Samsun Piazza - Samsun",
        category: "AVM Otoparkları",
        companyTitle: "RÖNESANS GAYRİMENKUL YATIRIM A.Ş.",
        taxOffice: "Samsun",
        taxNumber: "7382019482",
        bankName: "QNB Finansbank",
        iban: "TR65 0011 1000 1234 5678 9012 34",
        priceEmployee: "2000 TL",
        priceExternal: "4000 TL",
        supportPhone: "0362 290 10 10"
      },
      {
        id: "maltepe-piazza",
        name: "Maltepe Piazza - Maltepe",
        category: "AVM Otoparkları",
        companyTitle: "RÖNESANS GAYRİMENKUL YATIRIM A.Ş.",
        taxOffice: "Maltepe",
        taxNumber: "7382019483",
        bankName: "Garanti BBVA",
        iban: "TR92 0006 2000 9876 5432 1098 76",
        priceEmployee: "2500 TL",
        priceExternal: "5000 TL",
        supportPhone: "0216 500 20 20"
      },
      {
        id: "maltepe-park",
        name: "Maltepe Park – Maltepe",
        category: "AVM Otoparkları",
        companyTitle: "PUSULA AKILLI ŞEHİRCİLİK VE BİLGİ TEKNOLOJİLERİ A.Ş.",
        taxOffice: "ALEMDAĞ VERGİ DAİRESİ",
        taxNumber: "7330907326",
        bankName: "Albaraka Türk",
        iban: "TR11 0020 3000 0876 9030 0000 13",
        priceEmployee: "1875 TL",
        priceExternal: "3750 TL",
        supportPhone: "0501 618 34 82"
      },
      {
        id: "vadi-istanbul",
        name: "Vadi İstanbul – Sarıyer",
        category: "AVM Otoparkları",
        companyTitle: "ARTAŞ İNŞAAT VE SANAYİ A.Ş.",
        taxOffice: "Sarıyer",
        taxNumber: "1283928103",
        bankName: "Denizbank",
        iban: "TR48 0013 4000 8765 4321 0987 65",
        priceEmployee: "3000 TL",
        priceExternal: "6000 TL",
        supportPhone: "0212 330 30 30"
      },
      {
        id: "kirklar-acik",
        name: "Kırklar Açık – Libadiye",
        category: "Açık Otoparklar / Bağımsız Otoparklar",
        companyTitle: "KIRKLAR OTOPARK İŞLETMELERİ LTD. ŞTİ.",
        taxOffice: "Üsküdar",
        taxNumber: "9283920194",
        bankName: "TEB",
        iban: "TR79 0003 2000 1234 5678 9012 34",
        priceEmployee: "1000 TL",
        priceExternal: "2000 TL",
        supportPhone: "0216 320 40 40"
      }
    ];
    localStorage.setItem(OTOPARKS_KEY, JSON.stringify(defaultOtoparks));
  }
}

/* ==========================================================================
   WIZARD FORM CONTROLLER (basvuru.html)
   ========================================================================== */

let currentStep = 1;
let selectedType = 'bireysel';
let uploadedFiles = {
  ruhsat: null,
  kimlik: null,
  vergi: null,
  sirkuler: null,
  dekont: null,
  calisma: null
};

async function populateOtoparkSelection() {
  const otoparkSelect = document.getElementById('otopark-selection');
  if (!otoparkSelect) return;

  const OTOPARKS_KEY = 'parkexpert_otoparks';
  let otoparks = [];
  try {
    const res = await fetch('/api/otoparks');
    if (res.ok) {
      otoparks = await res.json();
      // Map is_active to isActive for client compatibility
      otoparks.forEach(p => {
        if (p.is_active !== undefined) {
          p.isActive = p.is_active;
        }
        if (p.company_title !== undefined) {
          p.companyTitle = p.company_title;
        }
        if (p.tax_office !== undefined) {
          p.taxOffice = p.tax_office;
        }
        if (p.tax_number !== undefined) {
          p.taxNumber = p.tax_number;
        }
        if (p.bank_name !== undefined) {
          p.bankName = p.bank_name;
        }
        if (p.price_employee !== undefined) {
          p.priceEmployee = p.price_employee;
        }
        if (p.price_external !== undefined) {
          p.priceExternal = p.price_external;
        }
        if (p.support_phone !== undefined) {
          p.supportPhone = p.support_phone;
        }
      });
      localStorage.setItem(OTOPARKS_KEY, JSON.stringify(otoparks));
    } else {
      throw new Error("API failed");
    }
  } catch (err) {
    console.error("Failed to load otoparks, falling back to cache:", err);
    otoparks = JSON.parse(localStorage.getItem(OTOPARKS_KEY)) || [];
  }

  // Sort: active (isActive !== false) first, then alphabetically by name
  otoparks.sort((a, b) => {
    const aActive = a.isActive !== false;
    const bActive = b.isActive !== false;
    if (aActive && !bActive) return -1;
    if (!aActive && bActive) return 1;
    return a.name.localeCompare(b.name, 'tr-TR');
  });

  // 1. Populate native hidden select (helps keep validation & submit working)
  const firstOption = otoparkSelect.options[0];
  otoparkSelect.innerHTML = '';
  if (firstOption) {
    otoparkSelect.appendChild(firstOption);
  } else {
    const opt = document.createElement('option');
    opt.value = '';
    opt.disabled = true;
    opt.selected = true;
    opt.textContent = 'Lütfen bir otopark seçin...';
    otoparkSelect.appendChild(opt);
  }

  // Group otoparks by category
  const grouped = {};
  otoparks.forEach(park => {
    if (!grouped[park.category]) {
      grouped[park.category] = [];
    }
    grouped[park.category].push(park);
  });

  // Render grouped options in native select
  for (const [category, list] of Object.entries(grouped)) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = category;
    
    list.forEach(park => {
      const option = document.createElement('option');
      option.value = park.name;
      const isActive = park.isActive !== false;
      if (!isActive) {
        option.disabled = true;
        option.textContent = `${park.name} (ABONELİĞE GEÇİCİ OLARAK KAPALI)`;
      } else {
        option.textContent = park.name;
      }
      optgroup.appendChild(option);
    });

    otoparkSelect.appendChild(optgroup);
  }

  // 2. Populate custom dropdown UI
  const customOptionsList = document.getElementById('custom-otopark-select-options');
  const customTrigger = document.getElementById('custom-otopark-select-trigger');
  const customContainer = document.getElementById('custom-otopark-select-container');
  const customSearchInput = document.getElementById('custom-otopark-select-search');

  if (!customOptionsList || !customTrigger || !customContainer) return;

  customOptionsList.innerHTML = '';

  // Render grouped options in custom UI
  for (const [category, list] of Object.entries(grouped)) {
    // Group Header
    const groupHeaderEl = document.createElement('div');
    groupHeaderEl.className = 'custom-select-group-header';
    groupHeaderEl.textContent = category;
    customOptionsList.appendChild(groupHeaderEl);

    list.forEach(park => {
      const isActive = park.isActive !== false;
      
      const optionEl = document.createElement('div');
      optionEl.className = `custom-select-option${isActive ? '' : ' disabled'}`;
      optionEl.setAttribute('role', 'option');
      optionEl.setAttribute('data-value', park.name);
      
      let badgeHTML = '';
      if (!isActive) {
        badgeHTML = `<span class="custom-select-option-badge custom-select-option-badge--inactive"><i data-lucide="lock" style="width: 10px; height: 10px; display: inline; vertical-align: middle; margin-right: 0.15rem;"></i> Aboneliğe Kapalı</span>`;
      } else {
        badgeHTML = `<span class="custom-select-option-badge custom-select-option-badge--active">Aboneliğe Açık</span>`;
      }

      optionEl.innerHTML = `
        <div class="custom-select-option-info">
          <span class="custom-select-option-name">${park.name}</span>
          ${badgeHTML}
        </div>
      `;

      // Select event (only for active ones)
      if (isActive) {
        optionEl.addEventListener('click', () => {
          // Update native select
          otoparkSelect.value = park.name;
          
          // Trigger change event to run validation / payment info updates
          const event = new Event('change', { bubbles: true });
          otoparkSelect.dispatchEvent(event);

          // Update trigger label
          const triggerText = customTrigger.querySelector('.custom-select-trigger-text');
          if (triggerText) triggerText.textContent = park.name;

          // Toggle selection styling
          customOptionsList.querySelectorAll('.custom-select-option').forEach(el => el.classList.remove('selected'));
          optionEl.classList.add('selected');

          // Close panel
          customContainer.classList.remove('open');
          customTrigger.setAttribute('aria-expanded', 'false');
          
          // Clear invalid border if any
          customTrigger.classList.remove('is-invalid');
        });
      }

      customOptionsList.appendChild(optionEl);
    });
  }

  // Create Lucide Icons for badges if necessary
  if (typeof lucide !== 'undefined') lucide.createIcons();

  // 3. Setup Dropdown trigger click handler
  const handleTriggerClick = (e) => {
    e.stopPropagation();
    const isOpen = customContainer.classList.contains('open');
    
    // Close other custom dropdowns (if any)
    document.querySelectorAll('.custom-select-container').forEach(el => el.classList.remove('open'));
    
    if (!isOpen) {
      customContainer.classList.add('open');
      customTrigger.setAttribute('aria-expanded', 'true');
      if (customSearchInput) {
        customSearchInput.value = '';
        // Filter options to reset search
        filterCustomOptions('');
        setTimeout(() => customSearchInput.focus(), 50);
      }
    } else {
      customContainer.classList.remove('open');
      customTrigger.setAttribute('aria-expanded', 'false');
    }
  };

  customTrigger.removeEventListener('click', customTrigger._clickHandler);
  customTrigger._clickHandler = handleTriggerClick;
  customTrigger.addEventListener('click', handleTriggerClick);

  // 4. Click outside handler to close dropdown
  const handleOutsideClick = (e) => {
    if (!customContainer.contains(e.target)) {
      customContainer.classList.remove('open');
      customTrigger.setAttribute('aria-expanded', 'false');
    }
  };
  document.removeEventListener('click', document._outsideSelectHandler);
  document._outsideSelectHandler = handleOutsideClick;
  document.addEventListener('click', handleOutsideClick);

  // 5. Setup Live Filter Search logic
  function filterCustomOptions(query) {
    const cleanQuery = query.toLocaleUpperCase('tr-TR').trim();
    let currentHeader = null;
    let visibleInGroup = 0;

    const children = Array.from(customOptionsList.children);
    
    children.forEach(child => {
      if (child.classList.contains('custom-select-group-header')) {
        // Handle header visibility dynamically
        if (currentHeader && visibleInGroup === 0) {
          currentHeader.style.display = 'none';
        }
        currentHeader = child;
        currentHeader.style.display = 'block';
        visibleInGroup = 0;
      } else if (child.classList.contains('custom-select-option')) {
        const optionName = child.querySelector('.custom-select-option-name').textContent.toLocaleUpperCase('tr-TR');
        if (optionName.includes(cleanQuery)) {
          child.style.display = 'flex';
          visibleInGroup++;
        } else {
          child.style.display = 'none';
        }
      }
    });

    // Handle last group header visibility
    if (currentHeader && visibleInGroup === 0) {
      currentHeader.style.display = 'none';
    }
  }

  if (customSearchInput) {
    const handleSearchInput = (e) => {
      filterCustomOptions(e.target.value);
    };
    customSearchInput.removeEventListener('input', customSearchInput._inputHandler);
    customSearchInput._inputHandler = handleSearchInput;
    customSearchInput.addEventListener('input', handleSearchInput);
    
    // Prevent closing dropdown when clicking search input
    customSearchInput.addEventListener('click', (e) => e.stopPropagation());
  }

  // 6. Check URL query parameters for otopark pre-selection (e.g. ?otopark=birlik-sanayi)
  const urlParams = new URLSearchParams(window.location.search);
  const otoparkParam = urlParams.get('otopark');
  if (otoparkParam) {
    const matchedPark = otoparks.find(p => p.id === otoparkParam);
    if (matchedPark && (matchedPark.isActive !== false)) {
      const optionEl = customOptionsList.querySelector(`.custom-select-option[data-value="${matchedPark.name}"]`);
      if (optionEl) {
        optionEl.click();
      }
    }
  }
}

function initWizardController() {
  // Populate otopark dropdown dynamically
  populateOtoparkSelection();

  // Input formatting listeners
  const tcInput = document.getElementById('tc-identity');
  if (tcInput) {
    tcInput.addEventListener('input', (e) => {
      e.target.value = e.target.value.replace(/\D/g, ''); // Digits only
    });
  }

  const phoneInput = document.getElementById('phone-number');
  if (phoneInput) {
    phoneInput.addEventListener('input', (e) => {
      formatPhone(e.target);
    });
  }

  const plateInput = document.getElementById('license-plate');
  if (plateInput) {
    plateInput.addEventListener('input', (e) => {
      // Auto-capitalize, remove spaces, keep letters and digits only
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
  }

  const taxNoInput = document.getElementById('billing-tax-no');
  if (taxNoInput) {
    taxNoInput.addEventListener('input', (e) => {
      e.target.value = e.target.value.replace(/\D/g, ''); // Digits only
    });
  }

  const emailInput = document.getElementById('email-address');
  if (emailInput) {
    emailInput.addEventListener('input', (e) => {
      const start = e.target.selectionStart;
      const end = e.target.selectionEnd;
      e.target.value = e.target.value.toLowerCase().replace(/\s/g, '');
      e.target.setSelectionRange(start, end);
    });
  }

  // Setup Date picker default min as today
  const dateInput = document.getElementById('start-date');
  if (dateInput) {
    const today = new Date().toISOString().split('T')[0];
    dateInput.min = today;
    dateInput.value = today;
  }

  // Auto-uppercase all standard text inputs and textareas in Turkish as they type
  const uppercaseInputIds = [
    'company-name',
    'full-name',
    'car-model',
    'driver-name',
    'home-address',
    'application-notes',
    'billing-company',
    'billing-tax-office',
    'billing-address'
  ];

  uppercaseInputIds.forEach(id => {
    const input = document.getElementById(id);
    if (input) {
      input.addEventListener('input', (e) => {
        // Track selection cursor position to prevent jumping
        const start = e.target.selectionStart;
        const end = e.target.selectionEnd;
        
        // Convert to Turkish uppercase in real-time
        e.target.value = e.target.value.toLocaleUpperCase('tr-TR');
        
        // Restore cursor position
        e.target.setSelectionRange(start, end);
      });
    }
  });

  // Setup upload zones drag-drop listeners
  setupDragAndDropZones();

  // Setup premium KVKK scroll checks
  initPremiumKvkkController();

  // Handle corporate type billing initial labels sync
  handleBillingCorpTypeChange();

  // Setup step indicators click listeners
  setupStepIndicatorsClickListeners();
}

function setupStepIndicatorsClickListeners() {
  const indicators = document.querySelectorAll('.step-indicator');
  indicators.forEach(ind => {
    ind.addEventListener('click', () => {
      const targetStep = parseInt(ind.getAttribute('data-step'));
      // Only allow navigating back to previously completed steps
      if (targetStep < currentStep && currentStep < 5) {
        currentStep = targetStep;
        updateWizardUI();
      }
    });
  });
}

// ==========================================================================
// PREMIUM KVKK SCROLL-TO-READ & STATE CONTROLLER
// ==========================================================================
let docReadState = {
  kvkk: false,
  terms: false,
  consent: false
};

function initPremiumKvkkController() {
  // Attach scroll listeners
  setupModalScrollChecker('modal-body-kvkk', 'btn-approve-kvkk', 'scroll-indicator-kvkk');
  setupModalScrollChecker('modal-body-terms', 'btn-approve-terms', 'scroll-indicator-terms');
  setupModalScrollChecker('modal-body-consent', 'btn-approve-consent', 'scroll-indicator-consent');
}

function setupModalScrollChecker(bodyId, buttonId, indicatorId) {
  const body = document.getElementById(bodyId);
  if (!body) return;

  body.addEventListener('scroll', () => {
    // Check scroll height to see if user has reached bottom (with 40px buffer)
    const isAtBottom = body.scrollHeight - body.scrollTop <= body.clientHeight + 40;
    if (isAtBottom) {
      unlockButton(buttonId, indicatorId);
    }
  });
}

function checkScrollRequirement(bodyId, buttonId, indicatorId) {
  const body = document.getElementById(bodyId);
  if (!body) return;
  
  if (body.scrollHeight <= body.clientHeight + 5) {
    unlockButton(buttonId, indicatorId);
  }
}

function unlockButton(buttonId, indicatorId) {
  const btn = document.getElementById(buttonId);
  const indicator = document.getElementById(indicatorId);
  
  if (btn && btn.hasAttribute('disabled')) {
    btn.removeAttribute('disabled');
    btn.classList.remove('btn-approve-disabled');
    btn.style.cursor = 'pointer';
    
    if (indicator) {
      indicator.classList.add('scroll-completed');
      indicator.innerHTML = '<i data-lucide="check-circle" style="width: 14px; height: 14px; color: #22c55e;"></i> Okuma tamamlandı. Onaylayabilirsiniz.';
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  }
}

function approveDocument(type) {
  docReadState[type] = true;
  closeModal('modal-' + type);

  // Update document badge dynamically
  const badge = document.getElementById('doc-badge-' + type);
  const icon = document.getElementById('doc-icon-' + type);
  const statusLabel = document.getElementById('status-label-' + type);

  if (badge) {
    badge.classList.remove('unread');
    badge.classList.add('read');
    badge.style.borderColor = '#22c55e';
    badge.style.background = 'rgba(34, 197, 94, 0.02)';
  }

  if (icon) {
    icon.setAttribute('data-lucide', 'check-circle-2');
    icon.style.color = '#22c55e';
  }

  if (statusLabel) {
    statusLabel.innerHTML = '<i data-lucide="check-circle-2" style="width: 14px; height: 14px; color: #22c55e;"></i> Okundu';
    statusLabel.style.color = '#22c55e';
  }

  if (typeof lucide !== 'undefined') lucide.createIcons();

  // If both documents are read, unlock the checkbox
  if (docReadState.kvkk && docReadState.terms) {
    const chk = document.getElementById('chk-kvkk-terms');
    const label = document.querySelector('label[for="chk-kvkk-terms"]');
    const wrapper = chk ? chk.closest('.checklist-item-wrapper') : null;

    if (chk) {
      chk.removeAttribute('disabled');
      chk.style.cursor = 'pointer';
      // User must manually check the box per request!
    }

    if (label) {
      label.style.cursor = 'pointer';
    }

    if (wrapper) {
      wrapper.style.borderColor = '#22c55e';
      wrapper.style.background = 'rgba(34, 197, 94, 0.01)';
      // Trigger a satisfying subtle scale pulse animation to notify the user to click it
      wrapper.style.transform = 'scale(1.01)';
      setTimeout(() => {
        wrapper.style.transform = 'none';
      }, 300);
    }
  }

  // If consent document is read, unlock the marketing checkbox
  if (type === 'consent') {
    const chk = document.getElementById('chk-marketing');
    const label = document.querySelector('label[for="chk-marketing"]');
    const wrapper = chk ? chk.closest('.checklist-item-wrapper') : null;

    if (chk) {
      chk.removeAttribute('disabled');
      chk.style.cursor = 'pointer';
    }

    if (label) {
      label.style.cursor = 'pointer';
    }

    if (wrapper) {
      wrapper.style.borderColor = '#22c55e';
      wrapper.style.background = 'rgba(34, 197, 94, 0.01)';
      // Trigger a satisfying subtle scale pulse animation to notify the user to click it
      wrapper.style.transform = 'scale(1.01)';
      setTimeout(() => {
        wrapper.style.transform = 'none';
      }, 300);
    }
  }
}

function handleKvkkCheckboxClick(event) {
  // If not read yet, intercept and prevent check
  if (!docReadState.kvkk || !docReadState.terms) {
    event.preventDefault();
    if (event.target) event.target.checked = false;

    // Shake the badges to draw attention
    const badges = ['doc-badge-kvkk', 'doc-badge-terms'];
    badges.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.classList.add('shake-badge');
        // Red glow warning flash
        el.style.boxShadow = '0 0 12px rgba(239, 68, 68, 0.25)';
        setTimeout(() => {
          el.classList.remove('shake-badge');
          el.style.boxShadow = '';
        }, 600);
      }
    });

    // Show a beautiful float toast notifying the user
    showToastNotification('Yasal Uyarı', 'Devam etmek için her iki yasal metni de açarak sonuna kadar okumanız gerekmektedir.', 'shield-alert');
  }
}

function handleMarketingCheckboxClick(event) {
  if (!docReadState.consent) {
    event.preventDefault();
    if (event.target) event.target.checked = false;

    // Shake the badge to draw attention
    const el = document.getElementById('doc-badge-consent');
    if (el) {
      el.classList.add('shake-badge');
      el.style.boxShadow = '0 0 12px rgba(239, 68, 68, 0.25)';
      setTimeout(() => {
        el.classList.remove('shake-badge');
        el.style.boxShadow = '';
      }, 600);
    }

    // Show a beautiful float toast notifying the user
    showToastNotification('Okuma Gerekli', 'Ticari Elektronik İleti iznini onaylayabilmek için öncelikle ilgili Aydınlatma Metnini açarak sonuna kadar okumanız gerekmektedir.', 'mail');
  }
}

function showToastNotification(title, message, iconName) {
  const toast = document.getElementById('email-toast');
  const toastTitle = document.getElementById('toast-title');
  const toastMsg = document.getElementById('toast-message');
  const toastIcon = toast ? toast.querySelector('.toast-icon') : null;

  if (toast && toastTitle && toastMsg) {
    toastTitle.textContent = title;
    toastMsg.textContent = message;
    
    if (toastIcon && iconName) {
      toastIcon.innerHTML = `<i data-lucide="${iconName}" style="width: 22px; height: 22px; color: #ef4444;"></i>`;
    }
    
    toast.classList.add('active');
    
    // Clear auto-hide timers if any, then hide in 4 seconds
    if (window.toastHideTimer) clearTimeout(window.toastHideTimer);
    window.toastHideTimer = setTimeout(() => {
      toast.classList.remove('active');
    }, 4000);
  }
}

function formatPhone(input) {
  let val = input.value.replace(/\D/g, ''); // Digits only
  if (val.startsWith('0')) {
    val = val.substring(1); // Remove leading 0 for parsing format
  }
  
  let formatted = '';
  if (val.length > 0) {
    formatted += '0 (' + val.substring(0, 3);
  }
  if (val.length >= 4) {
    formatted += ') ' + val.substring(3, 6);
  }
  if (val.length >= 7) {
    formatted += ' ' + val.substring(6, 8);
  }
  if (val.length >= 9) {
    formatted += ' ' + val.substring(8, 10);
  }
  
  input.value = val.length === 0 ? '' : formatted;
}

// setSubscriptionType removed as wizard step 1 choices are now unified

function hasCustomBilling() {
  const radioSermaye = document.getElementById('billing-corp-type-sermaye');
  const radioSahis = document.getElementById('billing-corp-type-sahis');
  const isSermaye = radioSermaye ? radioSermaye.checked : false;
  const isSahis = radioSahis ? radioSahis.checked : false;

  if (isSermaye || isSahis) {
    return true;
  }
  
  // If it's bireysel, it's custom ONLY IF they UNCHECKED "use personal info"
  const usePersonalInfo = document.getElementById('use-personal-info');
  return usePersonalInfo ? !usePersonalInfo.checked : false;
}

function toggleUsePersonalInfo() {
  const radioBireysel = document.getElementById('billing-corp-type-bireysel');
  if (!radioBireysel || !radioBireysel.checked) return;

  const chkUsePersonal = document.getElementById('use-personal-info');
  const bCompanyGroup = document.getElementById('group-billing-company');
  const bTaxNoGroup = document.getElementById('group-billing-tax-no');
  const bAddressGroup = document.getElementById('group-billing-address');
  
  const compInput = document.getElementById('billing-company');
  const taxNoInput = document.getElementById('billing-tax-no');
  const addrInput = document.getElementById('billing-address');
  
  const shouldHide = chkUsePersonal ? chkUsePersonal.checked : false;
  
  const displayStyle = shouldHide ? 'none' : 'block';
  if (bCompanyGroup) bCompanyGroup.style.display = displayStyle;
  if (bTaxNoGroup) bTaxNoGroup.style.display = displayStyle;
  if (bAddressGroup) bAddressGroup.style.display = displayStyle;
  
  if (compInput) compInput.required = !shouldHide;
  if (taxNoInput) taxNoInput.required = !shouldHide;
  if (addrInput) addrInput.required = !shouldHide;
  
  if (shouldHide) {
    if (compInput) compInput.value = '';
    if (taxNoInput) taxNoInput.value = '';
    if (addrInput) addrInput.value = '';
    
    // Hide error messages
    const errs = ['error-billing-company', 'error-billing-tax-no', 'error-billing-address'];
    errs.forEach(errId => {
      const errEl = document.getElementById(errId);
      if (errEl) errEl.style.display = 'none';
    });
  }
}

function handleBillingCorpTypeChange() {
  const radioSahis = document.getElementById('billing-corp-type-sahis');
  const radioBireysel = document.getElementById('billing-corp-type-bireysel');
  
  const isSahis = radioSahis ? radioSahis.checked : false;
  const isBireysel = radioBireysel ? radioBireysel.checked : false;

  const lblCompany = document.getElementById('lbl-billing-company');
  const compInput = document.getElementById('billing-company');
  const lblTaxNo = document.getElementById('lbl-billing-tax-no');
  const taxNoInput = document.getElementById('billing-tax-no');
  const errorTaxNo = document.getElementById('error-billing-tax-no');
  const taxOfficeGroup = document.getElementById('group-billing-tax-office');
  const taxOfficeInput = document.getElementById('billing-tax-office');
  const usePersonalInfoWrapper = document.getElementById('use-personal-info-wrapper');

  if (isBireysel) {
    // Show use-personal-info checkbox for standard individuals
    if (usePersonalInfoWrapper) usePersonalInfoWrapper.style.display = 'block';

    if (lblCompany) lblCompany.textContent = 'Ad Soyad (Fatura Sahibi)';
    if (compInput) compInput.placeholder = 'Örn: Ahmet Yılmaz';
    if (lblTaxNo) lblTaxNo.textContent = 'T.C. Kimlik Numarası';
    if (taxNoInput) {
      taxNoInput.placeholder = '11 haneli T.C. Kimlik No';
      taxNoInput.maxLength = 11;
    }
    if (errorTaxNo) errorTaxNo.innerHTML = '<i data-lucide="alert-circle" style="width: 14px; height: 14px;"></i> Lütfen 11 haneli T.C. kimlik numarasını girin.';
    
    // Hide and disable Vergi Dairesi for standard individuals
    if (taxOfficeGroup) taxOfficeGroup.style.display = 'none';
    if (taxOfficeInput) {
      taxOfficeInput.required = false;
      taxOfficeInput.value = '';
    }

    // Toggle fields based on personal info reuse state
    toggleUsePersonalInfo();
  } else {
    // Hide use-personal-info checkbox for corporate types
    if (usePersonalInfoWrapper) usePersonalInfoWrapper.style.display = 'none';

    // Corporate fields must always be shown and required
    const bCompanyGroup = document.getElementById('group-billing-company');
    const bTaxNoGroup = document.getElementById('group-billing-tax-no');
    const bAddressGroup = document.getElementById('group-billing-address');
    
    if (bCompanyGroup) bCompanyGroup.style.display = 'block';
    if (bTaxNoGroup) bTaxNoGroup.style.display = 'block';
    if (bAddressGroup) bAddressGroup.style.display = 'block';
    
    if (compInput) compInput.required = true;
    if (taxNoInput) taxNoInput.required = true;
    const addrInput = document.getElementById('billing-address');
    if (addrInput) addrInput.required = true;

    if (isSahis) {
      if (lblCompany) lblCompany.textContent = 'Firma Sahibi (Ad Soyad - Ticari Ünvan)';
      if (compInput) compInput.placeholder = 'Örn: Ahmet Yılmaz veya Ahmet Yılmaz - Yılmaz Ticaret';
      if (lblTaxNo) lblTaxNo.textContent = 'T.C. Kimlik Numarası (Vergi Numarası)';
      if (taxNoInput) {
        taxNoInput.placeholder = '11 haneli T.C. Kimlik No';
        taxNoInput.maxLength = 11;
      }
      if (errorTaxNo) errorTaxNo.innerHTML = '<i data-lucide="alert-circle" style="width: 14px; height: 14px;"></i> Lütfen 11 haneli T.C. kimlik numarasını girin.';
      
      // Show and enable Vergi Dairesi
      if (taxOfficeGroup) taxOfficeGroup.style.display = 'block';
      if (taxOfficeInput) taxOfficeInput.required = true;
    } else { // Standard corporate LTD/A.Ş.
      if (lblCompany) lblCompany.textContent = 'Firma Unvanı (Şirket Tam Adı)';
      if (compInput) compInput.placeholder = 'Örn: ABC Tekstil Sanayi ve Ticaret A.Ş.';
      if (lblTaxNo) lblTaxNo.textContent = 'Vergi Numarası';
      if (taxNoInput) {
        taxNoInput.placeholder = '10 haneli Vergi No';
        taxNoInput.maxLength = 10;
        if (taxNoInput.value.length > 10) {
          taxNoInput.value = taxNoInput.value.substring(0, 10);
        }
      }
      if (errorTaxNo) errorTaxNo.innerHTML = '<i data-lucide="alert-circle" style="width: 14px; height: 14px;"></i> Lütfen 10 haneli vergi numarasını girin.';
      
      // Show and enable Vergi Dairesi
      if (taxOfficeGroup) taxOfficeGroup.style.display = 'block';
      if (taxOfficeInput) taxOfficeInput.required = true;
    }
  }

  // Ensure digits format logic is attached
  if (taxNoInput) {
    taxNoInput.value = taxNoInput.value.replace(/\D/g, '');
  }

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// Drag & Drop event bindings
function setupDragAndDropZones() {
  const zones = ['ruhsat', 'kimlik', 'vergi', 'sirkuler', 'dekont', 'calisma'];
  
  zones.forEach(zoneId => {
    const zoneElement = document.getElementById(`zone-${zoneId}`);
    if (zoneElement) {
      // Prevent default browser opening of dropped files
      ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        zoneElement.addEventListener(eventName, (e) => e.preventDefault(), false);
      });

      // Drag highlights
      ['dragenter', 'dragover'].forEach(eventName => {
        zoneElement.addEventListener(eventName, () => zoneElement.classList.add('dragover'), false);
      });

      ['dragleave', 'drop'].forEach(eventName => {
        zoneElement.addEventListener(eventName, () => zoneElement.classList.remove('dragover'), false);
      });

      // Handle dropped files
      zoneElement.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files.length > 0) {
          const fileInput = document.getElementById(`file-${zoneId}`);
          if (fileInput) {
            fileInput.files = files; // Sync dropped files with the input
            handleFileSelect(fileInput, zoneId);
          }
        }
      });
    }
  });
}

function triggerFileInput(inputId) {
  const fileInput = document.getElementById(inputId);
  if (fileInput) {
    fileInput.click();
  }
}

function handleFileSelect(input, type) {
  const file = input.files[0];
  const errorMsg = document.getElementById(`error-file-${type}`);
  
  if (errorMsg) errorMsg.style.display = 'none'; // Clear error
  
  if (!file) return;

  // Validate size (max 5MB)
  const maxSize = 5 * 1024 * 1024;
  if (file.size > maxSize) {
    showUploadError(type, "Dosya boyutu 5MB'dan büyük olamaz.");
    input.value = '';
    return;
  }

  // Validate format
  const allowedTypes = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg'];
  if (!allowedTypes.includes(file.type)) {
    showUploadError(type, "Desteklenmeyen dosya türü. Sadece PDF, JPG veya PNG yükleyebilirsiniz.");
    input.value = '';
    return;
  }

  // Save to memory state
  uploadedFiles[type] = file;

  // Render file info preview
  renderFilePreview(file, type);
}

function showUploadError(type, message) {
  const errorMsg = document.getElementById(`error-file-${type}`);
  if (errorMsg) {
    errorMsg.innerHTML = `<i data-lucide="alert-circle" style="width: 14px; height: 14px;"></i> ${message}`;
    errorMsg.style.display = 'flex';
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
}

function renderFilePreview(file, type) {
  const previewList = document.getElementById(`preview-list-${type}`);
  if (previewList) {
    previewList.innerHTML = ''; // Clear previous

    const sizeInKB = (file.size / 1024).toFixed(1);
    const sizeDisplay = sizeInKB > 1000 ? `${(sizeInKB / 1024).toFixed(1)} MB` : `${sizeInKB} KB`;

    const li = document.createElement('li');
    li.className = 'file-item';
    li.innerHTML = `
      <div class="file-info">
        <i data-lucide="file-text" class="file-icon" style="width: 18px; height: 18px;"></i>
        <div style="overflow: hidden;">
          <div class="file-name" title="${file.name}">${file.name}</div>
          <div class="file-size">${sizeDisplay}</div>
        </div>
      </div>
      <button type="button" class="file-remove" onclick="removeFile('${type}')" aria-label="Dosyayı kaldır">
        <i data-lucide="trash-2" style="width: 16px; height: 16px;"></i>
      </button>
    `;
    previewList.appendChild(li);
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
}

function removeFile(type) {
  uploadedFiles[type] = null;
  const fileInput = document.getElementById(`file-${type}`);
  if (fileInput) fileInput.value = ''; // Reset input
  
  const previewList = document.getElementById(`preview-list-${type}`);
  if (previewList) previewList.innerHTML = ''; // Clear preview
}

/* ==========================================================================
   WIZARD NAVIGATION & VALIDATION
   ========================================================================== */


function navigateStep(direction) {
  const form = document.getElementById('subscription-apply-form');
  
  if (direction === 1) {
    // Check validation of the current active step before proceeding
    const isValid = validateStep(currentStep);
    if (!isValid) {
      const activeStepEl = document.getElementById(`form-step-${currentStep}`);
      if (activeStepEl) {
        // Find the first element that is invalid (.is-invalid) in the step
        const firstInvalid = activeStepEl.querySelector('.is-invalid');
        if (firstInvalid) {
          firstInvalid.focus();
          firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
          
          // Add premium shake animation
          firstInvalid.classList.add('error-shake');
          setTimeout(() => {
            firstInvalid.classList.remove('error-shake');
          }, 500);
        }
      }
      return;
    }

    // Intercept transition from Step 2 to Step 3 for Billing Confirmation Modal
    if (currentStep === 2) {
      showBillingConfirmationModal();
      return; // Stop transition here, modal button confirmBillingAndContinue will proceed
    }
  }

  // Increment/Decrement step
  currentStep += direction;

  // Bound checks
  if (currentStep < 1) currentStep = 1;
  if (currentStep > 5) currentStep = 5;

  // Update UI Display
  updateWizardUI();

  // If entering success step, submit data
  if (currentStep === 5) {
    handleFormSubmit();
  }
}

function showBillingConfirmationModal() {
  const isCustom = hasCustomBilling();
  const confirmContent = document.getElementById('billing-confirm-content');
  
  if (!confirmContent) return;

  const fullName = document.getElementById('full-name').value.trim();
  const tcNo = document.getElementById('tc-identity').value.trim();
  const homeAddress = document.getElementById('home-address').value.trim();

  if (isCustom) {
    const radioSahis = document.getElementById('billing-corp-type-sahis');
    const radioBireysel = document.getElementById('billing-corp-type-bireysel');
    
    const isSahis = radioSahis ? radioSahis.checked : false;
    const isBireysel = radioBireysel ? radioBireysel.checked : false;

    const company = document.getElementById('billing-company').value.trim();
    const taxOffice = document.getElementById('billing-tax-office').value.trim();
    const taxNo = document.getElementById('billing-tax-no').value.trim();
    const address = document.getElementById('billing-address').value.trim();

    if (isBireysel) {
      confirmContent.innerHTML = `
        <div style="margin-bottom: 0.75rem;">
          <span style="font-size: 0.75rem; text-transform: uppercase; font-weight: 700; color: var(--color-primary); background: rgba(15, 59, 162, 0.08); padding: 0.2rem 0.5rem; border-radius: var(--radius-sm); display: inline-block; margin-bottom: 0.5rem;">Fatura Tipi: Bireysel Fatura (Şahıs - Farklı Bilgilerle)</span>
        </div>
        <div style="font-size: 0.85rem; display: flex; flex-direction: column; gap: 0.5rem; color: var(--color-text-dark); text-align: left;">
          <div><strong>Fatura Sahibi:</strong> ${company}</div>
          <div><strong>T.C. Kimlik Numarası:</strong> ${taxNo}</div>
          <div style="border-top: 1px solid var(--color-border-light); padding-top: 0.5rem; margin-top: 0.25rem;"><strong>Fatura Adresi:</strong><br><span style="color: var(--color-text-muted); font-size: 0.8rem; line-height: 1.4; display: block; margin-top: 0.15rem;">${address}</span></div>
        </div>
      `;
    } else {
      const companyTypeLabel = isSahis ? 'Şahıs Şirketi' : 'Sermaye Şirketi (LTD. / A.Ş.)';
      const taxNoLabel = isSahis ? 'T.C. Kimlik Numarası' : 'Vergi Numarası';
      const companyNameLabel = isSahis ? 'Firma Sahibi' : 'Firma Unvanı';

      confirmContent.innerHTML = `
        <div style="margin-bottom: 0.75rem;">
          <span style="font-size: 0.75rem; text-transform: uppercase; font-weight: 700; color: var(--color-accent-orange); background: rgba(255, 122, 0, 0.08); padding: 0.2rem 0.5rem; border-radius: var(--radius-sm); display: inline-block; margin-bottom: 0.5rem;">Fatura Tipi: Kurumsal Fatura (${companyTypeLabel})</span>
        </div>
        <div style="font-size: 0.85rem; display: flex; flex-direction: column; gap: 0.5rem; color: var(--color-text-dark); text-align: left;">
          <div><strong>${companyNameLabel}:</strong> ${company}</div>
          <div><strong>Vergi Dairesi:</strong> ${taxOffice}</div>
          <div><strong>${taxNoLabel}:</strong> ${taxNo}</div>
          <div style="border-top: 1px solid var(--color-border-light); padding-top: 0.5rem; margin-top: 0.25rem;"><strong>Fatura Adresi:</strong><br><span style="color: var(--color-text-muted); font-size: 0.8rem; line-height: 1.4; display: block; margin-top: 0.15rem;">${address}</span></div>
        </div>
      `;
    }
  } else {
    confirmContent.innerHTML = `
      <div style="margin-bottom: 0.75rem;">
        <span style="font-size: 0.75rem; text-transform: uppercase; font-weight: 700; color: var(--color-primary); background: rgba(15, 59, 162, 0.08); padding: 0.2rem 0.5rem; border-radius: var(--radius-sm); display: inline-block; margin-bottom: 0.5rem;">Fatura Tipi: Bireysel Fatura (Şahıs)</span>
      </div>
      <div style="font-size: 0.85rem; display: flex; flex-direction: column; gap: 0.5rem; color: var(--color-text-dark); text-align: left;">
        <div><strong>Ad Soyad:</strong> ${fullName}</div>
        <div><strong>T.C. Kimlik Numarası:</strong> ${tcNo}</div>
        <div style="border-top: 1px solid var(--color-border-light); padding-top: 0.5rem; margin-top: 0.25rem;"><strong>Fatura Adresi:</strong><br><span style="color: var(--color-text-muted); font-size: 0.8rem; line-height: 1.4; display: block; margin-top: 0.15rem;">${homeAddress}</span></div>
        <div style="border-top: 1px solid var(--color-border-light); padding-top: 0.5rem; margin-top: 0.25rem; color: var(--color-text-muted); font-size: 0.75rem; line-height: 1.4;">
          Faturanız verdiğiniz T.C. Kimlik Numarası, isim ve adres bilgilerine düzenlenecektir.
        </div>
      </div>
    `;
  }

  // Open the billing confirm modal
  openModal('modal-billing-confirm');
}

function confirmBillingAndContinue() {
  closeModal('modal-billing-confirm');
  
  // Proceed directly to step 3
  currentStep = 3;
  updateWizardUI();
}

function validateStep(step) {
  let isValid = true;
  
  // Reset all errors and invalid styling
  const activeStepEl = document.getElementById(`form-step-${step}`);
  if (!activeStepEl) return true;

  const errors = activeStepEl.querySelectorAll('.error-message');
  errors.forEach(err => err.style.display = 'none');

  const invalidInputs = activeStepEl.querySelectorAll('.is-invalid');
  invalidInputs.forEach(el => el.classList.remove('is-invalid'));

  const customTrigger = document.getElementById('custom-otopark-select-trigger');
  if (customTrigger) customTrigger.classList.remove('is-invalid');
  
  if (step === 1) {
    const otopark = document.getElementById('otopark-selection');
    const startDate = document.getElementById('start-date');

    if (!otopark.value) {
      document.getElementById('error-parking').style.display = 'flex';
      otopark.classList.add('is-invalid');
      if (customTrigger) customTrigger.classList.add('is-invalid');
      isValid = false;
    }

    if (!startDate.value) {
      document.getElementById('error-date').style.display = 'flex';
      startDate.classList.add('is-invalid');
      isValid = false;
    }
  }
  
  else if (step === 2) {
    const companyName = document.getElementById('company-name');
    const fullName = document.getElementById('full-name');
    const tcNo = document.getElementById('tc-identity');
    const phone = document.getElementById('phone-number');
    const email = document.getElementById('email-address');
    const plate = document.getElementById('license-plate');
    const carModel = document.getElementById('car-model');
    const driverName = document.getElementById('driver-name');
    const homeAddress = document.getElementById('home-address');

    // Validation Company Name
    if (!companyName || !companyName.value.trim()) {
      const errEl = document.getElementById('error-company-name');
      if (errEl) errEl.style.display = 'flex';
      if (companyName) companyName.classList.add('is-invalid');
      isValid = false;
    }

    // Validation Name (Minimum two words, letters and spaces only)
    const nameRegex = /^[\p{L} \.\-]+$/u;
    const nameWords = fullName.value.trim().split(/\s+/);
    if (!fullName.value.trim() || !nameRegex.test(fullName.value) || nameWords.length < 2) {
      document.getElementById('error-name').style.display = 'flex';
      fullName.classList.add('is-invalid');
      isValid = false;
    }

    // Validation TC (exactly 11 digits)
    if (!tcNo.value || tcNo.value.length !== 11 || !/^\d{11}$/.test(tcNo.value)) {
      document.getElementById('error-tc').style.display = 'flex';
      tcNo.classList.add('is-invalid');
      isValid = false;
    }

    // Validation Phone
    const digitsOnly = phone.value.replace(/\D/g, '');
    if (!phone.value || digitsOnly.length < 10) {
      document.getElementById('error-phone').style.display = 'flex';
      phone.classList.add('is-invalid');
      isValid = false;
    }

    // Validation Email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email.value || !emailRegex.test(email.value)) {
      document.getElementById('error-email').style.display = 'flex';
      email.classList.add('is-invalid');
      isValid = false;
    }

    // Validation Plate (Turkish standard format check)
    const plateRegex = /^(0[1-9]|[1-7][0-9]|8[0-1])[A-Z]{1,3}\d{2,4}$/;
    const cleanPlate = plate.value.trim().toUpperCase().replace(/\s+/g, '');
    if (!cleanPlate || !plateRegex.test(cleanPlate)) {
      document.getElementById('error-plate').style.display = 'flex';
      plate.classList.add('is-invalid');
      isValid = false;
    }

    if (!carModel.value.trim()) {
      document.getElementById('error-model').style.display = 'flex';
      carModel.classList.add('is-invalid');
      isValid = false;
    }

    // Validation Driver Name (Minimum two words, letters and spaces only)
    const driverNameWords = driverName.value.trim().split(/\s+/);
    if (!driverName.value.trim() || !nameRegex.test(driverName.value) || driverNameWords.length < 2) {
      const errEl = document.getElementById('error-driver');
      if (errEl) errEl.style.display = 'flex';
      driverName.classList.add('is-invalid');
      isValid = false;
    }

    // Validation Home Address
    if (!homeAddress.value.trim()) {
      const errEl = document.getElementById('error-home-address');
      if (errEl) errEl.style.display = 'flex';
      homeAddress.classList.add('is-invalid');
      isValid = false;
    }

    // Validation Billing Info (If custom billing is selected)
    if (hasCustomBilling()) {
      const bCompany = document.getElementById('billing-company');
      const bTaxOffice = document.getElementById('billing-tax-office');
      const bTaxNo = document.getElementById('billing-tax-no');
      const bAddress = document.getElementById('billing-address');

      const radioSahis = document.getElementById('billing-corp-type-sahis');
      const radioBireysel = document.getElementById('billing-corp-type-bireysel');
      
      const isSahis = radioSahis ? radioSahis.checked : false;
      const isBireysel = radioBireysel ? radioBireysel.checked : false;

      if (!bCompany.value.trim()) {
        const errEl = document.getElementById('error-billing-company');
        if (errEl) errEl.style.display = 'flex';
        bCompany.classList.add('is-invalid');
        isValid = false;
      }
      
      // Vergi Dairesi validation is ONLY required for LTD/A.Ş. and Şahıs Şirketi (not for Bireysel Şahıs)
      if (!isBireysel && !bTaxOffice.value.trim()) {
        const errEl = document.getElementById('error-billing-tax-office');
        if (errEl) errEl.style.display = 'flex';
        bTaxOffice.classList.add('is-invalid');
        isValid = false;
      }
      
      // Tax no must be 10 digits for LTD/A.Ş. or 11 digits for Şahıs Şirketi / Şahıs Bireysel
      const requiredLength = (isSahis || isBireysel) ? 11 : 10;
      const lengthRegex = (isSahis || isBireysel) ? /^\d{11}$/ : /^\d{10}$/;

      if (!bTaxNo.value || bTaxNo.value.length !== requiredLength || !lengthRegex.test(bTaxNo.value)) {
        const errEl = document.getElementById('error-billing-tax-no');
        if (errEl) {
          errEl.style.display = 'flex';
          if (isSahis || isBireysel) {
            errEl.innerHTML = '<i data-lucide="alert-circle" style="width: 14px; height: 14px;"></i> Lütfen 11 haneli T.C. kimlik numarasını girin.';
          } else {
            errEl.innerHTML = '<i data-lucide="alert-circle" style="width: 14px; height: 14px;"></i> Lütfen 10 haneli vergi numarasını girin.';
          }
          if (typeof lucide !== 'undefined') lucide.createIcons();
        }
        bTaxNo.classList.add('is-invalid');
        isValid = false;
      }
      if (!bAddress.value.trim()) {
        const errEl = document.getElementById('error-billing-address');
        if (errEl) errEl.style.display = 'flex';
        bAddress.classList.add('is-invalid');
        isValid = false;
      }
    }
  }
  
  else if (step === 3) {
    if (!uploadedFiles.ruhsat) {
      document.getElementById('error-file-ruhsat').style.display = 'flex';
      const zone = document.getElementById('zone-ruhsat');
      if (zone) zone.classList.add('is-invalid');
      isValid = false;
    }
    if (!uploadedFiles.kimlik) {
      document.getElementById('error-file-kimlik').style.display = 'flex';
      const zone = document.getElementById('zone-kimlik');
      if (zone) zone.classList.add('is-invalid');
      isValid = false;
    }
    if (!uploadedFiles.vergi) {
      document.getElementById('error-file-vergi').style.display = 'flex';
      const zone = document.getElementById('zone-vergi');
      if (zone) zone.classList.add('is-invalid');
      isValid = false;
    }
    if (!uploadedFiles.calisma) {
      document.getElementById('error-file-calisma').style.display = 'flex';
      const zone = document.getElementById('zone-calisma');
      if (zone) zone.classList.add('is-invalid');
      isValid = false;
    }
    if (!uploadedFiles.dekont) {
      document.getElementById('error-file-dekont').style.display = 'flex';
      const zone = document.getElementById('zone-dekont');
      if (zone) zone.classList.add('is-invalid');
      isValid = false;
    }
  }
  
  else if (step === 4) {
    const chkKvkkTerms = document.getElementById('chk-kvkk-terms');
    const chkMarketing = document.getElementById('chk-marketing');

    if (chkKvkkTerms && !chkKvkkTerms.checked) {
      const errorEl = document.getElementById('error-chk-kvkk-terms');
      if (errorEl) errorEl.style.display = 'flex';
      const wrapper = document.getElementById('item-chk-kvkk-terms');
      if (wrapper) wrapper.classList.add('is-invalid');
      isValid = false;
    }

    if (chkMarketing && !chkMarketing.checked) {
      const errorEl = document.getElementById('error-chk-marketing');
      if (errorEl) errorEl.style.display = 'flex';
      const wrapper = document.getElementById('item-chk-marketing');
      if (wrapper) wrapper.classList.add('is-invalid');
      isValid = false;
    }

    // Turnstile Validation check
    const turnstileResponse = document.getElementsByName('cf-turnstile-response')[0]?.value;
    if (!turnstileResponse) {
      alert("Lütfen güvenlik doğrulamasını (Turnstile) tamamlayın.");
      isValid = false;
    }
  }

  if (typeof lucide !== 'undefined') lucide.createIcons();
  return isValid;
}

function updateWizardUI() {
  // 1. Show/hide steps
  const steps = document.querySelectorAll('.form-step');
  steps.forEach(stepEl => {
    const stepNum = parseInt(stepEl.getAttribute('data-step'));
    if (stepNum === currentStep) {
      stepEl.classList.add('active');
    } else {
      stepEl.classList.remove('active');
    }
  });

  // 2. Update Progress Tracker indicators classes
  const indicators = document.querySelectorAll('.step-indicator');
  indicators.forEach(ind => {
    const stepNum = parseInt(ind.getAttribute('data-step'));
    
    ind.classList.remove('active', 'completed', 'clickable');
    
    if (stepNum === currentStep) {
      ind.classList.add('active');
    } else if (stepNum < currentStep) {
      ind.classList.add('completed');
      if (currentStep < 5) {
        ind.classList.add('clickable');
      }
    }
  });

  // 3. Update Progress Bar Fill Line width percentage
  const progressBar = document.getElementById('progress-bar-fill');
  if (progressBar) {
    const percent = ((currentStep - 1) / 4) * 100;
    progressBar.style.width = `${percent}%`;
  }

  // 4. Update Prev / Next navigation buttons display in footer
  const prevBtn = document.getElementById('btn-wizard-prev');
  const nextBtn = document.getElementById('btn-wizard-next');
  const wizardFooter = document.getElementById('wizard-footer');

  if (currentStep === 1) {
    if (wizardFooter) wizardFooter.style.display = 'flex';
    prevBtn.style.visibility = 'hidden';
    nextBtn.style.display = 'inline-flex';
    nextBtn.querySelector('span').textContent = 'Devam Et';
  } else if (currentStep > 1 && currentStep < 5) {
    if (wizardFooter) wizardFooter.style.display = 'flex';
    prevBtn.style.visibility = 'visible';
    nextBtn.style.display = 'inline-flex';
    if (currentStep === 4) {
      nextBtn.querySelector('span').textContent = 'Başvuruyu Tamamla';
    } else {
      nextBtn.querySelector('span').textContent = 'Devam Et';
    }
  } else if (currentStep === 5) {
    // Hide wizard footer controls completely on success screen
    if (wizardFooter) wizardFooter.style.display = 'none';
  }

  if (currentStep === 3) {
    updatePaymentPanel();
  }

  // Scroll to top of the page smoothly on step changes
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updatePaymentPanel() {
  const panel = document.getElementById('payment-info-panel');
  if (!panel) return;

  const otoparkSelect = document.getElementById('otopark-selection');
  if (!otoparkSelect) return;

  const selectedName = otoparkSelect.value;
  if (!selectedName) {
    panel.innerHTML = `
      <div style="padding: 1rem; border: 1px dashed var(--color-border-light); border-radius: var(--radius-md); text-align: center; color: var(--color-text-muted); font-size: 0.875rem;">
        Lütfen 1. adımda abonelik otoparkını seçiniz.
      </div>
    `;
    return;
  }

  const OTOPARKS_KEY = 'parkexpert_otoparks';
  const otoparks = JSON.parse(localStorage.getItem(OTOPARKS_KEY)) || [];
  const park = otoparks.find(p => p.name === selectedName);

  if (!park) {
    panel.innerHTML = `
      <div style="padding: 1rem; border: 1px dashed var(--color-border-light); border-radius: var(--radius-md); text-align: center; color: var(--color-text-muted); font-size: 0.875rem;">
        Seçilen otoparka ait ödeme bilgisi bulunamadı.
      </div>
    `;
    return;
  }

  // Pre-formatted pricing
  const employeePrice = park.priceEmployee || 'Belirtilmedi';
  const externalPrice = park.priceExternal || 'Belirtilmedi';

  panel.innerHTML = `
    <div class="payment-info-card">
      <div class="payment-card-title">
        <i data-lucide="credit-card" style="width: 20px; height: 20px; color: var(--color-primary);"></i>
        <span>Ödeme ve Şirket Bilgileri (${park.name} Aboneliği İçin)</span>
      </div>
      <div class="payment-grid">
        <div class="payment-section">
          <div class="payment-section-title">Şirket Yasal Bilgileri</div>
          <div class="payment-detail-row">
            <span class="payment-detail-label">Alıcı / Firma Unvanı:</span>
            <span class="payment-detail-value">${park.companyTitle || 'PUSULA AKILLI ŞEHİRCİLİK VE BİLGİ TEKNOLOJİLERİ A.Ş.'}</span>
          </div>
          <div class="payment-detail-row" style="margin-top: 0.5rem;">
            <span class="payment-detail-label">Vergi Dairesi / No:</span>
            <span class="payment-detail-value">${park.taxOffice || 'ALEMDAĞ VERGİ DAİRESİ'} / ${park.taxNumber || '733 090 73 26'}</span>
          </div>
        </div>

        <div class="payment-section">
          <div class="payment-section-title">Banka Hesap Bilgileri</div>
          <div class="payment-detail-row">
            <span class="payment-detail-label">Banka Adı:</span>
            <span class="payment-detail-value">${park.bankName || 'Albaraka Türk'}</span>
          </div>
          <div class="payment-detail-row" style="margin-top: 0.5rem;">
            <span class="payment-detail-label">IBAN:</span>
            <div class="iban-container">
              <span class="iban-text" id="iban-text-val">${park.iban}</span>
              <button type="button" class="btn-copy-iban" onclick="copyIbanToClipboard(this, '${park.iban}')" title="IBAN Kopyala">
                <i data-lucide="copy" style="width: 14px; height: 14px;"></i>
                <span class="copy-tooltip">Kopyalandı!</span>
              </button>
            </div>
          </div>
        </div>

        <div class="payment-section">
          <div class="payment-section-title">Tarife & İletişim</div>
          <div class="payment-detail-row">
            <span class="payment-detail-label">Fiyat Bilgisi (Aylık / Araç Başı):</span>
            <span class="payment-detail-value">Personel: ${employeePrice} | Dış Abonelik: ${externalPrice}</span>
          </div>
          <div class="payment-detail-row" style="margin-top: 0.5rem;">
            <span class="payment-detail-label">Abonelik Destek Hattı:</span>
            <span class="payment-detail-value" style="color: var(--color-primary);">${park.supportPhone || '0501 618 34 82'}</span>
          </div>
        </div>
      </div>
      <div class="payment-warning-text">
        <i data-lucide="alert-triangle" style="width: 16px; height: 16px;"></i>
        <span>AÇIKLAMA KISMINA PLAKA VE ABONE BİLGİSİ YAZMAYI UNUTMAYINIZ!</span>
      </div>
    </div>
  `;

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function copyIbanToClipboard(btn, iban) {
  navigator.clipboard.writeText(iban).then(() => {
    btn.classList.add('copied');
    
    // Change icon to check
    const icon = btn.querySelector('i');
    if (icon) {
      icon.outerHTML = '<i data-lucide="check" style="width: 14px; height: 14px; color: #22c55e;"></i>';
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
    
    setTimeout(() => {
      btn.classList.remove('copied');
      const newIcon = btn.querySelector('i');
      if (newIcon) {
        newIcon.outerHTML = '<i data-lucide="copy" style="width: 14px; height: 14px;"></i>';
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }
    }, 2000);
  }).catch(err => {
    console.error('Copy failed: ', err);
  });
}

function generateApplicationCode() {
  // Format: PE-2026-XXXX (4 character random upper alphanumeric)
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let rand = '';
  for (let i = 0; i < 4; i++) {
    rand += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `PE-2026-${rand}`;
}

function showSubmitLoader() {
  const loader = document.createElement('div');
  loader.id = 'submit-loader-overlay';
  loader.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background: rgba(15, 23, 42, 0.85);
    backdrop-filter: blur(8px);
    z-index: 99999;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: #ffffff;
    font-family: inherit;
  `;
  loader.innerHTML = `
    <div style="width: 50px; height: 50px; border: 4px solid rgba(255,255,255,0.1); border-top-color: var(--color-accent-gold, #ffb800); border-radius: 50%; animation: spin 1s infinite linear; margin-bottom: 1.25rem;"></div>
    <h3 style="margin: 0; font-size: 1.15rem; font-weight: 800; letter-spacing: 0.5px;">Başvurunuz Kaydediliyor</h3>
    <p style="margin: 0.4rem 0 0 0; font-size: 0.825rem; color: rgba(255,255,255,0.6); text-align: center; max-width: 320px; line-height: 1.4;">Belgeleriniz ve ön kayıt bilgileriniz güvenli bulut depolama alanına yükleniyor, lütfen bekleyin...</p>
    <style>
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
    </style>
  `;
  document.body.appendChild(loader);
}

function hideSubmitLoader() {
  const loader = document.getElementById('submit-loader-overlay');
  if (loader) loader.remove();
}

async function handleFormSubmit() {
  // Construct Application payload
  const appCode = generateApplicationCode();
  
  // Set in DOM success badge
  const appCodeEl = document.getElementById('success-app-code');
  if (appCodeEl) appCodeEl.textContent = appCode;

  // Retrieve inputs
  const companyName = document.getElementById('company-name').value.trim().toLocaleUpperCase('tr-TR');
  const fullName = document.getElementById('full-name').value.trim().toLocaleUpperCase('tr-TR');
  const otopark = document.getElementById('otopark-selection').value;
  const startDate = document.getElementById('start-date').value;
  const tcNo = document.getElementById('tc-identity').value.trim();
  const phone = document.getElementById('phone-number').value.trim();
  const email = document.getElementById('email-address').value.trim().toLowerCase();
  const plate = document.getElementById('license-plate').value.trim().toUpperCase();
  const carModel = document.getElementById('car-model').value.trim().toLocaleUpperCase('tr-TR');
  const driverName = document.getElementById('driver-name').value.trim().toLocaleUpperCase('tr-TR');
  const homeAddress = document.getElementById('home-address').value.trim().toLocaleUpperCase('tr-TR');
  const notes = document.getElementById('application-notes').value.trim().toLocaleUpperCase('tr-TR');

  // Retrieve billing info
  const isCustom = hasCustomBilling();
  const radioSahisSubmit = document.getElementById('billing-corp-type-sahis');
  const radioBireyselSubmit = document.getElementById('billing-corp-type-bireysel');
  
  const isSahisSubmit = radioSahisSubmit ? radioSahisSubmit.checked : false;
  const isBireyselSubmit = radioBireyselSubmit ? radioBireyselSubmit.checked : false;
  
  const billingInfo = {
    company_type: isBireyselSubmit ? 'bireysel' : (isSahisSubmit ? 'sahis' : 'sermaye'),
    company: isCustom ? document.getElementById('billing-company').value.trim().toLocaleUpperCase('tr-TR') : fullName,
    tax_office: (isCustom && !isBireyselSubmit) ? document.getElementById('billing-tax-office').value.trim().toLocaleUpperCase('tr-TR') : '',
    tax_no: isCustom ? document.getElementById('billing-tax-no').value.trim() : tcNo,
    address: isCustom ? document.getElementById('billing-address').value.trim().toLocaleUpperCase('tr-TR') : homeAddress,
    is_custom: isCustom
  };

  let appSubtype = 'Bireysel';
  if (isBireyselSubmit) {
    appSubtype = isCustom ? 'Bireysel (Şahıs Faturası)' : 'Bireysel';
  } else if (isSahisSubmit) {
    appSubtype = 'Kurumsal (Şahıs Şirketi)';
  } else {
    appSubtype = 'Kurumsal (LTD. / A.Ş.)';
  }

  // Show loader overlay
  showSubmitLoader();

  try {
    const formData = new FormData();
    formData.append("id", appCode);
    formData.append("full_name", fullName);
    formData.append("email", email);
    formData.append("phone", phone);
    formData.append("plate_number", plate);
    formData.append("parking_location", otopark);
    formData.append("company_name", companyName || (billingInfo.company_type !== 'bireysel' ? billingInfo.company : null));
    formData.append("tax_office", billingInfo.tax_office);
    formData.append("tax_number", billingInfo.tax_no);
    formData.append("subscription_type", appSubtype);
    
    // Additional text inputs
    formData.append("tc_no", tcNo);
    formData.append("car_model", carModel);
    formData.append("driver_name", driverName);
    formData.append("home_address", homeAddress);
    formData.append("notes", notes);
    formData.append("date_applied", new Date().toISOString());

    // Append Turnstile response token
    const turnstileResponse = document.getElementsByName('cf-turnstile-response')[0]?.value || '';
    formData.append("cf-turnstile-response", turnstileResponse);

    if (uploadedFiles.ruhsat) formData.append("ruhsat", uploadedFiles.ruhsat);
    if (uploadedFiles.kimlik) formData.append("kimlik", uploadedFiles.kimlik);
    if (uploadedFiles.dekont) formData.append("dekont", uploadedFiles.dekont);
    if (uploadedFiles.vergi) formData.append("vergi", uploadedFiles.vergi);
    if (uploadedFiles.sirkuler) formData.append("sirkuler", uploadedFiles.sirkuler);
    if (uploadedFiles.calisma) formData.append("calisma", uploadedFiles.calisma);

    const response = await fetch("/api/apply", {
      method: "POST",
      body: formData
    });

    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error || "Başvuru kaydedilirken bir hata oluştu.");
    }

    hideSubmitLoader();

    // Trigger simulated notifications for feedback logs
    const mockApp = {
      id: appCode,
      full_name: fullName,
      phone: phone,
      email: email,
      plate: plate,
      parking_location: otopark,
      subscription_type: appSubtype,
      start_date: startDate,
      car_model: carModel
    };
    triggerEmailNotification(mockApp);
    triggerWhatsAppNotification(mockApp);

  } catch (err) {
    hideSubmitLoader();
    alert(`Başvuru Gönderilemedi!\n\nHata: ${err.message}`);
    // Revert current step to step 4 so user can correct and retry
    currentStep = 4;
    updateWizardUI();
  }
}

// Simulated Email Notification System
let currentSimulatedApp = null;

function triggerEmailNotification(app) {
  currentSimulatedApp = app;

  // 1. Populate the simulated inbox modal elements
  const fields = {
    'email-sim-to-name': app.full_name,
    'email-sim-to-addr': `<${app.email}>`,
    'email-sim-subject-code': app.id,
    'email-sim-body-name': app.full_name,
    'email-sim-info-code': app.id,
    'email-sim-info-plate': app.plate,
    'email-sim-info-location': app.parking_location,
    'email-sim-info-type': app.subscription_type,
    'email-sim-info-date': formatDateTR(app.start_date),
    'email-sim-info-model': app.car_model || 'Belirtilmedi'
  };

  for (const [id, value] of Object.entries(fields)) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  const toast = document.getElementById('email-toast');
  const toastTitle = document.getElementById('toast-title');
  const toastMessage = document.getElementById('toast-message');
  const isAdmin = !!document.querySelector('.admin-layout');
  if (toast && isAdmin) {
    // Reset classes and set loading state
    toast.classList.add('active');
    if (toastTitle) toastTitle.innerHTML = `<span style="display:inline-flex; align-items:center; gap:0.25rem;">📧 E-posta Bildirimi</span>`;
    if (toastMessage) toastMessage.textContent = 'Güvenli SMTP sunucusuna bağlanılıyor...';

    // Phase 1: Sending...
    setTimeout(() => {
      if (toastMessage) toastMessage.textContent = `${app.email} adresine gönderiliyor...`;
    }, 1000);

    // Phase 2: Sent successfully!
    setTimeout(() => {
      if (toastMessage) toastMessage.innerHTML = `📬 <strong>Onay e-postası iletildi!</strong><br><span style="font-size:0.7rem; color:var(--color-primary);">Detayları görmek için "Görüntüle"ye tıklayın.</span>`;
      
      // Dynamic Lucide update for success check icon in toast
      const toastIcon = toast.querySelector('.toast-icon');
      if (toastIcon) {
        toastIcon.innerHTML = `<i data-lucide="mail-check" style="color:#25d366;"></i>`;
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }
      
      // Auto-hide toast after showing success for a while
      setTimeout(() => {
        toast.classList.remove('active');
      }, 6000);

    }, 2800);
  }

  /* ========================================================================
     ℹ️ PRODUCTION EMAILJS INTEGRATION READY
     ------------------------------------------------------------------------
     To send REAL physical emails, uncomment the following block, sign up for 
     a free EmailJS account, and configure your keys:
     
     // 1. Add SDK script in basvuru.html: <script src="https://cdn.jsdelivr.net/npm/@emailjs/browser@3/dist/email.min.js"></script>
     // 2. Initialize in your code: emailjs.init("YOUR_PUBLIC_KEY");
     // 3. Trigger sending:
     
     emailjs.send("YOUR_SERVICE_ID", "YOUR_TEMPLATE_ID", {
       to_name: app.full_name,
       to_email: app.email,
       app_code: app.id,
       license_plate: app.plate,
       parking_location: app.parking_location,
       subscription_type: app.subscription_type,
       start_date: app.start_date
     }).then(
       (response) => { console.log('EMAIL SENT SUCCESS!', response.status, response.text); },
       (error) => { console.log('EMAIL SEND FAILED...', error); }
     );
     ======================================================================== */
}

function openEmailSimulationModal() {
  if (currentSimulatedApp) {
    openModal('modal-email-simulation');
  }
}

/* Simulated WhatsApp Notification System */
let currentSimulatedAppForWhatsApp = null;

function triggerWhatsAppNotification(app) {
  currentSimulatedAppForWhatsApp = app;

  const OTOPARKS_KEY = 'parkexpert_otoparks';
  const otoparks = JSON.parse(localStorage.getItem(OTOPARKS_KEY)) || [];
  const park = otoparks.find(p => p.name === app.parking_location) || {};

  const now = new Date();
  const timeStr = now.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

  // Populate simulated WhatsApp modal elements
  const fields = {
    'whatsapp-sim-name': app.full_name,
    'whatsapp-sim-code': app.id,
    'whatsapp-sim-plate': app.plate,
    'whatsapp-sim-location': app.parking_location,
    'whatsapp-sim-price': (app.subscription_type.includes('Kurumsal') && app.parking_location !== 'Birlik Sanayi Sitesi - Beylikdüzü') ? (park.priceExternal || '2400 TL') : (park.priceEmployee || '1200 TL'),
    'whatsapp-sim-phone': park.supportPhone || '0216 504 47 22',
    'whatsapp-sim-bank': park.bankName || 'Vakıfbank',
    'whatsapp-sim-iban': park.iban || 'TR23 0001 5001 5800 7302 9104 88',
    'whatsapp-sim-time': timeStr
  };

  for (const [id, value] of Object.entries(fields)) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  const toast = document.getElementById('whatsapp-toast');
  const toastTitle = document.getElementById('whatsapp-toast-title');
  const toastMessage = document.getElementById('whatsapp-toast-message');
  const isAdmin = !!document.querySelector('.admin-layout');
  if (toast && isAdmin) {
    toast.classList.add('active');
    if (toastTitle) toastTitle.innerHTML = `<span style="display:inline-flex; align-items:center; gap:0.25rem; color:#25d366;">💬 WhatsApp Bildirimi</span>`;
    if (toastMessage) toastMessage.textContent = 'WhatsApp API sunucularına bağlanılıyor...';

    // Phase 1: Sending message...
    setTimeout(() => {
      if (toastMessage) toastMessage.textContent = `${app.phone} numarasına teyit iletiliyor...`;
    }, 1200);

    // Phase 2: Sent successfully!
    setTimeout(() => {
      if (toastMessage) toastMessage.innerHTML = `<strong>Başvuru teyit mesajı iletildi!</strong><br><span style="font-size:0.7rem; color:#25d366;">Detayları görmek için tıklayın.</span>`;
      
      const toastIcon = toast.querySelector('.toast-icon');
      if (toastIcon) {
        toastIcon.innerHTML = `<i data-lucide="message-square" style="color:#25d366; fill:#25d366;"></i>`;
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }
      
      // Auto-hide toast
      setTimeout(() => {
        toast.classList.remove('active');
      }, 7000);

    }, 3200);

    // Make toast clickable to open the simulation modal
    toast.style.cursor = 'pointer';
    toast.onclick = () => {
      openWhatsAppSimulationModal();
      toast.classList.remove('active');
    };
  }
}

function openWhatsAppSimulationModal() {
  if (currentSimulatedAppForWhatsApp) {
    openModal('modal-whatsapp-simulation');
  }
}

function redirectToWhatsAppConfirm() {
  if (!currentSimulatedAppForWhatsApp) return;

  const app = currentSimulatedAppForWhatsApp;
  
  // Fetch otopark phone for WhatsApp redirection
  const OTOPARKS_KEY = 'parkexpert_otoparks';
  const otoparks = JSON.parse(localStorage.getItem(OTOPARKS_KEY)) || [];
  const park = otoparks.find(p => p.name === app.parking_location) || {};
  
  // Fetch dynamic otopark support number
  let rawPhone = park.supportPhone || '0216 504 47 22';
  let cleanedPhone = rawPhone.replace(/\D/g, '');
  
  // Convert 05XX... to international 905XX... format for TR
  if (cleanedPhone.startsWith('0')) {
    cleanedPhone = '90' + cleanedPhone.substring(1);
  } else if (!cleanedPhone.startsWith('90')) {
    cleanedPhone = '90' + cleanedPhone;
  }

  // Pre-fill encoded message
  const textMsg = `Merhaba PARKEXPERT Yetkilisi,\n\n${app.plate} plakalı aracım için abonelik ön başvurusu gerçekleştirdim.\n\n📦 Başvuru Takip Kodu: ${app.id}\n🚗 Araç Plakası: ${app.plate}\n📍 Otopark Konumu: ${app.parking_location}\n\nÖdeme dekontumu ve başvuru detaylarımı teyit etmek üzere iletişime geçiyorum. İşlemlerimi onaylar mısınız? Teşekkürler.`;

  const encodedMsg = encodeURIComponent(textMsg);
  const waUrl = `https://api.whatsapp.com/send?phone=${cleanedPhone}&text=${encodedMsg}`;
  
  // Open real WhatsApp web or app chat in a new tab!
  window.open(waUrl, '_blank');
}


/* ==========================================================================
   ADMIN SaaS PANEL CONTROLLER (admin.html)
   ========================================================================== */

let allApplications = [];
let filteredApplications = [];
let currentAppId = null;

// Privacy Mode State & Helpers
let isPrivacyMode = true;

function maskName(name) {
  if (!name) return '';
  if (!isPrivacyMode) return name;
  return name.split(' ').map(word => {
    if (word.length <= 1) return word;
    return word[0] + '*'.repeat(word.length - 1);
  }).join(' ');
}

function maskPhone(phone) {
  if (!phone) return '';
  if (!isPrivacyMode) return phone;
  let digitsCount = 0;
  return phone.split('').map((char, index) => {
    if (/\d/.test(char)) {
      digitsCount++;
      if (digitsCount > 4 && index < phone.length - 2) {
        return '*';
      }
    }
    return char;
  }).join('');
}

function maskPlate(plate) {
  if (!plate) return '';
  if (!isPrivacyMode) return plate;
  const spaced = formatPlateSpacing(plate);
  const match = spaced.match(/^(\d{2})\s([A-Z])([A-Z]*)\s(\d*)(\d)$/);
  if (match) {
    const city = match[1];
    const firstLetter = match[2];
    const otherLetters = '*'.repeat(match[3].length);
    const firstDigits = '*'.repeat(match[4].length);
    const lastDigit = match[5];
    return `${city} ${firstLetter}${otherLetters} ${firstDigits}${lastDigit}`;
  }
  return spaced.slice(0, 2) + '***' + spaced.slice(-2);
}

function maskEmail(email) {
  if (!email) return '';
  if (!isPrivacyMode) return email;
  const parts = email.split('@');
  if (parts.length !== 2) return '***@***';
  const namePart = parts[0];
  const domainPart = parts[1];
  const maskedName = namePart.length > 2 
    ? namePart.slice(0, 2) + '*'.repeat(namePart.length - 2)
    : namePart[0] + '*';
  return maskedName + '@' + domainPart;
}

function maskTC(tc) {
  if (!tc) return '';
  if (!isPrivacyMode) return tc;
  if (tc.length < 4) return '***********';
  return tc.slice(0, 2) + '*******' + tc.slice(-2);
}

function maskAddress(addr) {
  if (!addr) return '';
  if (!isPrivacyMode) return addr;
  return addr.split(' ').map((word, idx) => {
    if (idx === 0 || idx === 1) {
      return word[0] + '*'.repeat(word.length - 1);
    }
    return '***';
  }).join(' ');
}

function maskAuditDetails(details) {
  if (!details) return '';
  if (!isPrivacyMode) return details;
  let masked = details;
  masked = masked.replace(/\b[1-9]\d{10}\b/g, (match) => {
    return match.slice(0, 2) + '*******' + match.slice(-2);
  });
  masked = masked.replace(/(\+?90\s?)?5\d{2}\s?\d{3}\s?\d{2}\s?\d{2}/g, (match) => {
    return match.slice(0, 6) + '*** ** ' + match.slice(-2);
  });
  masked = masked.replace(/\b\d{2}\s?[A-Z]{1,3}\s?\d{2,4}\b/gi, (match) => {
    return maskPlate(match.toUpperCase().replace(/\s+/g, ''));
  });
  masked = masked.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, (match) => {
    return maskEmail(match);
  });
  const nameSet = new Set();
  allApplications.forEach(app => {
    if (app.full_name) nameSet.add(app.full_name.trim());
    if (app.driver_name) nameSet.add(app.driver_name.trim());
  });
  const sortedNames = Array.from(nameSet).sort((a, b) => b.length - a.length);
  sortedNames.forEach(name => {
    if (name.length > 3) {
      const escaped = name.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      const regex = new RegExp(escaped, 'gi');
      masked = masked.replace(regex, (match) => {
        return match.split(' ').map(w => w[0] + '*'.repeat(w.length - 1)).join(' ');
      });
    }
  });
  return masked;
}

function togglePrivacyMode() {
  isPrivacyMode = !isPrivacyMode;
  localStorage.setItem('privacy_mode', isPrivacyMode);
  updatePrivacyIcon();
  
  // Refresh UI Components
  applyFilters();
  renderExpirationsDashboard();
  if (typeof filterAuditLogs === 'function') {
    filterAuditLogs();
  }
  if (currentAppId) {
    const drawer = document.getElementById('drawer-overlay');
    if (drawer && drawer.classList.contains('active')) {
      openDrawer(currentAppId);
    }
  }
}

function updatePrivacyIcon() {
  const icon = document.getElementById('privacy-icon');
  const btn = document.getElementById('btn-toggle-privacy');
  if (!icon || !btn) return;
  
  if (isPrivacyMode) {
    icon.setAttribute('data-lucide', 'eye-off');
    btn.setAttribute('title', 'Gizlilik Modunu Kapat');
    btn.style.color = '#ef4444';
    btn.style.borderColor = 'rgba(239, 68, 68, 0.2)';
    btn.style.background = 'rgba(239, 68, 68, 0.03)';
  } else {
    icon.setAttribute('data-lucide', 'eye');
    btn.setAttribute('title', 'Gizlilik Modunu Aç');
    btn.style.color = 'var(--color-primary)';
    btn.style.borderColor = 'rgba(15, 59, 162, 0.2)';
    btn.style.background = 'rgba(15, 59, 162, 0.03)';
  }
  
  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }
}

window.togglePrivacyMode = togglePrivacyMode;
window.updatePrivacyIcon = updatePrivacyIcon;

// Two-Factor Authentication temporary username storage
let temp2FAUsername = null;
let otpTimerInterval = null;

async function handleAdminLogin(event) {
  if (event) event.preventDefault();

  const usernameInput = document.getElementById('login-username');
  const passwordInput = document.getElementById('login-password');
  const errorMsg = document.getElementById('login-error-msg');

  if (!usernameInput || !passwordInput) return;

  const username = usernameInput.value.trim();
  const password = passwordInput.value;

  if (errorMsg) errorMsg.style.display = 'none';

  const turnstileResponse = document.getElementsByName('cf-turnstile-response')[0]?.value;
  if (!turnstileResponse) {
    if (errorMsg) {
      errorMsg.textContent = "Lütfen güvenlik doğrulamasını (Turnstile) tamamlayın.";
      errorMsg.style.display = 'block';
    }
    return;
  }

  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, turnstileResponse })
    });

    if (!res.ok) {
      if (typeof turnstile !== 'undefined') turnstile.reset();
      const data = await res.json();
      throw new Error(data.error || "Giriş başarısız.");
    }

    const data = await res.json();
    
    // Check if Two-Factor Authentication is required
    if (data.twoFactorRequired) {
      temp2FAUsername = data.username;
      
      const credentialsBlock = document.getElementById('login-credentials-block');
      const twoFactorBlock = document.getElementById('login-2fa-block');
      
      if (credentialsBlock) credentialsBlock.style.display = 'none';
      if (twoFactorBlock) twoFactorBlock.style.display = 'block';

      // Hide or show backup buttons based on active channels and admin data
      const resendWhatsappBtn = document.getElementById('btn-resend-otp-whatsapp');
      const resendSmsBtn = document.getElementById('btn-resend-otp-sms');
      if (resendWhatsappBtn) {
        resendWhatsappBtn.style.display = data.has_whatsapp ? 'inline-block' : 'none';
      }
      if (resendSmsBtn) {
        resendSmsBtn.style.display = data.has_sms ? 'inline-block' : 'none';
      }

      // Set description text to email first since it's automatically sent first
      const descEl = document.getElementById('login-2fa-description');
      if (descEl) {
        descEl.textContent = 'E-posta adresinize gönderilen 6 haneli güvenlik kodunu giriniz.';
      }

      // Mask details display (prioritizing email since it's first automatically)
      const maskedPhoneEl = document.getElementById('login-2fa-masked-phone');
      if (maskedPhoneEl) {
        const span = maskedPhoneEl.querySelector('span');
        const icon = maskedPhoneEl.querySelector('i');
        if (data.email_masked) {
          span.textContent = data.email_masked;
          if (icon) {
            icon.setAttribute('data-lucide', 'mail');
            icon.style.color = '#3b82f6';
            icon.style.fill = 'rgba(59, 130, 246, 0.1)';
          }
        } else if (data.phone_masked) {
          span.textContent = data.phone_masked;
          if (icon) {
            icon.setAttribute('data-lucide', 'message-square');
            icon.style.color = '#16a34a';
            icon.style.fill = 'rgba(22, 163, 74, 0.1)';
          }
        } else {
          span.textContent = 'Doğrulama Kanalı';
        }
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }

      // Reset OTP UI states
      const otpInput = document.getElementById('login-otp-code');
      if (otpInput) {
        otpInput.value = '';
        otpInput.focus();
      }
      const twoFactorError = document.getElementById('login-2fa-error-msg');
      const twoFactorSuccess = document.getElementById('login-2fa-success-msg');
      if (twoFactorError) twoFactorError.style.display = 'none';
      if (twoFactorSuccess) twoFactorSuccess.style.display = 'none';

      start2FACountdown();

      return;
    }
    
    // Save to localStorage
    localStorage.setItem('parkexpert_token', data.token);
    localStorage.setItem('parkexpert_user', JSON.stringify(data.user));
    localStorage.setItem('parkexpert_current_admin', data.user.id);
    
    // Hide overlay
    const overlay = document.getElementById('modal-login-overlay');
    if (overlay) overlay.style.display = 'none';

    // Clear form
    usernameInput.value = '';
    passwordInput.value = '';

    // Initialize controller and fetch
    initAdminController();

  } catch (err) {
    if (typeof turnstile !== 'undefined') turnstile.reset();
    if (errorMsg) {
      errorMsg.textContent = err.message;
      errorMsg.style.display = 'block';
    }
  }
}

async function verifyAdminOTP(event) {
  if (event) event.preventDefault();

  const otpInput = document.getElementById('login-otp-code');
  const errorMsg = document.getElementById('login-2fa-error-msg');
  const successMsg = document.getElementById('login-2fa-success-msg');

  if (!otpInput || !temp2FAUsername) return;

  const otpCode = otpInput.value.trim();
  if (errorMsg) errorMsg.style.display = 'none';
  if (successMsg) successMsg.style.display = 'none';

  try {
    const res = await fetch("/api/verify_otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: temp2FAUsername, otp_code: otpCode })
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Doğrulama başarısız.");
    }

    const data = await res.json();

    // Save to localStorage
    localStorage.setItem('parkexpert_token', data.token);
    localStorage.setItem('parkexpert_user', JSON.stringify(data.user));
    localStorage.setItem('parkexpert_current_admin', data.user.id);

    // Clear OTP countdown timer
    if (otpTimerInterval) {
      clearInterval(otpTimerInterval);
      otpTimerInterval = null;
    }

    // Hide overlay
    const overlay = document.getElementById('modal-login-overlay');
    if (overlay) overlay.style.display = 'none';

    // Clear and reset blocks
    otpInput.value = '';
    const credentialsBlock = document.getElementById('login-credentials-block');
    const twoFactorBlock = document.getElementById('login-2fa-block');
    if (credentialsBlock) credentialsBlock.style.display = 'block';
    if (twoFactorBlock) twoFactorBlock.style.display = 'none';

    // Reset login inputs
    const usernameInput = document.getElementById('login-username');
    const passwordInput = document.getElementById('login-password');
    if (usernameInput) usernameInput.value = '';
    if (passwordInput) passwordInput.value = '';

    temp2FAUsername = null;

    // Initialize controller and fetch
    initAdminController();

  } catch (err) {
    if (errorMsg) {
      errorMsg.textContent = err.message;
      errorMsg.style.display = 'block';
    }
  }
}

async function sendOTPChannel(channel) {
  const errorMsg = document.getElementById('login-2fa-error-msg');
  const successMsg = document.getElementById('login-2fa-success-msg');
  const resendWhatsappBtn = document.getElementById('btn-resend-otp-whatsapp');
  const resendSmsBtn = document.getElementById('btn-resend-otp-sms');

  if (!temp2FAUsername) return;

  if (errorMsg) errorMsg.style.display = 'none';
  if (successMsg) successMsg.style.display = 'none';

  const activeBtn = channel === 'whatsapp' ? resendWhatsappBtn : resendSmsBtn;
  let originalHTML = '';
  if (activeBtn) {
    originalHTML = activeBtn.innerHTML;
    activeBtn.disabled = true;
    activeBtn.textContent = 'Gönderiliyor...';
  }

  try {
    const res = await fetch("/api/send_otp_channel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: temp2FAUsername, channel })
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Kod gönderimi başarısız oldu.");
    }

    const data = await res.json();

    if (successMsg) {
      if (channel === 'whatsapp') {
        successMsg.textContent = `Güvenlik kodu ${data.phone_masked} numaralı WhatsApp hattınıza gönderildi.`;
      } else {
        successMsg.textContent = `Güvenlik kodu ${data.phone_masked} numaralı telefonunuza SMS olarak gönderildi.`;
      }
      successMsg.style.display = 'block';
    }

    // Mask details display update
    const maskedPhoneEl = document.getElementById('login-2fa-masked-phone');
    if (maskedPhoneEl && data.phone_masked) {
      const span = maskedPhoneEl.querySelector('span');
      const icon = maskedPhoneEl.querySelector('i');
      span.textContent = data.phone_masked;
      if (icon) {
        if (channel === 'whatsapp') {
          icon.setAttribute('data-lucide', 'message-square');
          icon.style.color = '#16a34a';
          icon.style.fill = 'rgba(22, 163, 74, 0.1)';
        } else {
          icon.setAttribute('data-lucide', 'smartphone');
          icon.style.color = '#f97316';
          icon.style.fill = 'rgba(249, 115, 22, 0.15)';
        }
      }
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }

    const descEl = document.getElementById('login-2fa-description');
    if (descEl) {
      if (channel === 'whatsapp') {
        descEl.textContent = 'WhatsApp numaranıza gönderilen 6 haneli güvenlik kodunu giriniz.';
      } else if (channel === 'sms') {
        descEl.textContent = 'Telefonunuza SMS olarak gönderilen 6 haneli güvenlik kodunu giriniz.';
      }
    }

    start2FACountdown();

  } catch (err) {
    if (errorMsg) {
      errorMsg.textContent = err.message;
      errorMsg.style.display = 'block';
    }
  } finally {
    if (activeBtn) {
      activeBtn.disabled = false;
      activeBtn.innerHTML = originalHTML;
    }
  }
}

function cancel2FA() {
  if (otpTimerInterval) {
    clearInterval(otpTimerInterval);
    otpTimerInterval = null;
  }
  temp2FAUsername = null;
  const credentialsBlock = document.getElementById('login-credentials-block');
  const twoFactorBlock = document.getElementById('login-2fa-block');
  if (credentialsBlock) credentialsBlock.style.display = 'block';
  if (twoFactorBlock) twoFactorBlock.style.display = 'none';

  const otpInput = document.getElementById('login-otp-code');
  if (otpInput) {
    otpInput.value = '';
    otpInput.removeAttribute('disabled');
    otpInput.style.backgroundColor = '';
  }

  const submitBtn = document.querySelector('#admin-2fa-form button[type="submit"]');
  if (submitBtn) {
    submitBtn.removeAttribute('disabled');
  }

  const twoFactorError = document.getElementById('login-2fa-error-msg');
  const twoFactorSuccess = document.getElementById('login-2fa-success-msg');
  if (twoFactorError) twoFactorError.style.display = 'none';
  if (twoFactorSuccess) twoFactorSuccess.style.display = 'none';
}

function start2FACountdown() {
  if (otpTimerInterval) {
    clearInterval(otpTimerInterval);
  }

  const timerEl = document.getElementById('login-2fa-timer');
  const otpInput = document.getElementById('login-otp-code');
  const submitBtn = document.querySelector('#admin-2fa-form button[type="submit"]');

  // Reactivate elements in case they were disabled from previous timeout
  if (otpInput) {
    otpInput.removeAttribute('disabled');
    otpInput.style.backgroundColor = '';
  }
  if (submitBtn) {
    submitBtn.removeAttribute('disabled');
  }

  let secondsLeft = 300; // 5 minutes

  const updateTimerDisplay = () => {
    if (!timerEl) return;
    const minutes = Math.floor(secondsLeft / 60);
    const secs = secondsLeft % 60;
    const minutesStr = String(minutes).padStart(2, '0');
    const secsStr = String(secs).padStart(2, '0');
    timerEl.textContent = `Kalan Süre: ${minutesStr}:${secsStr}`;
    timerEl.style.color = secondsLeft <= 30 ? '#ef4444' : '#64748b'; // red color for last 30 seconds
  };

  updateTimerDisplay();

  otpTimerInterval = setInterval(() => {
    secondsLeft--;
    updateTimerDisplay();

    if (secondsLeft <= 0) {
      clearInterval(otpTimerInterval);
      otpTimerInterval = null;

      if (timerEl) {
        timerEl.textContent = "Güvenlik kodunun süresi doldu! Geri dönüp tekrar giriş yapın.";
        timerEl.style.color = '#ef4444';
      }

      // Disable inputs
      if (otpInput) {
        otpInput.setAttribute('disabled', 'true');
        otpInput.value = '';
        otpInput.style.backgroundColor = '#f1f5f9';
      }
      if (submitBtn) {
        submitBtn.setAttribute('disabled', 'true');
      }
    }
  }, 1000);
}

window.verifyAdminOTP = verifyAdminOTP;
window.sendOTPChannel = sendOTPChannel;
window.cancel2FA = cancel2FA;

async function handleAdminLogout(reason = 'user') {
  if (window.sessionCountdownInterval) {
    clearInterval(window.sessionCountdownInterval);
  }
  if (window.heartbeatInterval) {
    clearInterval(window.heartbeatInterval);
  }
  const token = localStorage.getItem('parkexpert_token');
  if (token) {
    try {
      await fetch('/api/logout', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ reason })
      });
    } catch (e) {
      console.error("Logout request failed:", e);
    }
  }
  localStorage.removeItem('parkexpert_token');
  localStorage.removeItem('parkexpert_user');
  localStorage.removeItem('parkexpert_current_admin');
  
  // Reload page to show login screen
  location.reload();
}

window.handleAdminLogout = handleAdminLogout;

async function initAdminController() {
  const token = localStorage.getItem('parkexpert_token');
  const overlay = document.getElementById('modal-login-overlay');

  const adminLayout = document.querySelector('.admin-layout');

  if (!token || isTokenExpired(token)) {
    localStorage.removeItem('parkexpert_token');
    localStorage.removeItem('parkexpert_user');
    localStorage.removeItem('parkexpert_current_admin');
    
    if (overlay) overlay.style.display = 'flex';
    if (adminLayout) adminLayout.style.display = 'none';
    return;
  }

  if (overlay) overlay.style.display = 'none';
  if (adminLayout) adminLayout.style.display = 'flex';

  // Start active session countdown timer
  startSessionCountdown();

  // Initialize inactivity auto-logout timer
  initInactivityTimer();

  // Start heartbeat updates
  startHeartbeatTimer();

  // Always enable Privacy Mode by default on fresh session / login
  isPrivacyMode = true;
  localStorage.setItem('privacy_mode', 'true');
  updatePrivacyIcon();

  // Load otoparks from server
  await loadOtoparks();

  // Populate active admin user selector in header
  populateActiveUserSelect().then(() => {
    // Configure screen visibility and initial filters based on loaded admin
    handleUserRoleChange();
  });

  // Attach Turkish auto-uppercase listeners for otopark edit modal fields
  const uppercaseOtoparkIds = [
    'edit-otopark-name',
    'edit-otopark-title',
    'edit-otopark-tax-office',
    'edit-otopark-bank',
    'edit-otopark-price-emp',
    'edit-otopark-price-ext'
  ];

  uppercaseOtoparkIds.forEach(id => {
    const input = document.getElementById(id);
    if (input) {
      input.addEventListener('input', (e) => {
        const start = e.target.selectionStart;
        const end = e.target.selectionEnd;
        e.target.value = e.target.value.toLocaleUpperCase('tr-TR');
        e.target.setSelectionRange(start, end);
      });
    }
  });

  const ibanInput = document.getElementById('edit-otopark-iban');
  if (ibanInput) {
    ibanInput.addEventListener('input', (e) => {
      e.target.value = e.target.value.toUpperCase();
    });
  }

  // Initialize admin password policy
  initAdminPasswordPolicy();

  // Start sidebar ping simulation
  startSidebarPingSimulation();
}

function startSidebarPingSimulation() {
  const pingEl = document.getElementById('sidebar-ping-val');
  if (!pingEl) return;
  if (window.sidebarPingInterval) clearInterval(window.sidebarPingInterval);
  window.sidebarPingInterval = setInterval(() => {
    const randomPing = Math.floor(6 + Math.random() * 12);
    pingEl.textContent = `${randomPing} ms`;
  }, 4000);
}

function initAdminPasswordPolicy() {
  const passInput = document.getElementById('edit-admin-password');
  const rulesContainer = document.getElementById('admin-password-rules');
  if (!passInput || !rulesContainer) return;

  const ruleLength = document.getElementById('rule-length');
  const ruleUpper = document.getElementById('rule-upper');
  const ruleLower = document.getElementById('rule-lower');
  const ruleDigit = document.getElementById('rule-digit');
  const ruleSpecial = document.getElementById('rule-special');

  function updateRule(element, isValid) {
    if (!element) return;
    const icon = element.querySelector('.rule-icon');
    if (isValid) {
      element.style.color = 'var(--color-status-approved-text)';
      if (icon) icon.textContent = '✅';
    } else {
      element.style.color = 'var(--color-status-rejected-text)';
      if (icon) icon.textContent = '❌';
    }
  }

  function validateInput() {
    const val = passInput.value;
    
    // If empty and not required (i.e. editing existing user), hide rules.
    if (!val && !passInput.required) {
      rulesContainer.style.display = 'none';
      return;
    }

    rulesContainer.style.display = 'block';

    const hasLength = val.length >= 8;
    const hasUpper = /[A-Z]/.test(val);
    const hasLower = /[a-z]/.test(val);
    const hasDigit = /[0-9]/.test(val);
    const hasSpecial = /[^A-Za-z0-9]/.test(val);

    updateRule(ruleLength, hasLength);
    updateRule(ruleUpper, hasUpper);
    updateRule(ruleLower, hasLower);
    updateRule(ruleDigit, hasDigit);
    updateRule(ruleSpecial, hasSpecial);
  }

  passInput.addEventListener('focus', () => {
    rulesContainer.style.display = 'block';
    validateInput();
  });

  passInput.addEventListener('input', validateInput);

  passInput.addEventListener('blur', () => {
    if (!passInput.value && !passInput.required) {
      rulesContainer.style.display = 'none';
    }
  });
}

let liveTrackingInterval = null;
const trackedAppIds = new Set();
let isInitialLoad = true;

async function loadApplications() {
  const token = localStorage.getItem('parkexpert_token');
  if (!token) return;

  try {
    const response = await fetch(`/api/applications?_t=${Date.now()}`, {
      headers: {
        "Authorization": `Bearer ${token}`
      }
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        const adminLayout = document.querySelector('.admin-layout');
        const overlay = document.getElementById('modal-login-overlay');
        if (adminLayout) adminLayout.style.display = 'none';
        if (overlay) overlay.style.display = 'flex';
        
        alert("Oturumunuz sonlandırıldı veya geçersiz. Lütfen tekrar giriş yapın.");
        handleAdminLogout();
        return;
      }
      const errData = await response.json();
      throw new Error(errData.error || "Could not load applications");
    }
    allApplications = await response.json();
    
    // Track current IDs for live alerts
    allApplications.forEach(app => {
      if (!trackedAppIds.has(app.id)) {
        trackedAppIds.add(app.id);
      }
    });
    
    if (isInitialLoad) {
      isInitialLoad = false;
      // Start live tracking after the initial load completes
      startLiveTracking();
      initBrowserNotifications();
    }
    
    // Map database properties to frontend compatibility structure
    allApplications.forEach(app => {
      app.plate = app.plate_number;
      app.files = {
        ruhsat: app.ruhsat_url,
        kimlik: app.kimlik_url,
        vergi: app.vergi_url || '',
        calisma: app.calisma_url || '',
        dekont: app.dekont_url,
        sirkuler: app.sirkuler_url || ''
      };
      
      const isSermaye = app.subscription_type === 'Kurumsal (LTD. / A.Ş.)';
      const isSahis = app.subscription_type === 'Kurumsal (Şahıs Şirketi)';
      const companyType = isSermaye ? 'sermaye' : (isSahis ? 'sahis' : 'bireysel');
      
      app.billing = {
        company_type: companyType,
        company: app.company_name || app.full_name,
        tax_office: app.tax_office || '',
        tax_no: app.tax_number || app.tc_no,
        address: app.home_address || ''
      };
    });
  } catch (err) {
    console.error("Failed to load applications:", err);
    alert("Başvurular yüklenirken hata oluştu:\n\n" + err.message);
    allApplications = [];
  }
  
  filteredApplications = [...allApplications];
  populateCompanyFilter();
  applyFilters();
}

function populateCompanyFilter() {
  const filterCompany = document.getElementById('filter-company');
  if (!filterCompany) return;
  
  const currentVal = filterCompany.value;
  filterCompany.innerHTML = '<option value="">Tüm Firmalar</option>';
  
  // Get unique companies from allApplications
  const companies = [...new Set(allApplications.map(app => app.company_name).filter(Boolean))];
  companies.sort((a, b) => a.localeCompare(b, 'tr'));
  
  companies.forEach(company => {
    const opt = document.createElement('option');
    opt.value = company;
    opt.textContent = company;
    filterCompany.appendChild(opt);
  });
  
  filterCompany.value = currentVal;
}

function renderTable(apps) {
  const tbody = document.getElementById('table-body');
  const countEl = document.getElementById('table-results-count');
  
  if (!tbody) return;
  tbody.innerHTML = '';
  
  if (countEl) {
    countEl.textContent = `(${apps.length} sonuç)`;
  }

  if (apps.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; padding: 4.5rem 2rem; background: #ffffff;">
          <div class="empty-state-container" style="max-width: 420px; margin: 0 auto; display: flex; flex-direction: column; align-items: center; justify-content: center;">
            <div class="empty-state-icon" style="width: 70px; height: 70px; background: rgba(15, 59, 162, 0.05); border: 1px solid rgba(15, 59, 162, 0.1); border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--color-primary); margin-bottom: 1.25rem; box-shadow: var(--shadow-sm); animation: pulse 2s infinite ease-in-out;">
              <i data-lucide="inbox" style="width: 32px; height: 32px;"></i>
            </div>
            <h3 style="font-size: 1.1rem; font-weight: 700; color: var(--color-primary-dark); margin: 0 0 0.5rem 0;">Şu Anda Aktif Başvuru Bulunmamaktadır</h3>
            <p style="font-size: 0.85rem; color: var(--color-text-muted); line-height: 1.6; margin: 0 0 1.5rem 0; text-align: center;">
              Sistemde listelenecek abonelik başvurusu bulunmuyor. Yeni başvurular yapıldıkça bu panelde anlık olarak görüntülenecektir.
            </p>
            <a href="basvuru.html" class="btn btn-primary" style="display: inline-flex; align-items: center; gap: 0.5rem; min-height: 40px; padding: 0.5rem 1.5rem; font-size: 0.825rem; text-decoration: none; border-radius: var(--radius-sm); font-weight: 600;">
              <i data-lucide="plus-circle" style="width: 16px; height: 16px;"></i>
              <span>Yeni Test Başvurusu Yap</span>
            </a>
          </div>
        </td>
      </tr>
    `;
    if (typeof lucide !== 'undefined') lucide.createIcons();
    return;
  }

  apps.forEach(app => {
    const tr = document.createElement('tr');
    tr.id = `row-${app.id}`;
    
    // Status Badge classes
    let statusClass = 'status-yeni';
    if (app.status === 'İnceleniyor') statusClass = 'status-inceleniyor';
    if (app.status === 'Onaylandı') statusClass = 'status-onaylandi';
    if (app.status === 'Reddedildi') statusClass = 'status-reddedildi';

    // Format Plaka beautifully (masked if privacy mode is ON)
    const plateFormatted = maskPlate(app.plate);

    const approval = app.management_approval || 'Beklemede';
    let approvalHtml = '';
    if (approval === 'Beklemede') {
      approvalHtml = `
        <div style="margin-top: 0.35rem; display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.7rem; font-weight: 700; color: #b45309; background: rgba(245, 158, 11, 0.08); padding: 0.15rem 0.4rem; border-radius: 4px; border: 1px solid rgba(245, 158, 11, 0.15); width: fit-content; text-transform: uppercase;">
          <i data-lucide="alert-triangle" style="width: 10px; height: 10px; color: #d97706;"></i>
          <span>Yönetim Onayında</span>
        </div>
      `;
    } else if (approval === 'İzin Verildi') {
      approvalHtml = `
        <div style="margin-top: 0.35rem; display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.7rem; font-weight: 700; color: #15803d; background: rgba(16, 185, 129, 0.08); padding: 0.15rem 0.4rem; border-radius: 4px; border: 1px solid rgba(16, 185, 129, 0.15); width: fit-content; text-transform: uppercase;">
          <i data-lucide="check-circle" style="width: 10px; height: 10px; color: #16a34a;"></i>
          <span>Yönetim İzin Verdi</span>
        </div>
      `;
    } else {
      approvalHtml = `
        <div style="margin-top: 0.35rem; display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.7rem; font-weight: 700; color: #b91c1c; background: rgba(239, 68, 68, 0.08); padding: 0.15rem 0.4rem; border-radius: 4px; border: 1px solid rgba(239, 68, 68, 0.15); width: fit-content; text-transform: uppercase;">
          <i data-lucide="x-circle" style="width: 10px; height: 10px; color: #dc2626;"></i>
          <span>Yönetim Reddetti</span>
        </div>
      `;
    }

    tr.innerHTML = `
      <td style="font-weight: 700; color: var(--color-primary-dark);">${app.id}</td>
      <td>
        <div class="col-customer">
          <span class="customer-name" style="font-weight: 700; color: var(--color-text-dark);">${maskName(app.full_name)}</span>
          <span class="customer-details" style="margin: 0.3rem 0 0.4rem 0; display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.725rem; font-weight: 700; color: var(--color-primary-dark); background: rgba(15, 59, 162, 0.06); padding: 0.25rem 0.55rem; border-radius: var(--radius-sm); border: 1px solid rgba(15, 59, 162, 0.12); width: fit-content; text-transform: uppercase; letter-spacing: 0.02em;">
            <i data-lucide="building-2" style="width: 12px; height: 12px; color: var(--color-primary);"></i>
            <span>${app.company_name || 'SERBEST ÇALIŞAN'}</span>
          </span>
          <span class="customer-details" style="display: block; font-size: 0.75rem; color: var(--color-text-muted);">${app.subscription_type} &bull; ${maskPhone(app.phone)}</span>
        </div>
      </td>
      <td><span class="col-plate">${plateFormatted}</span></td>
      <td><span class="col-otopark">${app.parking_location}</span></td>
      <td>${formatDateTR(app.created_at || app.date_applied)}</td>
      <td>${app.subscription_expires_at ? formatDateShortTR(app.subscription_expires_at) : '<span style="color:var(--color-text-muted);font-style:italic;font-size:0.85rem;">Belirtilmemiş</span>'}</td>
      <td style="display: flex; flex-direction: column; gap: 0.25rem;"><span class="status-badge ${statusClass}">${app.status}</span>${approvalHtml}</td>
      <td style="text-align: center;">
        <button class="btn-table-action" onclick="openDrawer('${app.id}')" title="Başvuru Detayını Gör">
          <i data-lucide="eye" style="width: 16px; height: 16px;"></i>
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function formatPlateSpacing(plate) {
  // Regex format: 34ABC123 to 34 ABC 123
  const match = plate.match(/^(\d{2})([A-Z]{1,3})(\d{2,4})$/);
  if (match) {
    return `${match[1]} ${match[2]} ${match[3]}`;
  }
  return plate; // fallback
}

function formatDateTR(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return dateStr || '';
  
  if (dateStr.includes('T') || dateStr.includes(':')) {
    try {
      const d = new Date(dateStr);
      if (!isNaN(d.getTime())) {
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        const hours = String(d.getHours()).padStart(2, '0');
        const minutes = String(d.getMinutes()).padStart(2, '0');
        const seconds = String(d.getSeconds()).padStart(2, '0');
        const ms = String(d.getMilliseconds()).padStart(3, '0');
        return `${day}.${month}.${year} ${hours}:${minutes}:${seconds}.${ms}`;
      }
    } catch (e) {
      // fallback
    }
  }

  const pts = dateStr.split('-');
  if (pts.length === 3) {
    const day = pts[2].substring(0, 2);
    return `${day}.${pts[1]}.${pts[0]}`;
  }
  return dateStr;
}

function formatDateShortTR(dateStr) {
  if (!dateStr) return '';
  if (typeof dateStr !== 'string') return dateStr;
  
  if (dateStr.includes('T') || dateStr.includes(':')) {
    try {
      const d = new Date(dateStr);
      if (!isNaN(d.getTime())) {
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        return `${day}.${month}.${year}`;
      }
    } catch (e) {
      // fallback
    }
  }

  const pts = dateStr.split('-');
  if (pts.length === 3) {
    const day = pts[2].substring(0, 2);
    return `${day}.${pts[1]}.${pts[0]}`;
  }
  return dateStr;
}

function applyFilters() {
  const query = document.getElementById('search-query').value.toLowerCase().trim();
  const location = document.getElementById('filter-location').value;
  const company = document.getElementById('filter-company')?.value;
  const status = document.getElementById('filter-status').value;
  const dateVal = document.getElementById('filter-date').value;

  filteredApplications = allApplications.filter(app => {
    // 1. Text search match (plate, name, phone, email, appCode)
    const matchesQuery = !query || 
      app.full_name.toLowerCase().includes(query) ||
      app.plate.toLowerCase().includes(query) ||
      app.phone.includes(query) ||
      app.id.toLowerCase().includes(query) ||
      app.email.toLowerCase().includes(query) ||
      (app.company_name && app.company_name.toLowerCase().includes(query));

    // 2. Location match
    const matchesLocation = !location || app.parking_location === location;

    // 3. Company match
    const matchesCompany = !company || app.company_name === company;

    // 4. Status match (Map 'Yeni' filter selection to 'Beklemede' DB value)
    const matchesStatus = !status || app.status === status || (status === 'Yeni' && app.status === 'Beklemede');

    // 5. Date match
    let matchesDate = true;
    if (dateVal) {
      const dateToCompare = app.created_at || app.date_applied;
      if (dateToCompare) {
        if (dateToCompare.includes('T') || dateToCompare.includes(':')) {
          const localDate = new Date(dateToCompare);
          if (!isNaN(localDate.getTime())) {
            const localYear = localDate.getFullYear();
            const localMonth = String(localDate.getMonth() + 1).padStart(2, '0');
            const localDay = String(localDate.getDate()).padStart(2, '0');
            const localDateStr = `${localYear}-${localMonth}-${localDay}`;
            matchesDate = localDateStr === dateVal;
          } else {
            matchesDate = dateToCompare.startsWith(dateVal);
          }
        } else {
          matchesDate = dateToCompare.startsWith(dateVal);
        }
      } else {
        matchesDate = false;
      }
    }

    return matchesQuery && matchesLocation && matchesCompany && matchesStatus && matchesDate;
  });

  // Re-render
  renderTable(filteredApplications);
  renderCompaniesTable(filteredApplications);
  
  if (currentAdminTab === 'analytics') {
    updateAnalyticsCharts(filteredApplications);
  }
  
  // Recalculate and update metrics
  updateMetrics(allApplications);
}

function updateMetrics(apps) {
  const total = apps.length;
  const pendingApps = apps.filter(a => a.status === 'Yeni' || a.status === 'Beklemede');
  const countNew = pendingApps.length;
  const countApproved = apps.filter(a => a.status === 'Onaylandı').length;
  const countRejected = apps.filter(a => a.status === 'Reddedildi').length;

  const countYonetim = pendingApps.filter(a => a.management_approval === 'Beklemede').length;
  const countOperator = pendingApps.filter(a => a.management_approval === 'İzin Verildi' || !a.management_approval).length;

  document.getElementById('stats-total').textContent = total;
  document.getElementById('stats-new').textContent = countNew;
  document.getElementById('stats-approved').textContent = countApproved;
  document.getElementById('stats-rejected').textContent = countRejected;

  const elYonetim = document.getElementById('stats-new-yonetim');
  const elOperator = document.getElementById('stats-new-operator');
  if (elYonetim) elYonetim.textContent = countYonetim;
  if (elOperator) elOperator.textContent = countOperator;
}

/* ==========================================================================
   ADMIN DETAILS DRAWER (SLIDE-OVER PANEL)
   ========================================================================== */

function openDrawer(appId) {
  currentAppId = appId;
  const app = allApplications.find(a => a.id === appId);
  if (!app) return;

  const drawer = document.getElementById('drawer-overlay');
  const drawerBody = document.getElementById('drawer-body-content');
  const drawerTitle = document.getElementById('drawer-title');

  if (!drawer || !drawerBody) return;

  // Set Title
  drawerTitle.textContent = `Detay: ${app.id}`;

  // Build Body Content
  let statusBadgeClass = 'status-yeni';
  if (app.status === 'İnceleniyor') statusBadgeClass = 'status-inceleniyor';
  if (app.status === 'Onaylandı') statusBadgeClass = 'status-onaylandi';
  if (app.status === 'Reddedildi') statusBadgeClass = 'status-reddedildi';

  // Construct files layout with explicit document type headers/labels
  let documentsHtml = '';
  
  if (app.files.ruhsat) {
    documentsHtml += `
    <div class="doc-card" style="display: flex; flex-direction: column; justify-content: space-between; min-height: 140px; padding: 1rem 0.8rem; background-color: var(--color-bg-light);">
      <div style="font-size: 0.65rem; font-weight: 800; color: var(--color-accent-orange); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.75rem; border-bottom: 1px solid rgba(249, 115, 22, 0.15); padding-bottom: 0.25rem;">🚗 Ruhsat Belgesi</div>
      <i data-lucide="file-text" class="doc-icon" style="width: 20px; height: 20px; margin: 0 auto 0.5rem auto; color: var(--color-accent-orange);"></i>
      <div class="doc-title" style="margin-bottom: 0.5rem;">${app.files.ruhsat.split('/').pop()}</div>
      <span class="doc-preview-link" onclick="openDocPreview('Ruhsat Belgesi', '${app.files.ruhsat}')" style="margin-top: auto; display: inline-flex; align-items: center; justify-content: center; gap: 0.25rem;">
        <i data-lucide="zoom-in" style="width: 12px; height: 12px;"></i> Önizle
      </span>
    </div>`;
  }
  
  if (app.files.kimlik) {
    documentsHtml += `
    <div class="doc-card" style="display: flex; flex-direction: column; justify-content: space-between; min-height: 140px; padding: 1rem 0.8rem; background-color: var(--color-bg-light);">
      <div style="font-size: 0.65rem; font-weight: 800; color: var(--color-accent-orange); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.75rem; border-bottom: 1px solid rgba(249, 115, 22, 0.15); padding-bottom: 0.25rem;">🆔 Kimlik / Ehliyet</div>
      <i data-lucide="file-text" class="doc-icon" style="width: 20px; height: 20px; margin: 0 auto 0.5rem auto; color: var(--color-accent-orange);"></i>
      <div class="doc-title" style="margin-bottom: 0.5rem;">${app.files.kimlik.split('/').pop()}</div>
      <span class="doc-preview-link" onclick="openDocPreview('Kimlik / Ehliyet', '${app.files.kimlik}')" style="margin-top: auto; display: inline-flex; align-items: center; justify-content: center; gap: 0.25rem;">
        <i data-lucide="zoom-in" style="width: 12px; height: 12px;"></i> Önizle
      </span>
    </div>`;
  }

  if (app.files.vergi) {
    documentsHtml += `
    <div class="doc-card" style="display: flex; flex-direction: column; justify-content: space-between; min-height: 140px; padding: 1rem 0.8rem; background-color: var(--color-bg-light);">
      <div style="font-size: 0.65rem; font-weight: 800; color: var(--color-accent-orange); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.75rem; border-bottom: 1px solid rgba(249, 115, 22, 0.15); padding-bottom: 0.25rem;">🏢 Vergi Levhası</div>
      <i data-lucide="file-text" class="doc-icon" style="width: 20px; height: 20px; margin: 0 auto 0.5rem auto; color: var(--color-accent-orange);"></i>
      <div class="doc-title" style="margin-bottom: 0.5rem;">${app.files.vergi.split('/').pop()}</div>
      <span class="doc-preview-link" onclick="openDocPreview('Vergi Levhası', '${app.files.vergi}')" style="margin-top: auto; display: inline-flex; align-items: center; justify-content: center; gap: 0.25rem;">
        <i data-lucide="zoom-in" style="width: 12px; height: 12px;"></i> Önizle
      </span>
    </div>`;
  }

  if (app.files.sirkuler) {
    documentsHtml += `
    <div class="doc-card" style="display: flex; flex-direction: column; justify-content: space-between; min-height: 140px; padding: 1rem 0.8rem; background-color: var(--color-bg-light);">
      <div style="font-size: 0.65rem; font-weight: 800; color: var(--color-accent-orange); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.75rem; border-bottom: 1px solid rgba(249, 115, 22, 0.15); padding-bottom: 0.25rem;">📝 İmza Sirküleri</div>
      <i data-lucide="file-text" class="doc-icon" style="width: 20px; height: 20px; margin: 0 auto 0.5rem auto; color: var(--color-accent-orange);"></i>
      <div class="doc-title" style="margin-bottom: 0.5rem;">${app.files.sirkuler.split('/').pop()}</div>
      <span class="doc-preview-link" onclick="openDocPreview('İmza Sirküleri', '${app.files.sirkuler}')" style="margin-top: auto; display: inline-flex; align-items: center; justify-content: center; gap: 0.25rem;">
        <i data-lucide="zoom-in" style="width: 12px; height: 12px;"></i> Önizle
      </span>
    </div>`;
  }

  if (app.files.calisma) {
    documentsHtml += `
    <div class="doc-card" style="display: flex; flex-direction: column; justify-content: space-between; min-height: 140px; padding: 1rem 0.8rem; background-color: var(--color-bg-light);">
      <div style="font-size: 0.65rem; font-weight: 800; color: var(--color-accent-orange); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.75rem; border-bottom: 1px solid rgba(249, 115, 22, 0.15); padding-bottom: 0.25rem;">📄 Çalışma Belgesi</div>
      <i data-lucide="file-check-2" class="doc-icon" style="width: 20px; height: 20px; margin: 0 auto 0.5rem auto; color: var(--color-accent-orange);"></i>
      <div class="doc-title" style="margin-bottom: 0.5rem;">${app.files.calisma.split('/').pop()}</div>
      <span class="doc-preview-link" onclick="openDocPreview('Çalışma Belgesi', '${app.files.calisma}')" style="margin-top: auto; display: inline-flex; align-items: center; justify-content: center; gap: 0.25rem;">
        <i data-lucide="zoom-in" style="width: 12px; height: 12px;"></i> Önizle
      </span>
    </div>`;
  }

  if (app.files.dekont) {
    documentsHtml += `
    <div class="doc-card" style="border-color: var(--color-primary-light); display: flex; flex-direction: column; justify-content: space-between; min-height: 140px; padding: 1rem 0.8rem; background-color: var(--color-bg-light);">
      <div style="font-size: 0.65rem; font-weight: 800; color: var(--color-primary); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.75rem; border-bottom: 1px solid rgba(15, 59, 162, 0.15); padding-bottom: 0.25rem;">💳 Ödeme Dekontu</div>
      <i data-lucide="receipt" class="doc-icon" style="color: var(--color-primary); width: 20px; height: 20px; margin: 0 auto 0.5rem auto;"></i>
      <div class="doc-title" style="font-weight: 700; margin-bottom: 0.5rem;">${app.files.dekont.split('/').pop()}</div>
      <span class="doc-preview-link" onclick="openDocPreview('Ödeme Dekontu', '${app.files.dekont}')" style="margin-top: auto; display: inline-flex; align-items: center; justify-content: center; gap: 0.25rem;">
        <i data-lucide="zoom-in" style="width: 12px; height: 12px;"></i> Önizle
      </span>
    </div>`;
  }

  drawerBody.innerHTML = `
    <!-- Detail Section: Status & Type -->
    <div class="detail-section">
      <div class="detail-section-title">Durum & Abonelik Tipi</div>
      <div class="detail-grid">
        <span class="detail-label">Başvuru Durumu:</span>
        <span class="detail-value"><span class="status-badge ${statusBadgeClass}">${app.status}</span></span>
        
        <span class="detail-label">Abonelik Tipi:</span>
        <span class="detail-value">${app.subscription_type}</span>

        <span class="detail-label">Seçilen Konum:</span>
        <span class="detail-value">${app.parking_location}</span>

        <span class="detail-label">Başvuru Tarihi:</span>
        <span class="detail-value">${formatDateTR(app.created_at || app.date_applied)}</span>

        <span class="detail-label">Bitiş Tarihi (Abonelik):</span>
        <span class="detail-value" style="display: flex; align-items: center; gap: 0.5rem;">
          <span id="expiry-date-display-${app.id}">${app.subscription_expires_at ? formatDateShortTR(app.subscription_expires_at) : '<span style="color:var(--color-text-muted);font-style:italic;font-size:0.85rem;">Belirtilmemiş</span>'}</span>
          <button onclick="editSubscriptionExpiry('${app.id}')" class="btn-edit-inline" title="Bitiş Tarihini Düzenle" style="background: none; border: none; cursor: pointer; color: var(--color-primary); display: inline-flex; align-items: center;">
            <i data-lucide="calendar" style="width: 14px; height: 14px;"></i>
          </button>
        </span>
      </div>
    </div>

    <!-- Detail Section: Customer Info -->
    <div class="detail-section">
      <div class="detail-section-title">Müşteri & Şoför Bilgileri</div>
      <div class="detail-grid">
        <span class="detail-label">Firma / Kurum Adı:</span>
        <span class="detail-value" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
          <span style="display: inline-flex; align-items: center; gap: 0.4rem; font-weight: 800; font-size: 0.825rem; color: var(--color-primary-dark); background: rgba(15, 59, 162, 0.08); padding: 0.3rem 0.75rem; border-radius: var(--radius-sm); border: 1px solid rgba(15, 59, 162, 0.15); text-transform: uppercase; letter-spacing: 0.03em;">
            <i data-lucide="building-2" style="width: 14px; height: 14px; color: var(--color-primary);"></i>
            <span>${app.company_name || 'SERBEST ÇALIŞAN'}</span>
          </span>
          <button onclick="changeApplicationCompany('${app.id}')" class="btn-edit-inline" title="Firmayı Düzenle / Aktar" style="background: none; border: none; cursor: pointer; color: var(--color-primary); display: inline-flex; align-items: center;">
            <i data-lucide="shuffle" style="width: 14px; height: 14px;"></i>
          </button>
        </span>

        <span class="detail-label">Başvuru Sahibi:</span>
        <span class="detail-value">${maskName(app.full_name)}</span>

        <span class="detail-label">Şoför Adı:</span>
        <span class="detail-value" style="font-weight: 700;">${maskName(app.driver_name || app.full_name)}</span>

        <span class="detail-label">T.C. Kimlik No:</span>
        <span class="detail-value">${maskTC(app.tc_no)}</span>

        <span class="detail-label">Telefon:</span>
        <span class="detail-value">${maskPhone(app.phone)}</span>

        <span class="detail-label">E-posta:</span>
        <span class="detail-value">${maskEmail(app.email)}</span>

        <span class="detail-label">İşyeri Adresi:</span>
        <span class="detail-value" style="white-space: pre-wrap; font-size: 0.85rem; line-height: 1.4;">${maskAddress(app.home_address || 'Belirtilmedi')}</span>
      </div>
    </div>

    <!-- Detail Section: Vehicle Info -->
    <div class="detail-section">
      <div class="detail-section-title">Araç Bilgileri</div>
      <div class="detail-grid">
        <span class="detail-label">Araç Plakası:</span>
        <span class="detail-value" style="display: flex; align-items: center; gap: 0.5rem;">
          <span class="col-plate">${maskPlate(app.plate)}</span>
          <button onclick="editApplicationPlate('${app.id}')" class="btn-edit-inline" title="Plakayı Düzenle" style="background: none; border: none; cursor: pointer; color: var(--color-primary); display: inline-flex; align-items: center;">
            <i data-lucide="edit-3" style="width: 14px; height: 14px;"></i>
          </button>
        </span>

        <span class="detail-label">Marka / Model:</span>
        <span class="detail-value">${app.car_model}</span>

        <span class="detail-label">Ruhsat Eşleştirme (AI):</span>
        <span class="detail-value" id="ocr-status-container">
          <span style="font-size: 0.8rem; color: var(--color-text-muted); display: inline-flex; align-items: center; gap: 0.4rem;">
            <span class="ocr-spinner"></span> Başlatılıyor...
          </span>
        </span>
      </div>
    </div>

    <!-- Detail Section: Billing Info -->
    <div class="detail-section">
      <div class="detail-section-title">Fatura Bilgileri</div>
      ${app.billing ? `
      <div class="detail-grid">
        <span class="detail-label">${app.billing.company_type === 'sermaye' ? 'Firma Unvanı' : (app.billing.company_type === 'sahis' ? 'Firma Sahibi' : 'Fatura Sahibi')}:</span>
        <span class="detail-value" style="font-weight: 700;">${maskName(app.billing.company)}</span>

        ${app.billing.company_type !== 'bireysel' ? `
        <span class="detail-label">Vergi Dairesi:</span>
        <span class="detail-value">${app.billing.tax_office}</span>
        ` : ''}

        <span class="detail-label">${app.billing.company_type === 'sermaye' ? 'Vergi Numarası' : 'T.C. Kimlik No'}:</span>
        <span class="detail-value">${maskTC(app.billing.tax_no)}</span>

        <span class="detail-label">Fatura Adresi:</span>
        <span class="detail-value" style="white-space: pre-wrap; font-size: 0.85rem; line-height: 1.4;">${maskAddress(app.billing.address)}</span>
      </div>
      ` : `
      <p style="font-size: 0.85rem; color: var(--color-text-muted); font-style: italic; margin: 0;">
        Bu başvuru için ayrı bir kurumsal fatura bilgisi belirtilmemiştir (Bireysel Fatura).
      </p>
      `}
    </div>

    <!-- Detail Section: User Notes -->
    <div class="detail-section">
      <div class="detail-section-title">Başvuru Notu</div>
      <p style="font-size: 0.9rem; color: var(--color-text-dark); background-color: var(--color-bg-light); padding: 0.875rem; border-radius: var(--radius-sm); border: 1px solid var(--color-border-light); font-style: ${app.notes ? 'normal' : 'italic'};">
        ${app.notes ? app.notes : 'Bu başvuru için müşteri not girmemiştir.'}
      </p>
    </div>

    <!-- Detail Section: Documents -->
    <div class="detail-section">
      <div class="detail-section-title">Yüklenen Belgeler</div>
      <div class="doc-viewer-grid">
        ${documentsHtml}
      </div>
    </div>

    <!-- Detail Section: Data Export (Excel Aktarımı) -->
    <div class="detail-section" style="border: 1px solid rgba(15, 59, 162, 0.15); background: rgba(15, 59, 162, 0.02); border-radius: var(--radius-sm); padding: 1.25rem; margin-bottom: 1.25rem;">
      <div class="detail-section-title" style="color: var(--color-primary-dark); display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem;">
        <i data-lucide="download" style="width: 16px; height: 16px; color: var(--color-primary);"></i>
        <span>Excel / Veri Aktarımı</span>
      </div>
      <p style="font-size: 0.8rem; color: var(--color-text-muted); margin-bottom: 1rem; line-height: 1.4;">
        Bu abonenin başvuru kaydını sisteme yüklemek veya arşivlemek için Excel formatında indirebilirsiniz.
      </p>
      <div style="display: flex; gap: 0.75rem; width: 100%;">
        <button onclick="exportSingleApplicationExcel('${app.id}', 'standard')" class="btn" style="flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem; background: #ffffff; color: var(--color-text-dark); border: 1px solid var(--color-border-light); font-size: 0.8rem; padding: 0.6rem 0.75rem; border-radius: var(--radius-sm); font-weight: 700; cursor: pointer; min-height: 38px; box-shadow: var(--shadow-sm); transition: all 0.2s ease;">
          <i data-lucide="file-text" style="width: 14px; height: 14px; color: #10b981;"></i> Standart Excel
        </button>
        <button id="btn-single-parkexpert-export" onclick="exportSingleApplicationExcel('${app.id}', 'parkexpert')" class="btn" style="flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem; background: var(--color-primary); color: var(--color-primary-dark); border: none; font-size: 0.8rem; padding: 0.6rem 0.75rem; border-radius: var(--radius-sm); font-weight: 700; cursor: pointer; min-height: 38px; box-shadow: 0 2px 6px rgba(15, 59, 162, 0.15); transition: all 0.2s ease;">
          <i data-lucide="download-cloud" style="width: 14px; height: 14px;"></i> ParkExpert Excel
        </button>
      </div>
    </div>

    <!-- Detail Section: Sent Notifications (Giden Bildirimler) -->
    <div class="detail-section" style="border: 1px solid rgba(16, 185, 129, 0.15); background: rgba(16, 185, 129, 0.02); border-radius: var(--radius-sm); padding: 1.25rem;">
      <div class="detail-section-title" style="color: #047857; display: flex; align-items: center; gap: 0.5rem;">
        <i data-lucide="bell" style="width: 16px; height: 16px; color: var(--color-accent-gold);"></i>
        <span>Otomatik Bildirim Günlüğü</span>
      </div>
      <p style="font-size: 0.8rem; color: var(--color-text-muted); margin-bottom: 1rem; line-height: 1.4;">
        Başvuru esnasında müşteriye merkez ofis sunucuları üzerinden otomatik olarak iletilen e-posta onayını ve WhatsApp teyit mesajı kayıtlarını buradan inceleyebilirsiniz.
      </p>
      <div style="display: flex; gap: 0.75rem; width: 100%;">
        <button onclick="adminOpenWhatsAppSimulation('${app.id}')" class="btn" style="flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem; background: #25d366; color: #ffffff; border: none; font-size: 0.8rem; padding: 0.6rem 0.75rem; border-radius: var(--radius-sm); font-weight: 700; cursor: pointer; min-height: 38px; box-shadow: 0 2px 6px rgba(37, 211, 102, 0.2); transition: all 0.2s ease;">
          <i data-lucide="message-circle" style="width: 14px; height: 14px; fill: #ffffff;"></i> WhatsApp Bildirimi
        </button>
        <button onclick="adminOpenEmailSimulation('${app.id}')" class="btn" style="flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem; background: var(--color-primary); color: var(--color-primary-dark); border: none; font-size: 0.8rem; padding: 0.6rem 0.75rem; border-radius: var(--radius-sm); font-weight: 700; cursor: pointer; min-height: 38px; box-shadow: 0 2px 6px rgba(15, 59, 162, 0.15); transition: all 0.2s ease;">
          <i data-lucide="mail" style="width: 14px; height: 14px;"></i> E-posta Bildirimi
        </button>
      </div>
    </div>
  `;

  // Update footer actions dynamically based on user role and management approval status
  const footerContainer = document.querySelector('.status-actions-container');
  if (footerContainer) {
    const userJson = localStorage.getItem('parkexpert_user');
    const loggedInUser = userJson ? JSON.parse(userJson) : {};
    const admins = JSON.parse(localStorage.getItem(ADMIN_USERS_KEY)) || [];
    const activeAdminObj = admins.find(a => a.id === currentAdminUser) || loggedInUser;
    const userRole = currentAdminUser === 'superadmin' ? 'superadmin' : (activeAdminObj.role || 'admin');
    const approval = app.management_approval || 'Beklemede';
    
    let footerHtml = '';
    if (userRole === 'yonetim') {
      footerHtml += `<div class="status-actions-title" style="font-weight:700; font-size:0.85rem; color:var(--color-text-dark); margin-bottom:0.75rem;">Yönetim Onay Kararı</div>`;
      if (approval === 'Beklemede') {
        footerHtml += `
          <div class="status-btn-group" style="display: flex; gap: 0.5rem; width: 100%;">
            <button class="status-change-btn btn-set-approve" onclick="updateCurrentManagementApproval('İzin Verildi')" style="flex: 1; min-height: 38px; background: #10b981; border: 1px solid #10b981; color:#ffffff; font-weight:700; border-radius:var(--radius-sm); cursor:pointer; transition: all 0.2s;">İzin Verildi</button>
            <button class="status-change-btn btn-set-reject" onclick="updateCurrentManagementApproval('Reddedildi')" style="flex: 1; min-height: 38px; background: #ef4444; border: 1px solid #ef4444; color:#ffffff; font-weight:700; border-radius:var(--radius-sm); cursor:pointer; transition: all 0.2s;">Reddet</button>
          </div>
        `;
      } else if (approval === 'İzin Verildi') {
        footerHtml += `
          <div style="background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.2); color: #15803d; padding: 0.75rem; border-radius: var(--radius-sm); font-size: 0.85rem; font-weight: 700; text-align: center; display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
            <i data-lucide="check-circle" style="width: 16px; height: 16px; color:#16a34a;"></i>
            <span>Bu başvuruye yönetim izni verildi. İşlem tamamlandı.</span>
          </div>
        `;
      } else {
        footerHtml += `
          <div style="background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.2); color: #b91c1c; padding: 0.75rem; border-radius: var(--radius-sm); font-size: 0.85rem; font-weight: 700; text-align: center; display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
            <i data-lucide="x-circle" style="width: 16px; height: 16px; color:#dc2626;"></i>
            <span>Bu başvuru yönetim tarafından reddedildi.</span>
          </div>
        `;
      }
    } else {
      // Standard admin or superadmin
      footerHtml += `<div class="status-actions-title" style="font-weight:700; font-size:0.85rem; color:var(--color-text-dark); margin-bottom:0.75rem;">Başvuru Durumunu Güncelle</div>`;
      if (approval === 'Beklemede') {
        if (userRole === 'superadmin') {
          footerHtml += `
            <div style="background: rgba(139, 92, 246, 0.08); border: 1px solid rgba(139, 92, 246, 0.2); color: #6d28d9; padding: 0.75rem; border-radius: var(--radius-sm); font-size: 0.85rem; font-weight: 700; text-align: center; margin-bottom: 0.75rem; display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
              <i data-lucide="shield-alert" style="width: 16px; height: 16px; color:#7c3aed;"></i>
              <span>Yönetim onayı bekleniyor. Süper Admin olarak yönetim adına izin verebilirsiniz.</span>
            </div>
            <div class="status-btn-group" style="display: flex; gap: 0.5rem; width: 100%; margin-bottom: 0.75rem;">
              <button class="status-change-btn btn-set-approve" onclick="updateCurrentManagementApproval('İzin Verildi')" style="flex: 1; min-height: 38px; background: #10b981; border: 1px solid #10b981; color:#ffffff; font-weight:700; border-radius:var(--radius-sm); cursor:pointer; transition: all 0.2s;">Yönetim İzni Ver</button>
              <button class="status-change-btn btn-set-reject" onclick="updateCurrentManagementApproval('Reddedildi')" style="flex: 1; min-height: 38px; background: #ef4444; border: 1px solid #ef4444; color:#ffffff; font-weight:700; border-radius:var(--radius-sm); cursor:pointer; transition: all 0.2s;">Yönetim İznini Reddet</button>
            </div>
            <div style="border-top: 1px dashed var(--color-border); margin: 0.75rem 0; padding-top: 0.75rem;">
              <div style="font-size: 0.8rem; color: var(--color-text-muted); margin-bottom: 0.5rem; font-weight: 600;">Operatör Onay İşlemi (Yönetim İzninden Sonra Aktifleşir)</div>
              <div class="status-btn-group" style="display: flex; gap: 0.5rem; width: 100%; opacity: 0.5; pointer-events: none; margin-bottom: 0.5rem;">
                <button class="status-change-btn btn-set-approve" disabled style="flex: 1; min-height: 38px;">Onayla</button>
                <button class="status-change-btn btn-set-reject" disabled style="flex: 1; min-height: 38px;">Reddet</button>
              </div>
              <button class="status-change-btn btn-set-delete" id="btn-drawer-delete" onclick="deleteCurrentApplication()" style="width: 100%; min-height: 38px; background: #dc2626; border: 1px solid #dc2626; color: #ffffff; font-weight: 700; border-radius: var(--radius-sm); cursor: pointer; transition: all var(--transition-fast);">Başvuruyu Tamamen Sil</button>
            </div>
          `;
        } else {
          footerHtml += `
            <div style="background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.2); color: #b45309; padding: 0.75rem; border-radius: var(--radius-sm); font-size: 0.85rem; font-weight: 700; text-align: center; margin-bottom: 0.75rem; display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
              <i data-lucide="alert-triangle" style="width: 16px; height: 16px; color:#d97706;"></i>
              <span>Şu an işlem yapılamaz, yönetim onayı bekleniyor.</span>
            </div>
            <div class="status-btn-group" style="display: flex; gap: 0.5rem; width: 100%; opacity: 0.5; pointer-events: none;">
              <button class="status-change-btn btn-set-approve" disabled style="flex: 1; min-height: 38px;">Onayla</button>
              <button class="status-change-btn btn-set-reject" disabled style="flex: 1; min-height: 38px;">Reddet</button>
            </div>
          `;
        }
      } else if (approval === 'İzin Verildi') {
        footerHtml += `
          <div style="background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.2); color: #15803d; padding: 0.5rem 0.75rem; border-radius: var(--radius-sm); font-size: 0.8rem; font-weight: 700; text-align: center; margin-bottom: 0.75rem; display: flex; align-items: center; justify-content: center; gap: 0.4rem;">
            <i data-lucide="check-circle" style="width: 14px; height: 14px; color:#16a34a;"></i>
            <span>Site / AVM yönetimi bu başvuruya izin verdi.</span>
          </div>
        `;
        if (userRole === 'superadmin') {
          footerHtml += `
            <div style="margin-bottom: 0.75rem;">
              <button class="status-change-btn" onclick="updateCurrentManagementApproval('Beklemede')" style="width: 100%; min-height: 32px; background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.3); color: #b45309; font-weight: 700; font-size: 0.8rem; border-radius: var(--radius-sm); cursor: pointer; transition: all 0.2s;">
                ⚠️ Yönetim İznini Geri Çek (Beklemeye Al)
              </button>
            </div>
          `;
        }
        footerHtml += `
          <div class="status-btn-group" style="display: flex; gap: 0.5rem; width: 100%;">
            <button class="status-change-btn btn-set-approve" onclick="updateCurrentAppStatus('Onaylandı')" style="flex: 1; min-height: 38px;">Onayla</button>
            <button class="status-change-btn btn-set-reject" onclick="updateCurrentAppStatus('Reddedildi')" style="flex: 1; min-height: 38px;">Reddet</button>
            <button class="status-change-btn btn-set-delete" id="btn-drawer-delete" onclick="deleteCurrentApplication()" style="flex: 1; min-height: 38px; background: #dc2626; border: 1px solid #dc2626; color: #ffffff; font-weight: 700; border-radius: var(--radius-sm); cursor: pointer; transition: all var(--transition-fast); display: ${currentAdminUser === 'superadmin' ? 'inline-block' : 'none'};">Sil</button>
          </div>
        `;
      } else {
        footerHtml += `
          <div style="background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.2); color: #b91c1c; padding: 0.75rem; border-radius: var(--radius-sm); font-size: 0.85rem; font-weight: 700; text-align: center; display: flex; align-items: center; justify-content: center; gap: 0.5rem; ${userRole === 'superadmin' ? 'margin-bottom: 0.75rem;' : ''}">
            <i data-lucide="x-circle" style="width: 16px; height: 16px; color:#dc2626;"></i>
            <span>Bu başvuru yönetim tarafından reddedilmiştir.</span>
          </div>
        `;
        if (userRole === 'superadmin') {
          footerHtml += `
            <div style="margin-bottom: 0.75rem;">
              <button class="status-change-btn" onclick="updateCurrentManagementApproval('Beklemede')" style="width: 100%; min-height: 32px; background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.3); color: #b45309; font-weight: 700; font-size: 0.8rem; border-radius: var(--radius-sm); cursor: pointer; transition: all 0.2s;">
                ⚠️ Yönetim Red Kararını Geri Çek (Beklemeye Al)
              </button>
            </div>
          `;
        }
      }
    }
    footerContainer.innerHTML = footerHtml;
  }

  // Highlight active row in table
  highlightTableRow(appId);

  // Show Drawer Overlay and slide-over panel
  drawer.classList.add('active');
  document.body.style.overflow = 'hidden';

  if (typeof lucide !== 'undefined') lucide.createIcons();

  // OCR Integration
  if (app.files && app.files.ruhsat) {
    initRuhsatOCR(app, currentRotation[app.id] || 0);
  } else {
    const ocrStatusContainer = document.getElementById('ocr-status-container');
    if (ocrStatusContainer) {
      ocrStatusContainer.innerHTML = `<span style="font-size: 0.8rem; color: var(--color-text-muted);">Tarama Yapılamadı (Ruhsat Belgesi Yok)</span>`;
    }
  }
}

function adminOpenWhatsAppSimulation(appId) {
  const app = allApplications.find(a => a.id === appId);
  if (!app) return;

  const OTOPARKS_KEY = 'parkexpert_otoparks';
  const otoparks = JSON.parse(localStorage.getItem(OTOPARKS_KEY)) || [];
  const park = otoparks.find(p => p.name === app.parking_location) || {};

  // Setup date formatted time
  const timeStr = new Date(app.date_applied || Date.now()).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

  // Update header metadata (hidden support numbers / status)
  const titleEl = document.getElementById('whatsapp-sim-title');
  if (titleEl) {
    titleEl.textContent = `${app.parking_location} Otopark Yetkilisi`;
  }

  // Populate dynamic HTML inside bubble container depending on approval state
  const bubbleContainer = document.getElementById('whatsapp-bubble-container');
  if (bubbleContainer) {
    let whatsappBody = '';
    
    if (app.status === 'Onaylandı') {
      whatsappBody = `
        <p style="font-size: 0.825rem; line-height: 1.5; color: #1e1e1e; margin: 0; text-align: left; font-weight: 500;">
          Merhaba Sayın <strong>${app.full_name}</strong>, 🌟
        </p>
        <p style="font-size: 0.825rem; line-height: 1.5; color: #1e1e1e; margin: 0; text-align: left;">
          Abonelik başvuru evraklarınız ve ödeme dekontunuz başarıyla incelenmiş ve **ONAYLANMIŞTIR**. Aboneliğiniz aktif edilmiştir! Detaylar aşağıda yer almaktadır:
        </p>

        <div style="background: rgba(7, 94, 84, 0.05); border-left: 3px solid #075e54; border-radius: 4px; padding: 0.5rem 0.75rem; margin: 0.25rem 0; font-size: 0.775rem; display: flex; flex-direction: column; gap: 0.25rem; text-align: left; font-family: sans-serif;">
          <div><strong>📦 Başvuru Kodu:</strong> <span style="color: #075e54; font-weight: 700;">${app.id}</span></div>
          <div><strong>🚗 Araç Plakası:</strong> <span style="text-transform: uppercase; font-weight: 700;">${app.plate}</span></div>
          <div><strong>📍 Otopark Konumu:</strong> <span>${app.parking_location}</span></div>
          <div><strong>💸 Abonelik Tipi:</strong> <span>${app.subscription_type}</span></div>
          <div><strong>📞 Destek Telefonu:</strong> <span>${park.supportPhone || '0216 504 47 22'}</span></div>
        </div>

        <p style="font-size: 0.825rem; line-height: 1.5; color: #1e1e1e; margin: 0; text-align: left; font-weight: 500;">
          🚗 <strong>HGS Otomatik Geçiş Bilgilendirmesi:</strong>
        </p>
        <p style="font-size: 0.825rem; line-height: 1.5; color: #1e1e1e; margin: 0; text-align: left;">
          Plaka tanıma sistemimiz plakanızı otomatik olarak veritabanına tanımlamıştır. Otopark giriş ve çıkışlarında HGS (Hızlı Geçiş Sistemi) plakanızı okuyarak geçiş izni verecektir. Herhangi bir kart okutmanıza veya bilet almanıza gerek yoktur. Keyifli sürüşler dileriz!
        </p>
      `;
    } else if (app.status === 'Reddedildi') {
      whatsappBody = `
        <p style="font-size: 0.825rem; line-height: 1.5; color: #1e1e1e; margin: 0; text-align: left; font-weight: 500;">
          Merhaba Sayın <strong>${app.full_name}</strong>, ⚠️
        </p>
        <p style="font-size: 0.825rem; line-height: 1.5; color: #1e1e1e; margin: 0; text-align: left;">
          Abonelik ön başvurunuz, yüklenen belgelerdeki (ruhsat/kimlik) eksiklikler veya ödeme dekontunun doğrulanamaması nedeniyle **REDDEDİLMİŞTİR**.
        </p>

        <div style="background: rgba(185, 28, 28, 0.05); border-left: 3px solid #b91c1c; border-radius: 4px; padding: 0.5rem 0.75rem; margin: 0.25rem 0; font-size: 0.775rem; display: flex; flex-direction: column; gap: 0.25rem; text-align: left; font-family: sans-serif;">
          <div><strong>📦 Başvuru Kodu:</strong> <span style="color: #b91c1c; font-weight: 700;">${app.id}</span></div>
          <div><strong>🚗 Araç Plakası:</strong> <span style="text-transform: uppercase; font-weight: 700;">${app.plate}</span></div>
          <div><strong>📍 Otopark Konumu:</strong> <span>${app.parking_location}</span></div>
          <div><strong>⚠️ Durum:</strong> <span style="color: #b91c1c; font-weight: 700;">Belge Eksikliği / Dekont Hatası</span></div>
        </div>

        <p style="font-size: 0.825rem; line-height: 1.5; color: #1e1e1e; margin: 0; text-align: left; font-weight: 500;">
          💬 <strong>Nasıl Düzeltebilirsiniz?</strong>
        </p>
        <p style="font-size: 0.825rem; line-height: 1.5; color: #1e1e1e; margin: 0; text-align: left;">
          Lütfen bilgilerinizi kontrol edip belgeleri yeniden yükleyerek yeni bir başvuru oluşturunuz veya otopark yönetim ofisimizle iletişime geçiniz: **${park.supportPhone || '0216 504 47 22'}**
        </p>
      `;
    } else {
      // Normal Pending review receipt
      whatsappBody = `
        <p style="font-size: 0.825rem; line-height: 1.5; color: #1e1e1e; margin: 0; text-align: left; font-weight: 500;">
          Merhaba Sayın <strong>${app.full_name}</strong>, 🌟
        </p>
        <p style="font-size: 0.825rem; line-height: 1.5; color: #1e1e1e; margin: 0; text-align: left;">
          Abonelik başvuru bilgileriniz ve yüklediğiniz belgeler yetkililerimizce <strong>kontrol edilmek üzere başarıyla teslim alınmıştır!</strong> Yapılacak hızlı kontrollerin ardından aboneliğiniz onaylanacaktır. Başvuru detaylarınız aşağıda yer almaktadır:
        </p>

        <div style="background: rgba(7, 94, 84, 0.05); border-left: 3px solid #075e54; border-radius: 4px; padding: 0.5rem 0.75rem; margin: 0.25rem 0; font-size: 0.775rem; display: flex; flex-direction: column; gap: 0.25rem; text-align: left; font-family: sans-serif;">
          <div><strong>📦 Başvuru Kodu:</strong> <span style="color: #075e54; font-weight: 700;">${app.id}</span></div>
          <div><strong>🚗 Araç Plakası:</strong> <span style="text-transform: uppercase; font-weight: 700;">${app.plate}</span></div>
          <div><strong>📍 Otopark Konumu:</strong> <span>${app.parking_location}</span></div>
          <div><strong>💸 Personel / Harici Fiyatı:</strong> <span>${(app.subscription_type.includes('Kurumsal') && app.parking_location !== 'Birlik Sanayi Sitesi - Beylikdüzü') ? (park.priceExternal || '2400 TL') : (park.priceEmployee || '1200 TL')}</span></div>
          <div><strong>📞 Destek Telefonu:</strong> <span>${park.supportPhone || '0216 504 47 22'}</span></div>
        </div>

        <p style="font-size: 0.825rem; line-height: 1.5; color: #1e1e1e; margin: 0; text-align: left; font-weight: 500;">
          💳 <strong>Ödeme ve Dekont Bilgilendirmesi:</strong>
        </p>
        <p style="font-size: 0.825rem; line-height: 1.5; color: #1e1e1e; margin: 0; text-align: left;">
          Yüklemiş olduğunuz ödeme dekontunuz ve başvuru bilgileriniz yetkililerimiz tarafından incelenmek üzere teslim alınmıştır. Kontroller tamamlanıp başvurunuz onaylandığında plaka tanıma sistemimiz otomatik olarak aktifleşecektir.
        </p>
      `;
    }

    // Wrap with banks and timers
    bubbleContainer.innerHTML = `
      ${whatsappBody}
      
      ${app.status !== 'Reddedildi' ? `
      <!-- IBAN info in chat bubble -->
      <div style="background: #fdf6e2; border: 1px dashed #d5a229; border-radius: 4px; padding: 0.5rem; font-size: 0.75rem; color: #7d6015; text-align: left; font-family: monospace; word-break: break-word;">
        <strong>Banka:</strong> <span>${park.bankName || 'Vakıfbank'}</span><br>
        <strong>IBAN:</strong> <span>${park.iban || 'TR23 0001 5001 5800 7302 9104 88'}</span><br>
        <strong>Alıcı:</strong> <span>${park.companyTitle || 'PARKEXPERT'}</span>
      </div>
      ` : ''}

      <!-- Time bubble info -->
      <div style="display: flex; justify-content: flex-end; align-items: center; gap: 0.2rem; font-size: 0.65rem; color: #949494; margin-top: 0.15rem; width: 100%;">
        <span>${timeStr}</span>
        <span style="color: #4fc3f7; font-weight: 700; display: inline-flex; align-items: center;">✓✓</span>
      </div>
    `;
  }

  openModal('modal-whatsapp-simulation');
}

function adminOpenEmailSimulation(appId) {
  const app = allApplications.find(a => a.id === appId);
  if (!app) return;

  const OTOPARKS_KEY = 'parkexpert_otoparks';
  const otoparks = JSON.parse(localStorage.getItem(OTOPARKS_KEY)) || [];
  const park = otoparks.find(p => p.name === app.parking_location) || {};

  // Setup dynamic headers
  const toNameEl = document.getElementById('email-sim-to-name');
  const toAddrEl = document.getElementById('email-sim-to-addr');
  const subjectEl = document.getElementById('email-sim-subject-code');

  if (toNameEl) toNameEl.textContent = app.full_name;
  if (toAddrEl) toAddrEl.textContent = `<${app.email}>`;

  // Render Subject and Content Body depending on approval state
  const templateBody = document.getElementById('email-template-body');
  if (templateBody) {
    let emailSubject = '';
    let emailBody = '';
    
    if (app.status === 'Onaylandı') {
      emailSubject = `🎉 PARKEXPERT Abonelik Başvurunuz ONAYLANDI! (Takip No: ${app.id})`;
      emailBody = `
        <h2 style="font-size: 1.25rem; color: var(--color-primary-dark); font-weight: 700; margin-bottom: 1rem; text-align: center;">Sayın <span>${app.full_name}</span>,</h2>
        
        <p style="font-size: 0.9rem; line-height: 1.6; color: var(--color-text-dark); margin-bottom: 1.5rem; text-align: center;">
          Abonelik başvuru evraklarınız ve ödeme dekontunuz ekiplerimiz tarafından doğrulanmış ve **ONAYLANMIŞTIR**. Plaka tanıma sistemimiz aktif edilmiştir.
        </p>

        <div style="background: var(--color-bg-light); border-radius: var(--radius-md); padding: 1.25rem; margin-bottom: 1.5rem; border-left: 4px solid #10b981;">
          <h4 style="font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-muted); margin-bottom: 0.75rem; font-weight: 700; border: none; padding: 0;">Onaylanan Abonelik Detayları</h4>
          <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.75rem; font-size: 0.85rem;">
            <div><strong style="color: var(--color-text-dark);">Takip Numarası:</strong> <span style="color: var(--color-primary); font-weight: 700;">${app.id}</span></div>
            <div><strong style="color: var(--color-text-dark);">Araç Plakası:</strong> <span style="text-transform: uppercase; font-weight: 700; color: var(--color-text-dark);">${app.plate}</span></div>
            <div><strong style="color: var(--color-text-dark);">Otopark Konumu:</strong> <span>${app.parking_location}</span></div>
            <div><strong style="color: var(--color-text-dark);">Abonelik Tipi:</strong> <span>${app.subscription_type}</span></div>
            <div><strong style="color: var(--color-text-dark);">Başvuru Tarihi:</strong> <span>${formatDateTR(app.created_at || app.date_applied)}</span></div>
            <div><strong style="color: var(--color-text-dark);">Durum:</strong> <span style="color:#10b981; font-weight:700;">Aktif / Onaylandı</span></div>
          </div>
        </div>

        <div style="background: rgba(16, 185, 129, 0.1); border: 1px dashed #10b981; border-radius: var(--radius-md); padding: 1rem; margin-bottom: 2rem; display: flex; gap: 0.75rem; align-items: flex-start;">
          <i data-lucide="check-circle" style="color: #10b981; width: 20px; height: 20px; flex-shrink: 0; margin-top: 0.1rem;"></i>
          <p style="font-size: 0.8rem; line-height: 1.5; color: var(--color-primary-dark); margin: 0; text-align: left;">
            Otopark giriş ve çıkışlarında plaka tanıma HGS (Hızlı Geçiş Sistemi) plakanızı otomatik olarak okuyacak ve geçiş izni verecektir. Bilet almanıza veya kart kullanmanıza gerek yoktur.
          </p>
        </div>
      `;
    } else if (app.status === 'Reddedildi') {
      emailSubject = `⚠️ PARKEXPERT Abonelik Başvurunuz Hakkında (Takip No: ${app.id})`;
      emailBody = `
        <h2 style="font-size: 1.25rem; color: var(--color-primary-dark); font-weight: 700; margin-bottom: 1rem; text-align: center;">Sayın <span>${app.full_name}</span>,</h2>
        
        <p style="font-size: 0.9rem; line-height: 1.6; color: var(--color-text-dark); margin-bottom: 1.5rem; text-align: center;">
          Abonelik ön başvurunuz, yüklenen belgelerdeki (ruhsat/kimlik) eksiklikler veya ödeme dekontunun eşleşmemesi nedeniyle **REDDEDİLMİŞTİR**.
        </p>

        <div style="background: var(--color-bg-light); border-radius: var(--radius-md); padding: 1.25rem; margin-bottom: 1.5rem; border-left: 4px solid #ef4444;">
          <h4 style="font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-muted); margin-bottom: 0.75rem; font-weight: 700; border: none; padding: 0;">Reddedilen Başvuru Detayları</h4>
          <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.75rem; font-size: 0.85rem;">
            <div><strong style="color: var(--color-text-dark);">Takip Numarası:</strong> <span style="color: var(--color-primary); font-weight: 700;">${app.id}</span></div>
            <div><strong style="color: var(--color-text-dark);">Araç Plakası:</strong> <span style="text-transform: uppercase; font-weight: 700; color: var(--color-text-dark);">${app.plate}</span></div>
            <div><strong style="color: var(--color-text-dark);">Otopark Konumu:</strong> <span>${app.parking_location}</span></div>
            <div><strong style="color: var(--color-text-dark);">Durum:</strong> <span style="color:#ef4444; font-weight:700;">Belge Eksikliği / Ödeme Sorunu</span></div>
          </div>
        </div>

        <div style="background: rgba(239, 68, 68, 0.1); border: 1px dashed #ef4444; border-radius: var(--radius-md); padding: 1rem; margin-bottom: 2rem; display: flex; gap: 0.75rem; align-items: flex-start;">
          <i data-lucide="x-circle" style="color: #ef4444; width: 20px; height: 20px; flex-shrink: 0; margin-top: 0.1rem;"></i>
          <p style="font-size: 0.8rem; line-height: 1.5; color: var(--color-primary-dark); margin: 0; text-align: left;">
            Lütfen evraklarınızı, plaka numaranızı veya dekont bilgilerinizi kontrol ederek doğru belgelerle yeni bir abonelik başvurusu oluşturunuz ya da bizimle iletişime geçiniz: destek@parkexpert.net
          </p>
        </div>
      `;
    } else {
      // Normal pending receipt review
      emailSubject = `🌟 PARKEXPERT Abonelik Başvurunuz Alındı! (Takip No: ${app.id})`;
      emailBody = `
        <h2 style="font-size: 1.25rem; color: var(--color-primary-dark); font-weight: 700; margin-bottom: 1rem; text-align: center;">Sayın <span>${app.full_name}</span>,</h2>
        
        <p style="font-size: 0.9rem; line-height: 1.6; color: var(--color-text-dark); margin-bottom: 1.5rem; text-align: center;">
          Abonelik başvuru kaydınız başarıyla veri tabanımıza kaydedilmiştir. Plaka tanıma sistemi entegrasyonu ve yüklemiş olduğunuz belgeler ekiplerimiz tarafından incelenmektedir.
        </p>

        <div style="background: var(--color-bg-light); border-radius: var(--radius-md); padding: 1.25rem; margin-bottom: 1.5rem; border-left: 4px solid var(--color-primary);">
          <h4 style="font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-muted); margin-bottom: 0.75rem; font-weight: 700; border: none; padding: 0;">Başvuru Detayları</h4>
          <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.75rem; font-size: 0.85rem;">
            <div><strong style="color: var(--color-text-dark);">Takip Numarası:</strong> <span style="color: var(--color-primary); font-weight: 700;">${app.id}</span></div>
            <div><strong style="color: var(--color-text-dark);">Araç Plakası:</strong> <span style="text-transform: uppercase; font-weight: 700; color: var(--color-text-dark);">${app.plate}</span></div>
            <div><strong style="color: var(--color-text-dark);">Otopark Konumu:</strong> <span>${app.parking_location}</span></div>
            <div><strong style="color: var(--color-text-dark);">Abonelik Tipi:</strong> <span>${app.subscription_type}</span></div>
            <div><strong style="color: var(--color-text-dark);">Başvuru Tarihi:</strong> <span>${formatDateTR(app.created_at || app.date_applied)}</span></div>
            <div><strong style="color: var(--color-text-dark);">Araç Modeli:</strong> <span>${app.car_model || 'Belirtilmedi'}</span></div>
          </div>
        </div>

        <div style="background: rgba(255, 208, 0, 0.1); border: 1px dashed var(--color-accent-gold); border-radius: var(--radius-md); padding: 1rem; margin-bottom: 2rem; display: flex; gap: 0.75rem; align-items: flex-start;">
          <i data-lucide="info" style="color: var(--color-primary); width: 20px; height: 20px; flex-shrink: 0; margin-top: 0.1rem;"></i>
          <p style="font-size: 0.8rem; line-height: 1.5; color: var(--color-primary-dark); margin: 0; text-align: left;">
            Başvurunuz onaylandığında plaka tanıma sistemimiz otomatik olarak aktif edilecek ve tarafınıza <strong>SMS</strong> ile bilgilendirme yapılacaktır. Takip numaranız ile istediğiniz an durum sorgulaması yapabilirsiniz.
          </p>
        </div>
      `;
    }

    if (subjectEl) {
      subjectEl.innerHTML = emailSubject;
    }

    templateBody.innerHTML = `
      <!-- Logo in Email -->
      <div style="text-align: center; margin-bottom: 2rem;">
        <img src="assets/logo.png" alt="PARKEXPERT Logo" style="height: 45px; object-fit: contain;">
        <div style="width: 40px; height: 3px; background: var(--color-accent-gold); margin: 0.5rem auto 0 auto; border-radius: var(--radius-full);"></div>
      </div>
      
      ${emailBody}

      <div style="border-top: 1px solid var(--color-border-light); padding-top: 1.5rem; text-align: center; font-size: 0.8rem; color: var(--color-text-muted);">
        <p style="margin-bottom: 0.25rem;">Bu e-posta otomatik olarak gönderilmiştir. Lütfen yanıtlamayınız.</p>
        <p style="font-weight: 700; color: var(--color-primary-dark);">PARKEXPERT Müşteri Hizmetleri</p>
        <p style="margin-top: 0.25rem;"><a href="mailto:destek@parkexpert.net" style="color: var(--color-primary); text-decoration: none;">destek@parkexpert.net</a> | 0216 504 47 22</p>
      </div>
    `;
  }

  openModal('modal-email-simulation');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function highlightTableRow(appId) {
  const rows = document.querySelectorAll('#table-body tr');
  rows.forEach(r => r.style.backgroundColor = ''); // Clear highlights

  const activeRow = document.getElementById(`row-${appId}`);
  if (activeRow) {
    activeRow.style.backgroundColor = 'rgba(249, 115, 22, 0.05)';
  }
}

function closeDrawer() {
  const drawer = document.getElementById('drawer-overlay');
  if (drawer) {
    drawer.classList.remove('active');
    document.body.style.overflow = '';
  }
  
  // Clear table row highlights
  const rows = document.querySelectorAll('#table-body tr');
  rows.forEach(r => r.style.backgroundColor = '');
}

function closeDrawerOnOverlay(event) {
  if (event.target.classList.contains('drawer-overlay')) {
    closeDrawer();
  }
}

async function updateCurrentAppStatus(newStatus) {
  if (!currentAppId) return;

  const token = localStorage.getItem('parkexpert_token');
  if (!token) {
    alert("Yetkisiz işlem! Lütfen tekrar giriş yapın.");
    return;
  }

  try {
    const res = await fetch("/api/applications", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({ id: currentAppId, status: newStatus })
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Durum güncellenirken hata oluştu.");
    }

    const data = await res.json();
    const updatedApp = data.data && data.data[0];

    // Find and update status in database array
    const appIndex = allApplications.findIndex(a => a.id === currentAppId);
    if (appIndex !== -1) {
      if (updatedApp) {
        allApplications[appIndex].status = updatedApp.status || newStatus;
        if (updatedApp.management_approval) {
          allApplications[appIndex].management_approval = updatedApp.management_approval;
        }
        if (updatedApp.subscription_expires_at) {
          allApplications[appIndex].subscription_expires_at = updatedApp.subscription_expires_at;
        }
      } else {
        allApplications[appIndex].status = newStatus;
      }
      
      // Refresh table rendering with current filter set
      applyFilters();
      if (currentAdminTab === 'expirations') {
        renderExpirationsDashboard();
      }
      
      // Refresh the drawer body content to show updated status
      openDrawer(currentAppId);

      // Trigger simulated status notification alerts (Toasts) for the admin
      triggerAdminStatusToasts(allApplications[appIndex], newStatus);

      // Show simulated admin status log
      console.log(`Application ${currentAppId} status updated to: ${newStatus}`);
    }
  } catch (err) {
    console.error(err);
    alert(err.message);
  }
}

async function updateCurrentManagementApproval(approvalStatus) {
  if (!currentAppId) return;

  const token = localStorage.getItem('parkexpert_token');
  if (!token) {
    alert("Yetkisiz işlem! Lütfen tekrar giriş yapın.");
    return;
  }

  try {
    const res = await fetch("/api/applications", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({ id: currentAppId, management_approval: approvalStatus })
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Durum güncellenirken hata oluştu.");
    }

    const data = await res.json();
    const updatedApp = data.data && data.data[0];

    // Find and update status in database array
    const appIndex = allApplications.findIndex(a => a.id === currentAppId);
    if (appIndex !== -1) {
      if (updatedApp) {
        allApplications[appIndex].management_approval = updatedApp.management_approval || approvalStatus;
        allApplications[appIndex].status = updatedApp.status || allApplications[appIndex].status;
        allApplications[appIndex].subscription_expires_at = updatedApp.subscription_expires_at;
      } else {
        allApplications[appIndex].management_approval = approvalStatus;
        if (approvalStatus === 'Reddedildi') {
          allApplications[appIndex].status = 'Reddedildi';
        } else if (approvalStatus === 'Beklemede') {
          allApplications[appIndex].status = 'Beklemede';
          allApplications[appIndex].subscription_expires_at = null;
        }
      }
      
      // Refresh table rendering with current filter set
      applyFilters();
      
      // Refresh the drawer body content to show updated status
      openDrawer(currentAppId);

      // Show toast / success notification
      showToastNotification('Yönetim Onayı Güncellendi', `Başvuru yönetim onayı durumu '${approvalStatus}' olarak güncellendi.`, 'check');
    }
  } catch (err) {
    console.error(err);
    alert(err.message);
  }
}

async function createTestApplication() {
  const token = localStorage.getItem('parkexpert_token');
  if (!token) {
    alert("Yetkisiz işlem! Lütfen tekrar giriş yapın.");
    return;
  }

  // Pre-filled random mock test customer data
  const names = ["Yusuf Testoğlu", "Elif Deneme", "Canan Örnek", "Murat Simülasyon", "Aylin Beta"];
  const randomName = names[Math.floor(Math.random() * names.length)];
  const randomPlate = "34TS" + Math.floor(1000 + Math.random() * 9000);
  const randomPhone = "+90505" + Math.floor(1000000 + Math.random() * 9000000);
  const randomEmail = `test_${Math.floor(Math.random()*10000)}@parkexpert.net`;
  
  const OTOPARKS_KEY = 'parkexpert_otoparks';
  const otoparks = JSON.parse(localStorage.getItem(OTOPARKS_KEY)) || [];
  const randomOtopark = otoparks.length > 0 ? otoparks[Math.floor(Math.random() * otoparks.length)].name : "Birlik Sanayi Sitesi - Beylikdüzü";

  const payload = {
    subscription_type: "bireysel",
    parking_location: randomOtopark,
    full_name: randomName,
    plate_number: randomPlate,
    phone: randomPhone,
    email: randomEmail,
    tc_identity: "11111111111",
    brand_model: "Toyota Corolla (Test)",
    subscription_period: "1_month",
    start_date: new Date().toISOString().split('T')[0]
  };

  try {
    const res = await fetch("/api/applications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Test müşterisi oluşturulamadı.");
    }

    showToastNotification('Test Müşterisi Oluşturuldu', `Yeni test kaydı '${randomName} (${randomPlate})' başarıyla oluşturuldu.`, 'check');
    
    // Refresh application list
    if (typeof loadApplications === 'function') {
      await loadApplications();
    }
  } catch (err) {
    console.error(err);
    alert(err.message);
  }
}

function triggerAdminStatusToasts(app, status) {
  const emailToast = document.getElementById('email-toast');
  const whatsappToast = document.getElementById('whatsapp-toast');

  if (emailToast && whatsappToast) {
    const eTitle = document.getElementById('toast-title');
    const eMessage = document.getElementById('toast-message');
    const wTitle = document.getElementById('whatsapp-toast-title');
    const wMessage = document.getElementById('whatsapp-toast-message');

    // Reset icons in case of repeated status changes
    const eIcon = emailToast.querySelector('.toast-icon');
    const wIcon = whatsappToast.querySelector('.toast-icon');
    if (eIcon) eIcon.innerHTML = `<i data-lucide="mail"></i>`;
    if (wIcon) wIcon.innerHTML = `<i data-lucide="message-circle" style="fill: #25d366; color: #ffffff;"></i>`;

    // Reset classes and trigger show Email Toast
    emailToast.classList.add('active');
    if (eTitle) eTitle.innerHTML = `📧 E-posta Sunucusu`;
    if (eMessage) eMessage.textContent = `${app.email} adresine durum güncellemesi iletiliyor...`;

    // Reset classes and trigger show WhatsApp Toast with a slight delay
    setTimeout(() => {
      whatsappToast.classList.add('active');
      if (wTitle) wTitle.innerHTML = `<span style="display:inline-flex; align-items:center; gap:0.25rem; color:#25d366;">💬 WhatsApp API Gateway</span>`;
      if (wMessage) wMessage.textContent = `${app.phone} numarasına bildirim teyidi iletiliyor...`;
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }, 1000);

    // Complete Email Toast
    setTimeout(() => {
      if (eMessage) {
        if (status === 'Onaylandı') {
          eMessage.innerHTML = `📬 <strong>Abonelik Aktivasyon Onay E-postası başarıyla iletildi!</strong><br><span style="font-size:0.7rem; color:var(--color-primary);">Kayıtları incelemek için "Görüntüle"ye tıklayın.</span>`;
        } else {
          eMessage.innerHTML = `⚠️ <strong>Başvuru Red/Düzeltme E-postası başarıyla iletildi!</strong><br><span style="font-size:0.7rem; color:var(--color-primary);">Kayıtları incelemek için "Görüntüle"ye tıklayın.</span>`;
        }
      }
      if (eIcon) eIcon.innerHTML = `<i data-lucide="mail-check" style="color:#25d366;"></i>`;
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }, 2800);

    // Complete WhatsApp Toast
    setTimeout(() => {
      if (wMessage) {
        if (status === 'Onaylandı') {
          wMessage.innerHTML = `<strong>Abonelik Aktivasyon WhatsApp Onayı iletildi!</strong><br><span style="font-size:0.7rem; color:#25d366;">Geçiş aktif edildi. Görmek için tıklayın.</span>`;
        } else {
          wMessage.innerHTML = `<strong>Abonelik Red Detay WhatsApp Mesajı iletildi!</strong><br><span style="font-size:0.7rem; color:#25d366;">Görmek için tıklayın.</span>`;
        }
      }
      if (wIcon) wIcon.innerHTML = `<i data-lucide="message-square-code" style="color:#25d366; fill:#25d366;"></i>`;
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }, 3800);

    // Auto-hide both toasts
    setTimeout(() => {
      emailToast.classList.remove('active');
    }, 8500);
    setTimeout(() => {
      whatsappToast.classList.remove('active');
    }, 9500);

    // Make toasts clickable to open simulation modals
    emailToast.style.cursor = 'pointer';
    emailToast.onclick = () => {
      adminOpenEmailSimulation(app.id);
      emailToast.classList.remove('active');
    };
    whatsappToast.style.cursor = 'pointer';
    whatsappToast.onclick = () => {
      adminOpenWhatsAppSimulation(app.id);
      whatsappToast.classList.remove('active');
    };
  }
}

/* ==========================================================================
   DOCUMENT VIEWING & DOWNLOAD SIMULATOR
   ========================================================================== */

async function openDocPreview(docType, path, overrideObjectUrl = null) {
  const modal = document.getElementById('modal-doc-preview');
  const titleEl = document.getElementById('preview-doc-title');
  const filenameEl = document.getElementById('preview-filename');
  const previewDocBox = document.getElementById('preview-doc-box');

  if (!modal) return;
  
  if (titleEl) titleEl.textContent = `${docType} Önizleme`;
  if (filenameEl) filenameEl.textContent = path ? path.split('/').pop() : '';
  
  if (overrideObjectUrl) {
    modal.classList.add('active');
    if (previewDocBox) {
      previewDocBox.innerHTML = `
        <img src="${overrideObjectUrl}" alt="${docType}" style="max-width: 100%; max-height: 350px; border-radius: var(--radius-sm); object-fit: contain; box-shadow: var(--shadow-sm);">
        <div style="margin-top: 1.25rem;">
          <a href="${overrideObjectUrl}" download="${path ? path.split('/').pop() : 'document.jpg'}" class="btn btn-primary" style="padding: 0.5rem 1.5rem; font-size: 0.85rem; min-height: 38px; width: auto; display: inline-flex; justify-content: center; align-items: center; gap: 0.35rem;">
            <i data-lucide="download" style="width: 14px; height: 14px;"></i> Dosyayı İndir
          </a>
        </div>
      `;
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
    return;
  }

  // Show loading indicator
  if (previewDocBox) {
    previewDocBox.innerHTML = `
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2rem;">
        <div style="width: 32px; height: 32px; border: 3px solid rgba(15, 59, 162, 0.1); border-top-color: var(--color-primary); border-radius: 50%; animation: spin 1s infinite linear; margin-bottom: 1rem;"></div>
        <p style="font-size: 0.8rem; color: var(--color-text-muted); margin: 0;">Evrak güvenli depodan çekiliyor...</p>
      </div>
      <style>
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
      </style>
    `;
  }
  
  modal.classList.add('active');

  const token = localStorage.getItem('parkexpert_token');
  if (!token || !path) {
    if (previewDocBox) {
      previewDocBox.innerHTML = `
        <i data-lucide="alert-triangle" style="width: 48px; height: 48px; color: #ef4444; margin-bottom: 1rem;"></i>
        <h4 style="color: #ef4444; margin-bottom: 0.5rem;">Erişim Hatası</h4>
        <p style="font-size: 0.8rem; color: var(--color-text-muted); margin: 0;">Geçersiz oturum veya bulunamayan dosya yolu.</p>
      `;
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
    return;
  }

  try {
    const res = await fetch(`/api/document?path=${encodeURIComponent(path)}`, {
      headers: {
        "Authorization": `Bearer ${token}`
      }
    });

    if (!res.ok) throw new Error("File could not be fetched");

    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const filename = path.split('/').pop();
    const isImage = blob.type.startsWith('image/');

    if (previewDocBox) {
      if (isImage) {
        previewDocBox.innerHTML = `
          <img src="${objectUrl}" alt="${docType}" style="max-width: 100%; max-height: 350px; border-radius: var(--radius-sm); object-fit: contain; box-shadow: var(--shadow-sm);">
          <div style="margin-top: 1.25rem;">
            <a href="${objectUrl}" download="${filename}" class="btn btn-primary" style="padding: 0.5rem 1.5rem; font-size: 0.85rem; min-height: 38px; width: auto; display: inline-flex; justify-content: center; align-items: center; gap: 0.35rem;">
              <i data-lucide="download" style="width: 14px; height: 14px;"></i> Dosyayı İndir
            </a>
          </div>
        `;
      } else {
        previewDocBox.innerHTML = `
          <i data-lucide="file-text" style="width: 48px; height: 48px; color: var(--color-accent-orange); margin-bottom: 1rem;"></i>
          <h4 style="margin-bottom: 0.5rem;">${filename}</h4>
          <p style="font-size: 0.8rem; color: var(--color-text-muted); margin-bottom: 1.5rem;">Evrak resmi doğrulanmıştır. PDF görüntüleyici güvenlidir.</p>
          <div style="display: flex; gap: 0.5rem; justify-content: center;">
            <a href="${objectUrl}" target="_blank" class="btn btn-secondary" style="padding: 0.5rem 1.5rem; font-size: 0.85rem; min-height: 38px; width: auto; display: inline-flex; align-items: center; gap: 0.35rem; background: #e2e8f0; color: #475569;">
              <i data-lucide="eye" style="width: 14px; height: 14px;"></i> Tarayıcıda Aç
            </a>
            <a href="${objectUrl}" download="${filename}" class="btn btn-primary" style="padding: 0.5rem 1.5rem; font-size: 0.85rem; min-height: 38px; width: auto; display: inline-flex; align-items: center; gap: 0.35rem;">
              <i data-lucide="download" style="width: 14px; height: 14px;"></i> Dosyayı İndir
            </a>
          </div>
        `;
      }
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  } catch (err) {
    console.error(err);
    if (previewDocBox) {
      previewDocBox.innerHTML = `
        <i data-lucide="alert-triangle" style="width: 48px; height: 48px; color: #ef4444; margin-bottom: 1rem;"></i>
        <h4 style="color: #ef4444; margin-bottom: 0.5rem;">Yükleme Hatası</h4>
        <p style="font-size: 0.8rem; color: var(--color-text-muted); margin: 0;">Evrak depodan çekilirken bir hata oluştu.</p>
      `;
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  }
}

function simulateDocDownload(event) {
  event.preventDefault();
  const filename = document.getElementById('preview-filename').textContent;
  
  // Generate dummy text payload
  const dummyContent = `PARKEXPERT DIGITAL DOCUMENT PREVIEW\n\nDocument Name: ${filename}\nStatus: Verified Secure\nVerification Timestamp: ${new Date().toISOString()}`;
  const blob = new Blob([dummyContent], { type: 'text/plain;charset=utf-8' });
  
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/* ==========================================================================
   EXCEL / CSV EXPORT SYSTEM (Pure Vanilla JS Implementation)
   ========================================================================== */

function exportToExcel() {
  if (filteredApplications.length === 0) {
    alert("Dışa aktarılacak herhangi bir başvuru bulunmamaktadır.");
    return;
  }

  // 1. Setup headers
  const headers = [
    "Başvuru No",
    "Abonelik Tipi",
    "Otopark Konumu",
    "Ad Soyad",
    "Şoför Adı",
    "T.C. Kimlik No",
    "Telefon",
    "E-posta",
    "Araç Plakası",
    "Araç Marka Model",
    "İşyeri Adresi",
    "Başvuru Tarihi",
    "Başvuru Durumu",
    "Firma Unvanı",
    "Vergi Dairesi",
    "Vergi Numarası",
    "Fatura Adresi"
  ];

  // 2. Setup rows
  const rows = filteredApplications.map(app => [
    app.id,
    app.subscription_type,
    app.parking_location,
    app.full_name,
    app.driver_name || app.full_name,
    `'${app.tc_no}`, // Prefix with tick to prevent scientific notation in Excel
    app.phone,
    app.email,
    app.plate,
    app.car_model,
    app.home_address ? app.home_address.replace(/\r?\n/g, " ") : "",
    formatDateTR(app.created_at || app.date_applied),
    app.status,
    app.billing ? app.billing.company : "",
    app.billing ? app.billing.tax_office : "",
    app.billing ? `'${app.billing.tax_no}` : "", // Prefix with tick to prevent scientific notation in Excel
    app.billing ? app.billing.address.replace(/\r?\n/g, " ") : "" // Flatten address
  ]);

  // 3. Assemble CSV string with semicolon delimiters (Turkish Excel friendly)
  const csvContent = [
    headers.join(";"),
    ...rows.map(r => r.map(cell => {
      // Escape cell strings containing quotes or semicolons
      let cellStr = String(cell);
      if (cellStr.includes(";") || cellStr.includes('"') || cellStr.includes("\n")) {
        cellStr = `"${cellStr.replace(/"/g, '""')}"`;
      }
      return cellStr;
    }).join(";"))
  ].join("\n");

  // 4. Encode as UTF-8 with BOM (Byte Order Mark) to ensure Excel opens Turkish chars perfectly
  const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
  const blob = new Blob([bom, csvContent], { type: "text/csv;charset=utf-8;" });
  
  // 5. Trigger browser download
  const dateStr = new Date().toISOString().split('T')[0];
  const filename = `ParkExpert_Abonelik_Basvurulari_${dateStr}.csv`;
  
  const link = document.createElement("a");
  if (link.download !== undefined) {
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}

function exportToParkExpertExcel() {
  if (filteredApplications.length === 0) {
    alert("Dışa aktarılacak herhangi bir başvuru bulunmamaktadır.");
    return;
  }

  const btn = document.getElementById('btn-parkexpert-export');
  const originalText = btn.innerHTML;
  btn.innerHTML = '<i class="spinner-border spinner-border-sm" role="status" style="width: 14px; height: 14px; display: inline-block; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spinner-border .75s linear infinite; margin-right: 0.25rem;"></i> Yükleniyor...';
  btn.disabled = true;

  const styleNode = document.createElement('style');
  styleNode.innerHTML = `
    @keyframes spinner-border {
      to { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(styleNode);

  const loadSheetJS = (callback) => {
    if (window.XLSX) {
      callback();
      return;
    }
    const script = document.createElement('script');
    script.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    script.onload = () => {
      callback();
    };
    script.onerror = () => {
      btn.innerHTML = originalText;
      btn.disabled = false;
      alert("Excel kütüphanesi yüklenemedi. İnternet bağlantınızı kontrol edin.");
    };
    document.head.appendChild(script);
  };

  loadSheetJS(() => {
    try {
      const wsData = [
        [
          "Abone Adı",
          "Abone Grubu",
          "Tip (COMPANY/INDIVIDUAL)",
          "Kimlik No",
          "Vergi No",
          "Telefon",
          "E-posta",
          "Abonelik Tip Adı",
          "Başlangıç Zamanı",
          "Plaka",
          "Sürücü Adı",
          "Marka",
          "Model"
        ]
      ];

      filteredApplications.forEach(app => {
        let phone = app.phone || "";
        let cleanPhone = phone.replace(/\D/g, "");
        if (cleanPhone.startsWith("90")) cleanPhone = cleanPhone.substring(2);
        if (cleanPhone.startsWith("0")) cleanPhone = cleanPhone.substring(1);

        let marka = "";
        let model = "";
        if (app.car_model) {
          const parts = app.car_model.trim().split(/\s+/);
          if (parts.length > 0) {
            marka = parts[0];
            if (parts.length > 1) {
              model = parts.slice(1).join(" ");
            }
          }
        }

        const dateStr = app.created_at || app.date_applied;
        let parsedDate = null;
        if (dateStr) {
          parsedDate = new Date(dateStr);
          if (isNaN(parsedDate.getTime())) {
            parsedDate = new Date();
          }
        } else {
          parsedDate = new Date();
        }

        const cleanPlate = (app.plate || "").replace(/\s+/g, "").toUpperCase();

        wsData.push([
          app.full_name,
          app.company_name || "",
          "COMPANY",
          app.tc_no || "",
          app.tax_number || (app.billing ? app.billing.tax_no : "") || "",
          cleanPhone,
          app.email || "",
          "Dış Abonelikler (3.750)",
          parsedDate,
          cleanPlate,
          app.driver_name || app.full_name,
          marka,
          model
        ]);
      });

      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(wsData, { cellDates: true });

      const range = XLSX.utils.decode_range(ws['!ref']);
      for (let r = 1; r <= range.e.r; ++r) {
        const cellRef = XLSX.utils.encode_cell({ r: r, c: 8 });
        const cell = ws[cellRef];
        if (cell && cell.v instanceof Date) {
          cell.z = 'dd.mm.yyyy hh:mm:ss';
        }
      }

      XLSX.utils.book_append_sheet(wb, ws, "Abonelikler");

      const dateStr = new Date().toISOString().split('T')[0];
      const filename = `ParkExpert_Yazilim_Aboneler_${dateStr}.xlsx`;
      XLSX.writeFile(wb, filename);

    } catch (err) {
      console.error(err);
      alert("Excel dosyası oluşturulurken bir hata oluştu: " + err.message);
    } finally {
      btn.innerHTML = originalText;
      btn.disabled = false;
    }
  });
}

function renderOtoparksTable() {
  const gridContainer = document.getElementById('otoparks-grid-container');
  const countEl = document.getElementById('otoparks-results-count');
  if (!gridContainer) return;

  const OTOPARKS_KEY = 'parkexpert_otoparks';
  const otoparks = JSON.parse(localStorage.getItem(OTOPARKS_KEY)) || [];

  if (countEl) {
    countEl.textContent = `(${otoparks.length} konum)`;
  }

  gridContainer.innerHTML = '';

  if (otoparks.length === 0) {
    gridContainer.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 3rem 1.5rem; color: var(--color-text-muted); font-size: 0.95rem;">
        Sistemde tanımlı otopark işletmesi bulunamadı.
      </div>
    `;
    return;
  }

  otoparks.forEach(park => {
    // Category badge class
    let catClass = 'otopark-card__category--sanayi';
    if (park.category === 'AVM Otoparkları') {
      catClass = 'otopark-card__category--avm';
    } else if (park.category === 'Açık Otoparklar / Bağımsız Otoparklar') {
      catClass = 'otopark-card__category--acik';
    }

    // Shorten category label for badge
    let catLabel = park.category;
    if (catLabel === 'Sanayi Sitesi Otoparkları') catLabel = 'Sanayi';
    else if (catLabel === 'AVM Otoparkları') catLabel = 'AVM';
    else if (catLabel === 'Açık Otoparklar / Bağımsız Otoparklar') catLabel = 'Açık / Bağımsız';

    // Active status configuration
    const isActive = park.isActive !== false;
    const cardStatusClass = isActive ? '' : ' otopark-card--inactive';
    const statusBtnClass = isActive ? 'otopark-card__status-btn--active' : 'otopark-card__status-btn--inactive';
    const statusText = isActive ? 'AÇIK' : 'KAPALI';
    const statusTitle = isActive ? 'Abonelik Alımını Kapat' : 'Abonelik Alımını Aç';
    const statusDotColor = isActive ? '#10b981' : '#ef4444';

    const card = document.createElement('div');
    card.className = `otopark-card${cardStatusClass}`;
    card.innerHTML = `
      <div class="otopark-card__header">
        <div class="otopark-card__name">${park.name}</div>
        <div style="display: flex; align-items: center; gap: 0.4rem; flex-shrink: 0;">
          <span class="otopark-card__category ${catClass}">${catLabel}</span>
          <button type="button" class="otopark-card__status-btn ${statusBtnClass}" onclick="toggleOtoparkStatus('${park.id}')" title="${statusTitle}">
            <span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background-color: ${statusDotColor};"></span>
            <span>${statusText}</span>
          </button>
        </div>
      </div>
      <div class="otopark-card__body">
        <div class="otopark-card__field otopark-card__field--full">
          <span class="otopark-card__label">Şirket Unvanı</span>
          <span class="otopark-card__value" style="text-transform: uppercase;">${park.companyTitle || 'Belirtilmedi'}</span>
        </div>
        <div class="otopark-card__field">
          <span class="otopark-card__label">Vergi Dairesi</span>
          <span class="otopark-card__value">${park.taxOffice || 'Belirtilmedi'}</span>
        </div>
        <div class="otopark-card__field">
          <span class="otopark-card__label">Vergi No</span>
          <span class="otopark-card__value">${park.taxNumber || 'Belirtilmedi'}</span>
        </div>
        <div class="otopark-card__field">
          <span class="otopark-card__label">Banka</span>
          <span class="otopark-card__value" style="color: var(--color-primary-dark); font-weight: 700;">${park.bankName}</span>
        </div>
        <div class="otopark-card__field">
          <span class="otopark-card__label">Fiyatlar</span>
          <span class="otopark-card__value otopark-card__value--price">
            <span class="otopark-card__price-emp">${park.priceEmployee}</span> · <span class="otopark-card__price-ext">${park.priceExternal}</span>
          </span>
        </div>
        <div class="otopark-card__field otopark-card__field--full">
          <span class="otopark-card__label">IBAN</span>
          <span class="otopark-card__value otopark-card__value--iban">
            <span>${park.iban}</span>
            <button type="button" class="btn-copy-iban" onclick="copyIbanToClipboard(this, '${park.iban}')" title="IBAN Kopyala">
              <i data-lucide="copy" style="width: 11px; height: 11px;"></i>
              <span class="copy-tooltip" style="font-size: 0.65rem; padding: 0.2rem 0.35rem;">Kopyalandı!</span>
            </button>
          </span>
        </div>
        <div class="otopark-card__field otopark-card__field--full" style="background: rgba(37, 99, 235, 0.03); padding: 0.35rem 0.5rem; border-radius: var(--radius-sm); border: 1px dashed rgba(37, 99, 235, 0.15); display: flex; align-items: center; justify-content: space-between; margin-top: 0.25rem;">
          <span class="otopark-card__label" style="font-weight: 700; color: var(--color-primary-dark); display: flex; align-items: center; gap: 0.3rem;"><i data-lucide="shield-check" style="width: 13px; height: 13px; color: var(--color-primary);"></i> Site/AVM Ön Onayı</span>
          <span class="otopark-card__value" style="font-weight: 700; color: ${park.requiresManagementApproval === true ? '#2563eb' : '#64748b'}; font-size: 0.75rem;">${park.requiresManagementApproval === true ? 'AKTİF (GEREKLİ)' : 'PASİF (DİREKT GEÇİŞ)'}</span>
        </div>
      </div>
      <div class="otopark-card__footer">
        <span class="otopark-card__support">
          <i data-lucide="phone" style="width: 12px; height: 12px;"></i>
          ${park.supportPhone || '—'}
        </span>
        <div style="display: flex; gap: 0.5rem; align-items: center;">
          <button class="otopark-card__edit-btn" onclick="openTemplatesModal('${park.id}')" style="color: var(--color-primary);">
            <i data-lucide="mail" style="width: 12px; height: 12px; color: var(--color-primary);"></i> Şablonlar
          </button>
          <button class="otopark-card__edit-btn" onclick="editOtopark('${park.id}')">
            <i data-lucide="edit-2" style="width: 12px; height: 12px;"></i> Düzenle
          </button>
          <button class="otopark-card__edit-btn" onclick="deleteOtopark('${park.id}')" style="color: #ef4444;">
            <i data-lucide="trash-2" style="width: 12px; height: 12px; color: #ef4444;"></i> Sil
          </button>
        </div>
      </div>
    `;

    gridContainer.appendChild(card);
  });

  if (typeof lucide !== 'undefined') lucide.createIcons();
}


function editOtopark(otoparkId) {
  const OTOPARKS_KEY = 'parkexpert_otoparks';
  const otoparks = JSON.parse(localStorage.getItem(OTOPARKS_KEY)) || [];
  const park = otoparks.find(p => p.id === otoparkId);

  if (!park) return;

  document.getElementById('edit-otopark-id').value = park.id;
  
  const nameInput = document.getElementById('edit-otopark-name');
  if (nameInput) {
    nameInput.value = park.name;
    nameInput.readOnly = true;
    nameInput.style.backgroundColor = '#f1f5f9';
    nameInput.style.cursor = 'not-allowed';
  }

  const catSelect = document.getElementById('edit-otopark-category');
  if (catSelect) {
    catSelect.value = park.category || 'OSB / Sanayi Sitesi Otoparkları';
  }
  
  const catGroup = document.getElementById('group-otopark-category');
  if (catGroup) catGroup.style.display = 'none';

  document.getElementById('edit-otopark-title').value = park.companyTitle || '';
  document.getElementById('edit-otopark-tax-office').value = park.taxOffice || '';
  document.getElementById('edit-otopark-tax-number').value = park.taxNumber || '';
  document.getElementById('edit-otopark-bank').value = park.bankName || '';
  document.getElementById('edit-otopark-iban').value = park.iban || '';
  document.getElementById('edit-otopark-price-emp').value = park.priceEmployee || '';
  document.getElementById('edit-otopark-price-ext').value = park.priceExternal || '';
  document.getElementById('edit-otopark-support').value = park.supportPhone || '';
  document.getElementById('edit-otopark-status').value = park.isActive !== false ? 'active' : 'inactive';
  document.getElementById('edit-otopark-req-approval').checked = park.requiresManagementApproval === true;
  document.getElementById('edit-otopark-notif-emails').value = park.notificationEmails || '';
  document.getElementById('edit-otopark-summary-emails').value = park.summaryEmails || '';

  document.getElementById('otopark-modal-title').textContent = 'Otopark İşletmesi Düzenle';
  openModal('modal-otopark-edit');
}

async function loadOtoparks() {
  const OTOPARKS_KEY = 'parkexpert_otoparks';
  let otoparks = [];
  try {
    const res = await fetch('/api/otoparks');
    if (res.ok) {
      otoparks = await res.json();
        otoparks.forEach(p => {
          if (p.is_active !== undefined) p.isActive = p.is_active;
          if (p.company_title !== undefined) p.companyTitle = p.company_title;
          if (p.tax_office !== undefined) p.taxOffice = p.tax_office;
          if (p.tax_number !== undefined) p.taxNumber = p.tax_number;
          if (p.bank_name !== undefined) p.bankName = p.bank_name;
          if (p.price_employee !== undefined) p.priceEmployee = p.price_employee;
          if (p.price_external !== undefined) p.priceExternal = p.price_external;
          if (p.support_phone !== undefined) p.supportPhone = p.support_phone;
          if (p.notification_emails !== undefined) p.notificationEmails = p.notification_emails;
          if (p.summary_emails !== undefined) p.summaryEmails = p.summary_emails;
          if (p.requires_management_approval !== undefined) p.requiresManagementApproval = p.requires_management_approval;
        });
      localStorage.setItem(OTOPARKS_KEY, JSON.stringify(otoparks));
    }
  } catch (err) {
    console.error("Failed to load otoparks:", err);
  }
}

async function saveOtoparkConfig(event) {
  event.preventDefault();
  
  const token = localStorage.getItem('parkexpert_token');
  if (!token) {
    alert("Yetkisiz işlem! Lütfen giriş yapın.");
    return;
  }

  const id = document.getElementById('edit-otopark-id').value;
  const nameVal = document.getElementById('edit-otopark-name').value.trim();
  const categoryVal = document.getElementById('edit-otopark-category').value;
  const companyTitleVal = document.getElementById('edit-otopark-title').value.trim().toLocaleUpperCase('tr-TR');
  const taxOfficeVal = document.getElementById('edit-otopark-tax-office').value.trim().toLocaleUpperCase('tr-TR');
  const taxNumberVal = document.getElementById('edit-otopark-tax-number').value.trim();
  const bankNameVal = document.getElementById('edit-otopark-bank').value.trim().toLocaleUpperCase('tr-TR');
  const ibanVal = document.getElementById('edit-otopark-iban').value.trim().toUpperCase();
  const priceEmployeeVal = document.getElementById('edit-otopark-price-emp').value.trim().toLocaleUpperCase('tr-TR');
  const priceExternalVal = document.getElementById('edit-otopark-price-ext').value.trim().toLocaleUpperCase('tr-TR');
  const supportPhoneVal = document.getElementById('edit-otopark-support').value.trim();
  const statusVal = document.getElementById('edit-otopark-status').value;
  const notificationEmailsVal = document.getElementById('edit-otopark-notif-emails').value.trim();
  const summaryEmailsVal = document.getElementById('edit-otopark-summary-emails').value.trim();
  const requiresManagementApprovalVal = document.getElementById('edit-otopark-req-approval').checked;

  const OTOPARKS_KEY = 'parkexpert_otoparks';
  let existingTemplates = undefined;
  if (id) {
    const currentOtoparks = JSON.parse(localStorage.getItem(OTOPARKS_KEY)) || [];
    const existingPark = currentOtoparks.find(p => p.id === id);
    if (existingPark) {
      existingTemplates = existingPark.templates;
    }
  }

  const payload = {
    id: id || undefined,
    name: nameVal,
    category: categoryVal,
    companyTitle: companyTitleVal,
    taxOffice: taxOfficeVal,
    taxNumber: taxNumberVal,
    bankName: bankNameVal,
    iban: ibanVal,
    priceEmployee: priceEmployeeVal,
    priceExternal: priceExternalVal,
    supportPhone: supportPhoneVal,
    isActive: statusVal === 'active',
    templates: existingTemplates,
    notificationEmails: notificationEmailsVal,
    summaryEmails: summaryEmailsVal,
    requiresManagementApproval: requiresManagementApprovalVal
  };

  try {
    const res = await fetch('/api/otoparks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Otopark kaydedilirken hata oluştu.");
    }

    closeModal('modal-otopark-edit');
    await loadOtoparks();
    renderOtoparksTable();
    populateLocationFilter();

    alert("Otopark bilgileri başarıyla kaydedildi.");
  } catch (err) {
    console.error(err);
    alert(err.message);
  }
}

async function sendTestDailySummary(event) {
  if (event) event.preventDefault();

  const emailVal = document.getElementById('edit-otopark-summary-emails').value.trim();
  const otoparkName = document.getElementById('edit-otopark-name').value.trim();

  if (!emailVal) {
    alert("Lütfen önce Günlük Özet Rapor E-postaları alanına en az bir e-posta adresi yazın.");
    return;
  }

  const btn = document.getElementById('btn-test-summary-send');
  if (!btn) return;
  
  const originalHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="spinner-border spinner-border-sm" role="status" style="width: 10px; height: 10px; display: inline-block; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spinner-border .75s linear infinite; margin-right: 0.2rem;"></i> Gönderiliyor...';

  try {
    const res = await fetch('/api/send_test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: 'summary',
        email: emailVal,
        parkingLocation: otoparkName
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Rapor testi gönderilirken sunucu hatası oluştu.");
    }

    const data = await res.json();
    if (data.email && data.email.success) {
      alert(`Daily Summary test e-postası başarıyla gönderildi!\n\nAlıcılar: ${emailVal}\nKonum: ${otoparkName}`);
    } else {
      throw new Error(data.email?.error || "E-posta gönderimi başarısız oldu.");
    }
  } catch (err) {
    console.error(err);
    alert(`Test Raporu Gönderimi Başarısız!\n\nHata: ${err.message}`);
  } finally {
    btn.innerHTML = originalHTML;
    btn.disabled = false;
  }
}

async function toggleOtoparkStatus(otoparkId) {
  const token = localStorage.getItem('parkexpert_token');
  if (!token) {
    alert("Yetkisiz işlem! Lütfen giriş yapın.");
    return;
  }

  const OTOPARKS_KEY = 'parkexpert_otoparks';
  let otoparks = JSON.parse(localStorage.getItem(OTOPARKS_KEY)) || [];
  const park = otoparks.find(p => p.id === otoparkId);

  if (!park) return;

  const currentStatus = park.isActive !== false;
  
  const payload = {
    id: park.id,
    name: park.name,
    category: park.category,
    companyTitle: park.companyTitle,
    taxOffice: park.taxOffice,
    taxNumber: park.taxNumber,
    bankName: park.bankName,
    iban: park.iban,
    priceEmployee: park.priceEmployee,
    priceExternal: park.priceExternal,
    supportPhone: park.supportPhone,
    isActive: !currentStatus
  };

  try {
    const res = await fetch('/api/otoparks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Durum güncellenirken hata oluştu.");
    }

    await loadOtoparks();
    renderOtoparksTable();
  } catch (err) {
    console.error(err);
    alert(err.message);
  }
}

/* ==========================================================================
   PREMIUM COMPANY CLUSTERING & ANALYSIS CONTROLLERS
   ========================================================================== */

let currentAdminTab = 'applications';

function switchAdminTab(tabName) {
  const userJson = localStorage.getItem('parkexpert_user');
  const loggedInUser = userJson ? JSON.parse(userJson) : {};
  const admins = JSON.parse(localStorage.getItem(ADMIN_USERS_KEY)) || [];
  const activeAdminObj = admins.find(a => a.id === currentAdminUser) || loggedInUser;
  const activeRole = currentAdminUser === 'superadmin' ? 'superadmin' : (activeAdminObj.role || 'admin');

  if (activeRole === 'yonetim' && tabName !== 'applications') {
    alert("Bu sekmeye erişim yetkiniz bulunmamaktadır.");
    switchAdminTab('applications');
    return;
  }

  if ((tabName === 'otoparks' || tabName === 'admins' || tabName === 'settings' || tabName === 'sms-reports' || tabName === 'bulk-sms' || tabName === 'audit-logs' || tabName === 'backups') && currentAdminUser !== 'superadmin') {
    alert("Bu sekmeye erişim yetkiniz bulunmamaktadır.");
    switchAdminTab('applications');
    return;
  }
  currentAdminTab = tabName;

  // Update sidebar active classes
  const sidebarItems = document.querySelectorAll('.sidebar-menu .sidebar-item');
  sidebarItems.forEach(item => {
    item.classList.remove('active');
    if (item.id === `sidebar-tab-${tabName}`) {
      item.classList.add('active');
    }
  });
  const tabApp = document.getElementById('tab-applications');
  const tabExp = document.getElementById('tab-expirations');
  const tabComp = document.getElementById('tab-companies');
  const tabOto = document.getElementById('tab-otoparks');
  const tabAdm = document.getElementById('tab-admins');
  const tabAnalytic = document.getElementById('tab-analytics');
  const tabSet = document.getElementById('tab-settings');
  const tabSmsReports = document.getElementById('tab-sms-reports');
  const tabBulk = document.getElementById('tab-bulk-sms');
  const tabAuditLogs = document.getElementById('tab-audit-logs');
  
  const panelApp = document.getElementById('panel-applications');
  const panelExp = document.getElementById('panel-expirations');
  const panelComp = document.getElementById('panel-companies');
  const panelOto = document.getElementById('panel-otoparks');
  const panelAdm = document.getElementById('panel-admins');
  const panelAnalytic = document.getElementById('panel-analytics');
  const panelSet = document.getElementById('panel-settings');
  const panelSmsReports = document.getElementById('panel-sms-reports');
  const panelBulk = document.getElementById('panel-bulk-sms');
  const panelAuditLogs = document.getElementById('panel-audit-logs');

  if (!tabApp || !tabComp || !panelApp || !panelComp) return;

  // Reset active classes
  tabApp.classList.remove('active');
  if (tabExp) tabExp.classList.remove('active');
  tabComp.classList.remove('active');
  if (tabOto) tabOto.classList.remove('active');
  if (tabAdm) tabAdm.classList.remove('active');
  if (tabAnalytic) tabAnalytic.classList.remove('active');
  if (tabSet) tabSet.classList.remove('active');
  if (tabSmsReports) tabSmsReports.classList.remove('active');
  if (tabBulk) tabBulk.classList.remove('active');
  if (tabAuditLogs) tabAuditLogs.classList.remove('active');

  // Hide panels
  panelApp.style.display = 'none';
  if (panelExp) panelExp.style.display = 'none';
  panelComp.style.display = 'none';
  if (panelOto) panelOto.style.display = 'none';
  if (panelAdm) panelAdm.style.display = 'none';
  if (panelSet) panelSet.style.display = 'none';
  if (panelAnalytic) panelAnalytic.style.display = 'none';
  if (panelSmsReports) panelSmsReports.style.display = 'none';
  if (panelBulk) panelBulk.style.display = 'none';
  if (panelAuditLogs) panelAuditLogs.style.display = 'none';
  const panelBackups = document.getElementById('panel-backups');
  if (panelBackups) panelBackups.style.display = 'none';

  if (tabName === 'applications') {
    tabApp.classList.add('active');
    panelApp.style.display = 'block';
  } else if (tabName === 'expirations') {
    if (tabExp) tabExp.classList.add('active');
    if (panelExp) panelExp.style.display = 'block';
    renderExpirationsDashboard();
  } else if (tabName === 'companies') {
    tabComp.classList.add('active');
    panelComp.style.display = 'block';
    renderCompaniesTable(filteredApplications);
  } else if (tabName === 'otoparks') {
    if (tabOto) tabOto.classList.add('active');
    if (panelOto) panelOto.style.display = 'block';
    renderOtoparksTable();
  } else if (tabName === 'admins') {
    if (tabAdm) tabAdm.classList.add('active');
    if (panelAdm) panelAdm.style.display = 'block';
    renderAdminsTable();
    fetchActiveSessions();
  } else if (tabName === 'settings') {
    if (tabSet) tabSet.classList.add('active');
    if (panelSet) panelSet.style.display = 'block';
    loadSystemSettings();
  } else if (tabName === 'sms-reports') {
    if (tabSmsReports) tabSmsReports.classList.add('active');
    if (panelSmsReports) panelSmsReports.style.display = 'block';
    loadSMSReports();
  } else if (tabName === 'bulk-sms') {
    if (tabBulk) tabBulk.classList.add('active');
    if (panelBulk) panelBulk.style.display = 'block';
    loadOtoparksForBulkSms();
  } else if (tabName === 'audit-logs') {
    if (tabAuditLogs) tabAuditLogs.classList.add('active');
    if (panelAuditLogs) panelAuditLogs.style.display = 'block';
    loadAuditLogs();
  } else if (tabName === 'analytics') {
    if (tabAnalytic) tabAnalytic.classList.add('active');
    if (panelAnalytic) panelAnalytic.style.display = 'block';
    updateAnalyticsCharts(filteredApplications);
  } else if (tabName === 'backups') {
    const panelBackups = document.getElementById('panel-backups');
    if (panelBackups) panelBackups.style.display = 'block';
    loadBackupsList();
  }

  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }
}

function renderCompaniesTable(apps) {
  const container = document.getElementById('companies-grid-container');
  const countEl = document.getElementById('companies-results-count');
  if (!container) return;

  container.innerHTML = '';

  // 1. Group applications by company
  const groups = {};
  apps.forEach(app => {
    const rawCompany = app.company_name ? app.company_name.trim() : '';
    const companyKey = rawCompany ? rawCompany.toUpperCase() : 'SERBEST ÇALIŞAN';
    
    if (!groups[companyKey]) {
      groups[companyKey] = {
        name: rawCompany || 'SERBEST ÇALIŞAN',
        vehicles: 0,
        records: [],
        applications: []
      };
    }
    
    groups[companyKey].vehicles++;
    
    const plate = app.plate ? app.plate.trim().toUpperCase() : '';
    const ownerName = app.full_name ? app.full_name.trim() : 'Bilinmeyen Sürücü';
    
    groups[companyKey].records.push({
      plate: plate,
      owner: ownerName,
      appId: app.id,
      status: app.status
    });
    
    groups[companyKey].applications.push(app);
  });

  // 2. Convert groups to an array and sort
  const groupList = Object.values(groups);

  // Sort alphabetically by company name, but keep 'SERBEST ÇALIŞAN' at the very bottom!
  groupList.sort((a, b) => {
    const aName = a.name.toUpperCase();
    const bName = b.name.toUpperCase();
    
    if (aName === 'SERBEST ÇALIŞAN') return 1;
    if (bName === 'SERBEST ÇALIŞAN') return -1;
    return a.name.localeCompare(b.name, 'tr');
  });

  // Update company results count header
  if (countEl) {
    countEl.textContent = `(${groupList.length} firma / grup)`;
  }

  // 3. Handle Empty State
  if (groupList.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 4.5rem 2rem; background: #ffffff; border: 1px solid var(--color-border-light); border-radius: var(--radius-md);">
        <div class="empty-state-container" style="max-width: 420px; margin: 0 auto; display: flex; flex-direction: column; align-items: center; justify-content: center;">
          <div class="empty-state-icon" style="width: 70px; height: 70px; background: rgba(15, 59, 162, 0.05); border: 1px solid rgba(15, 59, 162, 0.1); border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--color-primary); margin-bottom: 1.25rem; box-shadow: var(--shadow-sm); animation: pulse 2s infinite ease-in-out;">
            <i data-lucide="building-2" style="width: 32px; height: 32px;"></i>
          </div>
          <h3 style="font-size: 1.1rem; font-weight: 700; color: var(--color-primary-dark); margin: 0 0 0.5rem 0;">Şu Anda Filtrelere Uygun Firma Bulunmamaktadır</h3>
          <p style="font-size: 0.85rem; color: var(--color-text-muted); line-height: 1.6; margin: 0 0 1.5rem 0; text-align: center;">
            Seçtiğiniz filtre değerlerine veya arama terimine uygun kümelenmiş firma verisi bulunamadı.
          </p>
        </div>
      </div>
    `;
    if (typeof lucide !== 'undefined') lucide.createIcons();
    return;
  }

  // 4. Render each company card
  groupList.forEach(group => {
    const isSerbest = group.name.toUpperCase() === 'SERBEST ÇALIŞAN';
    const badgeIcon = isSerbest ? 'users' : 'building-2';

    // Sort records by plate
    group.records.sort((a, b) => a.plate.localeCompare(b.plate, 'tr'));

    // Format combined records list
    const recordsHtml = group.records.map(rec => {
      const formatted = maskPlate(rec.plate);
      
      let statusClass = 'status-yeni';
      let statusText = 'YENİ / BEKLEYEN';
      if (rec.status === 'Onaylandı') {
        statusClass = 'status-onaylandi';
        statusText = 'ONAYLANDI';
      } else if (rec.status === 'Reddedildi') {
        statusClass = 'status-reddedildi';
        statusText = 'REDDEDİLDİ';
      }

      return `
        <div class="company-plate-row">
          <span class="mini-tr-plate" onclick="openDrawer('${rec.appId}')" title="Abonelik Detayını Gör">${formatted}</span>
          <span class="plate-owner-info">
            <i data-lucide="user" style="width: 14px; height: 14px; color: var(--color-text-muted);"></i>
            <span>${maskName(rec.owner)}</span>
          </span>
          <span class="status-badge-compact ${statusClass}">${statusText}</span>
        </div>
      `;
    }).join('');

    const card = document.createElement('article');
    card.className = 'company-card';
    card.innerHTML = `
      <div class="company-card-header">
        <div class="company-card-title">
          <div class="company-badge-icon">
            <i data-lucide="${badgeIcon}" style="width: 20px; height: 20px;"></i>
          </div>
          <span class="company-name-text" title="${group.name}">${group.name}</span>
        </div>
        <span class="company-vehicle-count">
          <i data-lucide="car" style="width: 12px; height: 12px;"></i>
          <span>${group.vehicles} Araç</span>
        </span>
      </div>

      <div class="company-plates-section">
        <span class="company-section-title">Kayıtlı Plakalar ve Aboneler</span>
        <div class="company-plates-list">
          ${recordsHtml || '<span style="font-size: 0.8rem; color: var(--color-text-muted); font-style: italic;">Kayıt Yok</span>'}
        </div>
      </div>
    `;
    container.appendChild(card);
  });

  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }
}

/* ==========================================================================
   YÖNETİCİ HIZLI DÜZENLEME & FİRMA AKTARIM KONTROLLERİ
   ========================================================================== */

function editApplicationPlate(appId) {
  const app = allApplications.find(a => a.id === appId);
  if (!app) return;

  const modal = document.getElementById('modal-quick-edit');
  const titleEl = document.getElementById('quick-edit-title');
  const contentEl = document.getElementById('quick-edit-content');
  const appIdInput = document.getElementById('quick-edit-app-id');
  const typeInput = document.getElementById('quick-edit-type');

  if (!modal || !contentEl || !appIdInput || !typeInput) return;

  if (titleEl) titleEl.textContent = "Plaka Güncelle";
  appIdInput.value = appId;
  typeInput.value = 'plate';

  contentEl.innerHTML = `
    <div class="filter-group" style="margin-bottom: 1rem; display: flex; flex-direction: column; gap: 0.375rem;">
      <label for="edit-plate-input" style="font-weight: 700; color: var(--color-primary-dark); font-size: 0.85rem;">Yeni Araç Plakası</label>
      <input type="text" id="edit-plate-input" value="${app.plate}" style="width: 100%; min-height: 42px; padding: 0.5rem 0.875rem; border: 1.5px solid var(--color-border-light); border-radius: var(--radius-sm); font-weight: 800; text-transform: uppercase; color: var(--color-text-dark); letter-spacing: 0.05em; font-family: monospace; font-size: 0.95rem; box-sizing: border-box;" required>
      <p style="font-size: 0.725rem; color: var(--color-text-muted); margin-top: 0.25rem; margin-bottom: 0;">Plaka otomatik olarak büyük harfe ve boşluksuz formata çevrilecektir.</p>
    </div>
  `;

  const editPlateInput = document.getElementById('edit-plate-input');
  if (editPlateInput) {
    editPlateInput.addEventListener('input', (e) => {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
    // Focus and set selection range
    editPlateInput.focus();
    editPlateInput.setSelectionRange(editPlateInput.value.length, editPlateInput.value.length);
  }

  modal.classList.add('active');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function editSubscriptionExpiry(appId) {
  const app = allApplications.find(a => a.id === appId);
  if (!app) return;

  const modal = document.getElementById('modal-quick-edit');
  const titleEl = document.getElementById('quick-edit-title');
  const contentEl = document.getElementById('quick-edit-content');
  const appIdInput = document.getElementById('quick-edit-app-id');
  const typeInput = document.getElementById('quick-edit-type');

  if (!modal || !contentEl || !appIdInput || !typeInput) return;

  if (titleEl) titleEl.textContent = "Abonelik Bitiş Tarihini Düzenle";
  appIdInput.value = appId;
  typeInput.value = 'expiry';

  let formattedDate = '';
  if (app.subscription_expires_at) {
    const d = new Date(app.subscription_expires_at);
    if (!isNaN(d.getTime())) {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      formattedDate = `${year}-${month}-${day}`;
    }
  }

  contentEl.innerHTML = `
    <div class="filter-group" style="margin-bottom: 1.25rem; display: flex; flex-direction: column; gap: 0.375rem;">
      <label for="edit-expiry-input" style="font-weight: 700; color: var(--color-primary-dark); font-size: 0.85rem;">Yeni Bitiş Tarihi</label>
      <input type="date" id="edit-expiry-input" value="${formattedDate}" style="width: 100%; min-height: 42px; padding: 0.5rem 0.875rem; border: 1.5px solid var(--color-border-light); border-radius: var(--radius-sm); font-size: 0.875rem; color: var(--color-text-dark); box-sizing: border-box;">
      <p style="font-size: 0.725rem; color: var(--color-text-muted); margin-top: 0.5rem; margin-bottom: 0;">Bu abonenin otopark abonelik bitiş tarihidir. Güncel bitiş tarihine göre otomatik hatırlatma ve geçiş yetkileri ayarlanacaktır.</p>
    </div>
  `;

  modal.classList.add('active');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function changeApplicationCompany(appId) {
  const app = allApplications.find(a => a.id === appId);
  if (!app) return;

  const modal = document.getElementById('modal-quick-edit');
  const titleEl = document.getElementById('quick-edit-title');
  const contentEl = document.getElementById('quick-edit-content');
  const appIdInput = document.getElementById('quick-edit-app-id');
  const typeInput = document.getElementById('quick-edit-type');

  if (!modal || !contentEl || !appIdInput || !typeInput) return;

  if (titleEl) titleEl.textContent = "Firmayı Düzenle / Aktar";
  appIdInput.value = appId;
  typeInput.value = 'company';

  // Get unique companies from allApplications
  const companiesSet = new Set(allApplications.map(a => a.company_name ? a.company_name.trim() : '').filter(Boolean));
  const companiesList = Array.from(companiesSet).sort((a, b) => a.localeCompare(b, 'tr'));

  // Build select options
  let optionsHtml = `<option value="SERBEST ÇALIŞAN" ${(!app.company_name || app.company_name === 'SERBEST ÇALIŞAN') ? 'selected' : ''}>SERBEST ÇALIŞAN (Şirketsiz)</option>`;
  companiesList.forEach(comp => {
    if (comp !== 'SERBEST ÇALIŞAN') {
      optionsHtml += `<option value="${comp}" ${(app.company_name && app.company_name.trim() === comp) ? 'selected' : ''}>${comp}</option>`;
    }
  });
  optionsHtml += `<option value="__NEW__">[ + Yeni Firma Oluştur ve Aktar ]</option>`;

  contentEl.innerHTML = `
    <div class="filter-group" style="margin-bottom: 1.25rem; display: flex; flex-direction: column; gap: 0.375rem;">
      <label for="edit-company-select" style="font-weight: 700; color: var(--color-primary-dark); font-size: 0.85rem;">Mevcut Firmaya Aktar</label>
      <select id="edit-company-select" onchange="toggleNewCompanyField()" style="width: 100%; min-height: 42px; padding: 0.5rem 0.875rem; border: 1.5px solid var(--color-border-light); border-radius: var(--radius-sm); font-size: 0.875rem; color: var(--color-text-dark); background-color: #ffffff; box-sizing: border-box;">
        ${optionsHtml}
      </select>
    </div>

    <div class="filter-group" id="group-new-company-field" style="margin-bottom: 1rem; display: none; flex-direction: column; gap: 0.375rem;">
      <label for="edit-company-new-input" style="font-weight: 700; color: var(--color-primary-dark); font-size: 0.85rem;">Yeni Firma / Kurum Adı</label>
      <input type="text" id="edit-company-new-input" style="width: 100%; min-height: 42px; padding: 0.5rem 0.875rem; border: 1.5px solid var(--color-border-light); border-radius: var(--radius-sm); font-weight: 700; color: var(--color-text-dark); box-sizing: border-box;">
      <p style="font-size: 0.725rem; color: var(--color-text-muted); margin-top: 0.25rem; margin-bottom: 0;">Yeni oluşturulacak firma otomatik büyük harfle kaydedilir.</p>
    </div>
  `;

  const editCompanyNewInput = document.getElementById('edit-company-new-input');
  if (editCompanyNewInput) {
    editCompanyNewInput.addEventListener('input', (e) => {
      const start = e.target.selectionStart;
      const end = e.target.selectionEnd;
      e.target.value = e.target.value.toLocaleUpperCase('tr-TR');
      e.target.setSelectionRange(start, end);
    });
  }

  modal.classList.add('active');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function toggleNewCompanyField() {
  const select = document.getElementById('edit-company-select');
  const groupNew = document.getElementById('group-new-company-field');
  const inputNew = document.getElementById('edit-company-new-input');
  
  if (select && groupNew && inputNew) {
    if (select.value === '__NEW__') {
      groupNew.style.display = 'flex';
      inputNew.required = true;
      inputNew.focus();
    } else {
      groupNew.style.display = 'none';
      inputNew.required = false;
      inputNew.value = '';
    }
  }
}

async function saveQuickEdit(event) {
  event.preventDefault();
  const appId = document.getElementById('quick-edit-app-id').value;
  const type = document.getElementById('quick-edit-type').value;

  const appIndex = allApplications.findIndex(a => a.id === appId);
  if (appIndex === -1) return;

  const token = localStorage.getItem('parkexpert_token');
  if (!token) {
    alert("Yetkisiz işlem! Lütfen tekrar giriş yapın.");
    return;
  }

  let updatePayload = { id: appId };
  let inputVal = '';
  let targetCompany = '';

  if (type === 'plate') {
    inputVal = document.getElementById('edit-plate-input').value.trim().toUpperCase();
    if (!inputVal) return;
    updatePayload.plate_number = inputVal;
  } else if (type === 'company') {
    const selectVal = document.getElementById('edit-company-select').value;
    if (selectVal === '__NEW__') {
      targetCompany = document.getElementById('edit-company-new-input').value.trim().toLocaleUpperCase('tr-TR');
    } else {
      targetCompany = selectVal === 'SERBEST ÇALIŞAN' ? '' : selectVal;
    }
    updatePayload.company_name = targetCompany;
  } else if (type === 'expiry') {
    const expiryInput = document.getElementById('edit-expiry-input');
    if (expiryInput) {
      if (!expiryInput.value) {
        alert("Lütfen geçerli bir tarih seçiniz.");
        return;
      }
      const d = new Date(expiryInput.value);
      d.setHours(23, 59, 59, 999);
      updatePayload.subscription_expires_at = d.toISOString();
    }
  }

  try {
    const res = await fetch("/api/applications", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify(updatePayload)
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Güncelleme sırasında hata oluştu.");
    }

    // Update locally
    if (type === 'plate') {
      allApplications[appIndex].plate = inputVal;
      allApplications[appIndex].plate_number = inputVal;
    } else if (type === 'company') {
      allApplications[appIndex].company_name = targetCompany;
    } else if (type === 'expiry') {
      allApplications[appIndex].subscription_expires_at = updatePayload.subscription_expires_at;
    }

    // Close modal
    closeModal('modal-quick-edit');

    // Refresh interface filters, tables, and stats
    populateCompanyFilter();
    applyFilters();
    if (currentAdminTab === 'expirations') {
      renderExpirationsDashboard();
    }

    // Reopen drawer to refresh values
    openDrawer(appId);

    alert("Değişiklikler başarıyla kaydedildi.");
  } catch (err) {
    console.error("Failed to save quick edit:", err);
    alert("Kaydedilemedi: " + err.message);
  }
}

async function deleteCurrentApplication() {
  const token = localStorage.getItem('parkexpert_token');
  if (!token) {
    alert("Yetkisiz işlem! Lütfen giriş yapın.");
    return;
  }
  if (!currentAppId) return;

  if (confirm("Bu abonelik başvurusunu tamamen silmek istediğinize emin misiniz?\n\nBu işlem geri alınamaz!")) {
    try {
      const res = await fetch(`/api/applications?id=${encodeURIComponent(currentAppId)}`, {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${token}`
        }
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Başvuru silinirken hata oluştu.");
      }

      await loadApplications();
      applyFilters();

      const drawer = document.getElementById('drawer-overlay');
      if (drawer) drawer.classList.remove('active');

      alert("Başvuru başarıyla silindi.");
    } catch (err) {
      console.error(err);
      alert(err.message);
    }
  }
}

async function populateActiveUserSelect() {
  const select = document.getElementById('active-user-role');
  if (!select) return;

  const token = localStorage.getItem('parkexpert_token');
  const userJson = localStorage.getItem('parkexpert_user');
  if (!token || !userJson) return;

  const loggedInUser = JSON.parse(userJson);

  if (loggedInUser.role === 'superadmin') {
    try {
      const res = await fetch('/api/admins', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (res.status === 401 || res.status === 403) {
        const adminLayout = document.querySelector('.admin-layout');
        const overlay = document.getElementById('modal-login-overlay');
        if (adminLayout) adminLayout.style.display = 'none';
        if (overlay) overlay.style.display = 'flex';
        
        alert("Oturumunuz sonlandırıldı veya geçersiz. Lütfen tekrar giriş yapın.");
        handleAdminLogout();
        return;
      }
      if (res.ok) {
        const admins = await res.json();
        localStorage.setItem(ADMIN_USERS_KEY, JSON.stringify(admins));

        select.innerHTML = '<option value="superadmin">Süper Yönetici</option>';
        admins.forEach(admin => {
          const opt = document.createElement('option');
          opt.value = admin.id;
          opt.textContent = admin.name;
          select.appendChild(opt);
        });
      }
    } catch (err) {
      console.error("Failed to fetch admins:", err);
    }
  } else {
    select.innerHTML = `<option value="${loggedInUser.id}">${loggedInUser.name}</option>`;
    select.disabled = true;
    select.style.cursor = 'default';
  }

  const admins = JSON.parse(localStorage.getItem(ADMIN_USERS_KEY)) || [];
  const savedUser = localStorage.getItem('parkexpert_current_admin') || loggedInUser.id;
  if (savedUser === 'superadmin' || admins.some(a => a.id === savedUser)) {
    currentAdminUser = savedUser;
  } else {
    currentAdminUser = loggedInUser.id;
    localStorage.setItem('parkexpert_current_admin', loggedInUser.id);
  }
  select.value = currentAdminUser;
}

function handleUserRoleChange() {
  const select = document.getElementById('active-user-role');
  if (!select) return;

  const val = select.value;
  currentAdminUser = val;
  localStorage.setItem('parkexpert_current_admin', val);

  const avatar = document.getElementById('current-user-avatar');
  const subtext = document.getElementById('active-user-subtext');
  const adminUserBlock = document.getElementById('admin-user-selector-block');
  const tabOto = document.getElementById('tab-otoparks');
  const tabAdm = document.getElementById('tab-admins');
  const tabSet = document.getElementById('tab-settings');
  const tabSmsReports = document.getElementById('tab-sms-reports');
  const tabBulk = document.getElementById('tab-bulk-sms');
  const tabAuditLogs = document.getElementById('tab-audit-logs');
  const dangerZone = document.querySelector('.sidebar-footer');
  
  const admins = JSON.parse(localStorage.getItem(ADMIN_USERS_KEY)) || [];
  
  const avatarImg = document.getElementById('current-user-avatar-img');
  const avatarInitials = document.getElementById('current-user-avatar-initials');

  if (val === 'superadmin') {
    if (avatarImg) {
      avatarImg.src = `/api/document?path=avatars/superadmin.jpg&_t=${Date.now()}`;
      avatarImg.style.display = 'block';
    }
    if (avatarInitials) {
      avatarInitials.textContent = 'SA';
      avatarInitials.style.display = 'inline-flex';
    }
    if (avatar) {
      avatar.className = 'user-avatar user-avatar-superadmin';
      avatar.setAttribute('title', 'Profil fotoğrafını değiştirmek için tıklayın');
      avatar.style.cursor = 'pointer';
      avatar.onclick = () => {
        const fileInput = document.getElementById('header-avatar-upload-input');
        if (fileInput) fileInput.click();
      };
    }
    if (subtext) subtext.textContent = 'Sistem Sahibi';
    if (adminUserBlock) {
      adminUserBlock.className = 'admin-user admin-user-superadmin';
    }
    if (tabOto) tabOto.style.display = 'inline-flex';
    if (tabAdm) tabAdm.style.display = 'inline-flex';
    if (tabSet) tabSet.style.display = 'inline-flex';
    if (tabSmsReports) tabSmsReports.style.display = 'inline-flex';
    if (tabBulk) tabBulk.style.display = 'inline-flex';
    if (tabAuditLogs) tabAuditLogs.style.display = 'inline-flex';
    if (dangerZone) dangerZone.style.display = 'block';

    if (document.getElementById('sidebar-tab-expirations')) document.getElementById('sidebar-tab-expirations').style.display = 'inline-flex';
    if (document.getElementById('sidebar-tab-companies')) document.getElementById('sidebar-tab-companies').style.display = 'inline-flex';
    if (document.getElementById('sidebar-tab-analytics')) document.getElementById('sidebar-tab-analytics').style.display = 'inline-flex';

    const sidebarSys = document.getElementById('sidebar-category-system');
    if (sidebarSys) sidebarSys.style.display = 'block';
  } else {
    const sidebarSys = document.getElementById('sidebar-category-system');
    if (sidebarSys) sidebarSys.style.display = 'none';

    const userJson = localStorage.getItem('parkexpert_user');
    const loggedInUser = userJson ? JSON.parse(userJson) : {};
    const adminObj = admins.find(a => a.id === val) || loggedInUser;
    const userRole = adminObj.role || 'admin';
    
    if (adminObj && adminObj.name) {
      const initials = adminObj.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
      if (avatarImg) {
        avatarImg.src = `/api/document?path=avatars/${adminObj.id}.jpg&_t=${Date.now()}`;
        avatarImg.style.display = 'block';
      }
      if (avatarInitials) {
        avatarInitials.textContent = initials;
        avatarInitials.style.display = 'inline-flex';
      }
      if (avatar) {
        avatar.className = 'user-avatar user-avatar-representative';
        avatar.removeAttribute('title');
        avatar.style.cursor = 'default';
        avatar.onclick = null;
      }
      if (subtext) {
        if (userRole === 'yonetim') {
          subtext.textContent = `Yönetim • @${adminObj.username || 'yonetim'}`;
        } else {
          subtext.textContent = `Temsilci • @${adminObj.username || 'admin'}`;
        }
      }
    }
    if (adminUserBlock) {
      adminUserBlock.className = 'admin-user admin-user-representative';
    }

    if (userRole === 'yonetim') {
      // Hide everything except applications
      if (document.getElementById('sidebar-tab-expirations')) document.getElementById('sidebar-tab-expirations').style.display = 'none';
      if (document.getElementById('sidebar-tab-companies')) document.getElementById('sidebar-tab-companies').style.display = 'none';
      if (document.getElementById('sidebar-tab-analytics')) document.getElementById('sidebar-tab-analytics').style.display = 'none';
      if (tabOto) tabOto.style.display = 'none';
      if (tabAdm) tabAdm.style.display = 'none';
      if (tabSet) tabSet.style.display = 'none';
      if (tabSmsReports) tabSmsReports.style.display = 'none';
      if (tabBulk) tabBulk.style.display = 'none';
      if (tabAuditLogs) tabAuditLogs.style.display = 'none';
      if (dangerZone) dangerZone.style.display = 'none';

      if (currentAdminTab !== 'applications') {
        switchAdminTab('applications');
      }
    } else {
      // Standard admin representative
      if (document.getElementById('sidebar-tab-expirations')) document.getElementById('sidebar-tab-expirations').style.display = 'inline-flex';
      if (document.getElementById('sidebar-tab-companies')) document.getElementById('sidebar-tab-companies').style.display = 'inline-flex';
      if (document.getElementById('sidebar-tab-analytics')) document.getElementById('sidebar-tab-analytics').style.display = 'inline-flex';
      if (tabOto) tabOto.style.display = 'none';
      if (tabAdm) tabAdm.style.display = 'none';
      if (tabSet) tabSet.style.display = 'none';
      if (tabSmsReports) tabSmsReports.style.display = 'none';
      if (tabBulk) tabBulk.style.display = 'none';
      if (tabAuditLogs) tabAuditLogs.style.display = 'none';
      if (dangerZone) dangerZone.style.display = 'none';
  
      if (currentAdminTab === 'otoparks' || currentAdminTab === 'admins' || currentAdminTab === 'settings' || currentAdminTab === 'sms-reports' || currentAdminTab === 'bulk-sms' || currentAdminTab === 'audit-logs' || currentAdminTab === 'backups') {
        switchAdminTab('applications');
      }
    }
  }
  
  const testAppBtn = document.getElementById('btn-create-test-app');
  if (testAppBtn) {
    testAppBtn.style.display = val === 'superadmin' ? 'inline-flex' : 'none';
  }

  loadApplications();
  populateLocationFilter();
  applyFilters();
}

async function handleHeaderAvatarUpload(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  if (file.size > 2 * 1024 * 1024) {
    alert("Profil fotoğrafı boyutu en fazla 2MB olabilir.");
    return;
  }

  const token = localStorage.getItem('parkexpert_token');
  if (!token) {
    alert("Oturumunuz bulunamadı! Lütfen tekrar giriş yapın.");
    return;
  }

  const photoBase64 = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.readAsDataURL(file);
  });

  const select = document.getElementById('active-user-role');
  if (!select) return;
  const currentAdminVal = select.value;

  try {
    const res = await fetch('/api/admins', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        id: currentAdminVal,
        photo_base64: photoBase64,
        is_self_avatar: true
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Profil fotoğrafı yüklenirken hata oluştu.");
    }

    const avatarImg = document.getElementById('current-user-avatar-img');
    if (avatarImg) {
      avatarImg.src = `/api/document?path=avatars/${currentAdminVal}.jpg&_t=${Date.now()}`;
      avatarImg.style.display = 'block';
    }
    
    if (currentAdminVal !== 'superadmin') {
      renderAdminsTable();
    }
    
    alert("Profil fotoğrafınız başarıyla güncellendi.");
  } catch (err) {
    console.error(err);
    alert(err.message);
  } finally {
    input.value = '';
  }
}

function populateLocationFilter() {
  const filterSelect = document.getElementById('filter-location');
  const expiryFilterSelect = document.getElementById('expiry-filter-location');
  if (!filterSelect && !expiryFilterSelect) return;

  const OTOPARKS_KEY = 'parkexpert_otoparks';
  const otoparks = JSON.parse(localStorage.getItem(OTOPARKS_KEY)) || [];

  const currentSelection = filterSelect ? filterSelect.value : '';
  const currentExpirySelection = expiryFilterSelect ? expiryFilterSelect.value : '';

  if (filterSelect) filterSelect.innerHTML = '<option value="">Tüm Konumlar</option>';
  if (expiryFilterSelect) expiryFilterSelect.innerHTML = '<option value="">Tüm Konumlar</option>';

  let allowedOtoparks = otoparks;
  if (currentAdminUser !== 'superadmin') {
    const admins = JSON.parse(localStorage.getItem(ADMIN_USERS_KEY)) || [];
    const activeAdminObj = admins.find(a => a.id === currentAdminUser);
    if (activeAdminObj) {
      const allowedNames = activeAdminObj.otoparks || [];
      allowedOtoparks = otoparks.filter(park => allowedNames.includes(park.name));
    } else {
      allowedOtoparks = [];
    }
  }

  const grouped = {};
  allowedOtoparks.forEach(park => {
    if (!grouped[park.category]) {
      grouped[park.category] = [];
    }
    grouped[park.category].push(park);
  });

  for (const [category, list] of Object.entries(grouped)) {
    let optgroup = null;
    let expiryOptgroup = null;

    if (filterSelect) {
      optgroup = document.createElement('optgroup');
      optgroup.label = category;
    }
    if (expiryFilterSelect) {
      expiryOptgroup = document.createElement('optgroup');
      expiryOptgroup.label = category;
    }

    list.forEach(park => {
      if (filterSelect) {
        const option = document.createElement('option');
        option.value = park.name;
        option.textContent = park.name;
        optgroup.appendChild(option);
      }
      if (expiryFilterSelect) {
        const option = document.createElement('option');
        option.value = park.name;
        option.textContent = park.name;
        expiryOptgroup.appendChild(option);
      }
    });

    if (filterSelect && optgroup) filterSelect.appendChild(optgroup);
    if (expiryFilterSelect && expiryOptgroup) expiryFilterSelect.appendChild(expiryOptgroup);
  }

  if (filterSelect) {
    if (allowedOtoparks.some(park => park.name === currentSelection)) {
      filterSelect.value = currentSelection;
    } else {
      filterSelect.value = '';
    }
  }

  if (expiryFilterSelect) {
    if (allowedOtoparks.some(park => park.name === currentExpirySelection)) {
      expiryFilterSelect.value = currentExpirySelection;
    } else {
      expiryFilterSelect.value = '';
    }
  }
}

function renderAdminsTable() {
  const container = document.getElementById('admins-grid-container');
  const countEl = document.getElementById('admins-results-count');
  if (!container) return;

  const admins = JSON.parse(localStorage.getItem(ADMIN_USERS_KEY)) || [];
  if (countEl) {
    countEl.textContent = `(${admins.length} yetkili)`;
  }

  container.innerHTML = '';

  if (admins.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 3rem 1.5rem; color: var(--color-text-muted); font-size: 0.95rem;">
        Sistemde tanımlı yetkili bulunamadı. "Yeni Yönetici Tanımla" butonu ile ekleyebilirsiniz.
      </div>
    `;
    return;
  }

  admins.forEach(admin => {
    const card = document.createElement('div');
    card.className = 'otopark-card';
    
    const otoparkBadges = admin.otoparks.map(oto => 
      `<span class="otopark-card__category otopark-card__category--sanayi" style="margin: 0.15rem 0.25rem 0.15rem 0; display: inline-block; font-size: 0.7rem; padding: 0.2rem 0.5rem; text-transform: none;">${oto}</span>`
    ).join('');

    const adminRole = admin.role || 'admin';
    const roleLabel = adminRole === 'yonetim' ? 'Site/AVM Yönetimi' : 'ParkExpert Operatörü';
    const roleStyle = adminRole === 'yonetim' ? 'background: rgba(245, 158, 11, 0.1); color: #d97706;' : 'background: rgba(16, 185, 129, 0.1); color: #16a34a;';

    const initials = admin.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
    card.innerHTML = `
      <div class="otopark-card__header" style="display: flex; align-items: center; gap: 0.75rem; width: 100%;">
        <div class="user-avatar" style="width: 42px; height: 42px; position: relative; overflow: hidden; background: var(--color-gradient-accent); border: 2px solid rgba(15, 59, 162, 0.1); flex-shrink: 0;">
          <img src="/api/document?path=avatars/${admin.id}.jpg" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" style="position: absolute; top:0; left:0; width:100%; height:100%; object-fit: cover;">
          <span style="display: flex; width:100%; height:100%; align-items:center; justify-content:center; font-weight:800; font-size:0.9rem;">${initials}</span>
        </div>
        <div style="display: flex; flex-direction: column; gap: 0.15rem; flex: 1;">
          <div class="otopark-card__name" style="margin: 0; font-size: 0.95rem; font-weight: 700;">${admin.name}</div>
          <div style="display: flex; gap: 0.25rem; align-items: center; margin-top: 0.15rem; flex-wrap: wrap;">
            <span class="otopark-card__category otopark-card__category--avm" style="background: rgba(15, 59, 162, 0.1); color: var(--color-primary-dark); font-weight: 700; width: fit-content; margin: 0; padding: 0.1rem 0.4rem; font-size: 0.7rem; text-transform: none;">@${admin.username}</span>
            <span class="otopark-card__category" style="${roleStyle} font-weight: 700; width: fit-content; margin: 0; padding: 0.1rem 0.4rem; font-size: 0.7rem; text-transform: none; border-radius: 4px;">${roleLabel}</span>
          </div>
        </div>
      </div>
      <div class="otopark-card__body" style="padding: 1.25rem 1.5rem; display: flex; flex-direction: column; gap: 0.75rem;">
        <div class="otopark-card__field otopark-card__field--full" style="display: flex; flex-direction: column; gap: 0.25rem;">
          <span class="otopark-card__label" style="margin-bottom: 0.15rem;">İletişim Bilgileri</span>
          <div style="font-size: 0.825rem; color: var(--color-text-dark); display: flex; flex-direction: column; gap: 0.25rem;">
            <span style="display: flex; align-items: center; gap: 0.35rem;"><i data-lucide="phone" style="width: 13px; height: 13px; color: var(--color-text-muted);"></i> ${admin.phone || '<span style="color: var(--color-text-muted); font-style: italic;">Telefon tanımlanmamış</span>'}</span>
            <span style="display: flex; align-items: center; gap: 0.35rem;"><i data-lucide="mail" style="width: 13px; height: 13px; color: var(--color-text-muted);"></i> ${admin.email || '<span style="color: var(--color-text-muted); font-style: italic;">E-posta tanımlanmamış</span>'}</span>
          </div>
        </div>
        <div class="otopark-card__field otopark-card__field--full">
          <span class="otopark-card__label" style="margin-bottom: 0.25rem;">Yetkili Olduğu Otoparklar</span>
          <div style="margin-top: 0.25rem;">
            ${otoparkBadges || '<span style="color: var(--color-text-muted); font-style: italic;">Yetkili otopark atanmamış</span>'}
          </div>
        </div>
      </div>
      <div class="otopark-card__footer" style="margin-top: auto; border-top: 1px solid var(--color-border-light); padding-top: 1rem; display: flex; justify-content: flex-end; gap: 0.75rem;">
        <button class="otopark-card__edit-btn" onclick="editAdmin('${admin.id}')" style="background: none; border: none; font-size: 0.8rem; color: var(--color-primary); cursor: pointer; display: flex; align-items: center; gap: 0.25rem; font-weight: 600;">
          <i data-lucide="edit-2" style="width: 12px; height: 12px;"></i> Düzenle
        </button>
        <button class="otopark-card__edit-btn" onclick="deleteAdmin('${admin.id}')" style="background: none; border: none; font-size: 0.8rem; color: #ef4444; cursor: pointer; display: flex; align-items: center; gap: 0.25rem; font-weight: 600;">
          <i data-lucide="trash-2" style="width: 12px; height: 12px; color: #ef4444;"></i> Sil
        </button>
      </div>
    `;

    container.appendChild(card);
  });

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function renderExpirationsDashboard() {
  const tbody = document.getElementById('expirations-table-body');
  const totalEl = document.getElementById('stats-exp-total');
  const expiredEl = document.getElementById('stats-exp-expired');
  const warning3dEl = document.getElementById('stats-exp-warning3d');
  const warning7dEl = document.getElementById('stats-exp-warning7d');
  const countResultsEl = document.getElementById('expirations-results-count');

  if (!tbody) return;

  const searchQuery = (document.getElementById('expiry-search-query')?.value || '').toLowerCase().trim();
  const filterLocation = document.getElementById('expiry-filter-location')?.value || '';
  const filterStatus = document.getElementById('expiry-filter-status')?.value || '';

  // 1. Get ONLY approved applications
  const approvedApps = allApplications.filter(app => app.status === 'Onaylandı');

  // 2. Map and calculate remaining days
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const appsWithDays = approvedApps.map(app => {
    let remainingDays = null;
    if (app.subscription_expires_at) {
      const expiry = new Date(app.subscription_expires_at);
      expiry.setHours(23, 59, 59, 999);
      const diffTime = expiry.getTime() - today.getTime();
      remainingDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    }
    return { ...app, remainingDays };
  });

  // Calculate overall metrics
  const countTotal = appsWithDays.length;
  const countExpired = appsWithDays.filter(a => a.remainingDays !== null && a.remainingDays <= 0).length;
  const countWarning3d = appsWithDays.filter(a => a.remainingDays !== null && a.remainingDays > 0 && a.remainingDays <= 3).length;
  const countWarning7d = appsWithDays.filter(a => a.remainingDays !== null && a.remainingDays > 3 && a.remainingDays <= 7).length;

  if (totalEl) totalEl.textContent = countTotal;
  if (expiredEl) expiredEl.textContent = countExpired;
  if (warning3dEl) warning3dEl.textContent = countWarning3d;
  if (warning7dEl) warning7dEl.textContent = countWarning7d;

  // 3. Apply Filters
  let filtered = appsWithDays.filter(app => {
    // Location Filter
    if (filterLocation && app.parking_location !== filterLocation) return false;

    // Search Query
    if (searchQuery) {
      const matchesName = app.full_name?.toLowerCase().includes(searchQuery);
      const matchesPlate = app.plate?.toLowerCase().includes(searchQuery) || app.plate_number?.toLowerCase().includes(searchQuery);
      if (!matchesName && !matchesPlate) return false;
    }

    // Expiry Status Filter
    if (filterStatus) {
      if (filterStatus === 'expired') {
        return app.remainingDays !== null && app.remainingDays <= 0;
      } else if (filterStatus === 'warning3d') {
        return app.remainingDays !== null && app.remainingDays > 0 && app.remainingDays <= 3;
      } else if (filterStatus === 'warning7d') {
        return app.remainingDays !== null && app.remainingDays > 3 && app.remainingDays <= 7;
      } else if (filterStatus === 'active') {
        return app.remainingDays === null || app.remainingDays > 7;
      }
    }

    return true;
  });

  // 4. Sort: Expired and soon-to-expire at the top
  filtered.sort((a, b) => {
    if (a.remainingDays === null && b.remainingDays === null) return 0;
    if (a.remainingDays === null) return 1;
    if (b.remainingDays === null) return -1;
    return a.remainingDays - b.remainingDays;
  });

  if (countResultsEl) {
    countResultsEl.textContent = `(${filtered.length} abone gösteriliyor)`;
  }

  tbody.innerHTML = '';

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; padding: 3rem 1.5rem; color: var(--color-text-muted); font-size: 0.95rem;">
          Arama kriterlerine uygun aktif abone bulunamadı.
        </td>
      </tr>
    `;
    return;
  }

  filtered.forEach(app => {
    const tr = document.createElement('tr');
    tr.id = `expiry-row-${app.id}`;

    // Format Plate
    const plateFormatted = maskPlate(app.plate || app.plate_number || '');

    // Kalan Gün Rozeti (Badge)
    let badgeHtml = '';
    if (app.remainingDays === null) {
      badgeHtml = `<span class="status-badge" style="background-color: #f1f5f9; color: #64748b; font-weight: 700; border: 1px solid #cbd5e1;">Belirtilmemiş</span>`;
    } else if (app.remainingDays < 0) {
      badgeHtml = `<span class="status-badge" style="background-color: #fef2f2; color: #dc2626; font-weight: 700; border: 1px solid #fca5a5;">Süresi Doldu (${Math.abs(app.remainingDays)} gün önce)</span>`;
    } else if (app.remainingDays === 0) {
      badgeHtml = `<span class="status-badge" style="background-color: #fef2f2; color: #dc2626; font-weight: 700; border: 1px solid #fca5a5;">Bugün Son Gün! ⚠️</span>`;
    } else if (app.remainingDays <= 3) {
      badgeHtml = `<span class="status-badge" style="background-color: #fff7ed; color: #ea580c; font-weight: 700; border: 1px solid #ffedd5;">${app.remainingDays} Gün Kaldı ⏳</span>`;
    } else if (app.remainingDays <= 7) {
      badgeHtml = `<span class="status-badge" style="background-color: #fef9c3; color: #a16207; font-weight: 700; border: 1px solid #fef08a;">${app.remainingDays} Gün Kaldı</span>`;
    } else {
      badgeHtml = `<span class="status-badge" style="background-color: #f0fdf4; color: #15803d; font-weight: 700; border: 1px solid #bbf7d0;">Aktif (${app.remainingDays} gün)</span>`;
    }

    tr.innerHTML = `
      <td style="font-weight: 700; color: var(--color-primary-dark);">${app.id}</td>
      <td>
        <div class="col-customer">
          <span class="customer-name" style="font-weight: 700; color: var(--color-text-dark);">${maskName(app.full_name)}</span>
          <span class="customer-details" style="display: block; font-size: 0.75rem; color: var(--color-text-muted);">${app.subscription_type} &bull; ${maskPhone(app.phone)}</span>
        </div>
      </td>
      <td><span class="col-plate">${plateFormatted}</span></td>
      <td><span class="col-otopark">${app.parking_location}</span></td>
      <td style="text-align: center;">${badgeHtml}</td>
      <td>${app.subscription_expires_at ? formatDateShortTR(app.subscription_expires_at) : '<span style="color:var(--color-text-muted);font-style:italic;">Belirtilmemiş</span>'}</td>
      <td style="text-align: center;">
        <div style="display: flex; gap: 0.25rem; justify-content: center;">
          <button class="btn-table-action" onclick="openDrawer('${app.id}')" title="Abonelik Detayını Gör" style="padding: 0.35rem; min-height: 28px;">
            <i data-lucide="eye" style="width: 14px; height: 14px;"></i>
          </button>
          <button class="btn-table-action" onclick="editSubscriptionExpiry('${app.id}')" title="Bitiş Tarihini Düzenle" style="padding: 0.35rem; min-height: 28px; color: var(--color-primary);">
            <i data-lucide="calendar" style="width: 14px; height: 14px;"></i>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  if (typeof lucide !== 'undefined') lucide.createIcons();

  // Update reminder conversion tracking metrics and mini logs
  updateReminderConversionStats();
}
window.renderExpirationsDashboard = renderExpirationsDashboard;

async function updateReminderConversionStats() {
  const tbody = document.getElementById('reminder-mini-logs-body');
  const rateValueEl = document.getElementById('conversion-rate-value');
  const rateBarEl = document.getElementById('conversion-rate-bar');
  const totalSentEl = document.getElementById('conversion-total-sent');
  const totalRenewedEl = document.getElementById('conversion-total-renewed');

  if (!tbody) return;

  const token = localStorage.getItem('parkexpert_token');
  if (!token) return;

  try {
    const response = await fetch(`/api/reminder_logs?_t=${Date.now()}`, {
      headers: {
        "Authorization": `Bearer ${token}`
      }
    });

    if (!response.ok) {
      throw new Error("Hatırlatıcı günlükleri yüklenemedi.");
    }

    const logs = await response.json();
    if (!Array.isArray(logs)) {
      throw new Error("Geçersiz veri formatı.");
    }

    const totalSent = logs.length;
    const convertedCount = logs.filter(l => l.converted).length;
    const conversionRate = totalSent > 0 ? Math.round((convertedCount / totalSent) * 100) : 0;

    if (rateValueEl) rateValueEl.textContent = `%${conversionRate}`;
    if (rateBarEl) rateBarEl.style.width = `${conversionRate}%`;
    if (totalSentEl) totalSentEl.textContent = totalSent;
    if (totalRenewedEl) totalRenewedEl.textContent = convertedCount;

    tbody.innerHTML = '';
    if (logs.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; padding: 2rem 1rem; color: var(--color-text-muted); font-style: italic;">
            Henüz gönderim kaydı bulunmuyor.
          </td>
        </tr>
      `;
      return;
    }

    // Render top 5 logs
    const topLogs = logs.slice(0, 5);
    topLogs.forEach(log => {
      const tr = document.createElement('tr');
      
      const plateFormatted = maskPlate(log.plate_number || '');
      
      // Channel formatting
      let channelHtml = '';
      if (log.channel === 'sms') {
        channelHtml = `💬 SMS`;
      } else if (log.channel === 'whatsapp') {
        channelHtml = `🟢 WA`;
      } else {
        channelHtml = `✉️ E-Posta`;
      }
      
      const dateFormatted = log.sent_at ? formatDateShortTR(log.sent_at) : '-';
      
      const statusBadge = log.converted 
        ? `<span class="status-badge" style="background-color: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0; font-weight: 700; font-size: 0.75rem; padding: 0.15rem 0.4rem; white-space: nowrap;">Yenilendi ✅</span>`
        : `<span class="status-badge" style="background-color: #f1f5f9; color: #64748b; border: 1px solid #cbd5e1; font-weight: 700; font-size: 0.75rem; padding: 0.15rem 0.4rem; white-space: nowrap;">Bekliyor ⏳</span>`;
      
      tr.innerHTML = `
        <td style="padding: 0.6rem 1rem; font-weight: 700;">${plateFormatted}</td>
        <td style="padding: 0.6rem 1rem;">${channelHtml}</td>
        <td style="padding: 0.6rem 1rem; text-align: center; font-weight: 600;">${log.days_left} Gün</td>
        <td style="padding: 0.6rem 1rem;">${dateFormatted}</td>
        <td style="padding: 0.6rem 1rem; text-align: center;">${statusBadge}</td>
      `;
      
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error("Failed to load/update reminder conversion metrics:", err);
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; padding: 2rem 1rem; color: var(--color-danger); font-size: 0.8rem;">
          Dönüşüm verileri yüklenemedi: ${err.message}
        </td>
      </tr>
    `;
  }
}

function exportExpirationsToExcel() {
  const searchQuery = (document.getElementById('expiry-search-query')?.value || '').toLowerCase().trim();
  const filterLocation = document.getElementById('expiry-filter-location')?.value || '';
  const filterStatus = document.getElementById('expiry-filter-status')?.value || '';

  const approvedApps = allApplications.filter(app => app.status === 'Onaylandı');
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const appsWithDays = approvedApps.map(app => {
    let remainingDays = null;
    if (app.subscription_expires_at) {
      const expiry = new Date(app.subscription_expires_at);
      expiry.setHours(23, 59, 59, 999);
      const diffTime = expiry.getTime() - today.getTime();
      remainingDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    }
    return { ...app, remainingDays };
  });

  // Apply same filters
  let filtered = appsWithDays.filter(app => {
    if (filterLocation && app.parking_location !== filterLocation) return false;
    if (searchQuery) {
      const matchesName = app.full_name?.toLowerCase().includes(searchQuery);
      const matchesPlate = app.plate?.toLowerCase().includes(searchQuery) || app.plate_number?.toLowerCase().includes(searchQuery);
      if (!matchesName && !matchesPlate) return false;
    }
    if (filterStatus) {
      if (filterStatus === 'expired') {
        return app.remainingDays !== null && app.remainingDays <= 0;
      } else if (filterStatus === 'warning3d') {
        return app.remainingDays !== null && app.remainingDays > 0 && app.remainingDays <= 3;
      } else if (filterStatus === 'warning7d') {
        return app.remainingDays !== null && app.remainingDays > 3 && app.remainingDays <= 7;
      } else if (filterStatus === 'active') {
        return app.remainingDays === null || app.remainingDays > 7;
      }
    }
    return true;
  });

  // Sort
  filtered.sort((a, b) => {
    if (a.remainingDays === null && b.remainingDays === null) return 0;
    if (a.remainingDays === null) return 1;
    if (b.remainingDays === null) return -1;
    return a.remainingDays - b.remainingDays;
  });

  if (filtered.length === 0) {
    alert("Dışa aktarılacak herhangi bir abone bulunmamaktadır.");
    return;
  }

  const headers = [
    "Abonelik No",
    "Ad Soyad",
    "Araç Plakası",
    "Otopark Konumu",
    "Abonelik Tipi",
    "Telefon",
    "E-posta",
    "Kalan Gün",
    "Bitiş Tarihi",
    "Başvuru Tarihi"
  ];

  const rows = filtered.map(app => {
    let kalanGunText = '';
    if (app.remainingDays === null) kalanGunText = 'Belirtilmemiş';
    else if (app.remainingDays < 0) kalanGunText = `Süresi Doldu (${Math.abs(app.remainingDays)} gün)`;
    else if (app.remainingDays === 0) kalanGunText = 'Bugün Son Gün';
    else kalanGunText = `${app.remainingDays} gün`;

    return [
      app.id,
      app.full_name,
      app.plate || app.plate_number || '',
      app.parking_location,
      app.subscription_type || '',
      app.phone || '',
      app.email || '',
      kalanGunText,
      app.subscription_expires_at ? formatDateShortTR(app.subscription_expires_at) : 'Belirtilmemiş',
      formatDateTR(app.created_at || app.date_applied)
    ];
  });

  const csvContent = [
    headers.join(";"),
    ...rows.map(r => r.map(cell => {
      let cellStr = String(cell);
      if (cellStr.includes(";") || cellStr.includes('"') || cellStr.includes("\n")) {
        cellStr = `"${cellStr.replace(/"/g, '""')}"`;
      }
      return cellStr;
    }).join(";"))
  ].join("\n");

  const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
  const blob = new Blob([bom, csvContent], { type: "text/csv;charset=utf-8;" });
  
  const dateStr = new Date().toISOString().split('T')[0];
  const filename = `ParkExpert_Abonelik_Takip_Raporu_${dateStr}.csv`;
  
  const link = document.createElement("a");
  if (link.download !== undefined) {
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}
window.exportExpirationsToExcel = exportExpirationsToExcel;

function populateAdminOtoparksCheckboxes(selectedOtoparks = []) {
  const container = document.getElementById('edit-admin-otoparks-checkboxes');
  if (!container) return;

  const OTOPARKS_KEY = 'parkexpert_otoparks';
  const otoparks = JSON.parse(localStorage.getItem(OTOPARKS_KEY)) || [];

  container.innerHTML = '';

  if (otoparks.length === 0) {
    container.innerHTML = '<span style="color: var(--color-text-muted); font-style: italic;">Sistemde kayıtlı otopark bulunamadı.</span>';
    return;
  }

  otoparks.forEach(park => {
    const isChecked = selectedOtoparks.includes(park.name) ? 'checked' : '';
    const wrapper = document.createElement('label');
    wrapper.style.display = 'flex';
    wrapper.style.alignItems = 'center';
    wrapper.style.gap = '0.5rem';
    wrapper.style.fontSize = '0.85rem';
    wrapper.style.color = 'var(--color-text-dark)';
    wrapper.style.cursor = 'pointer';

    wrapper.innerHTML = `
      <input type="checkbox" name="admin-otopark-choice" value="${park.name}" ${isChecked} style="cursor: pointer; width: 15px; height: 15px;">
      <span>${park.name}</span>
    `;

    container.appendChild(wrapper);
  });
}

function openCreateAdminModal() {
  document.getElementById('form-admin-edit').reset();
  const photoInput = document.getElementById('edit-admin-photo');
  if (photoInput) photoInput.value = '';
  document.getElementById('edit-admin-id').value = '';
  document.getElementById('edit-admin-username').readOnly = false;
  document.getElementById('edit-admin-username').style.backgroundColor = '#ffffff';
  document.getElementById('edit-admin-username').style.cursor = 'text';
  document.getElementById('admin-edit-title').textContent = 'Yeni Yönetici Yetkilendir';
  
  const roleSelect = document.getElementById('edit-admin-role');
  if (roleSelect) roleSelect.value = 'admin';

  const passInput = document.getElementById('edit-admin-password');
  if (passInput) {
    passInput.required = true;
    passInput.value = '';
  }
  const passStar = document.getElementById('admin-password-required-star');
  if (passStar) passStar.style.display = 'inline';

  const phoneInput = document.getElementById('edit-admin-phone');
  const emailInput = document.getElementById('edit-admin-email');
  if (phoneInput) phoneInput.value = '';
  if (emailInput) emailInput.value = '';

  populateAdminOtoparksCheckboxes([]);
  openModal('modal-admin-edit');
}

function editAdmin(adminId) {
  const admins = JSON.parse(localStorage.getItem(ADMIN_USERS_KEY)) || [];
  const adminObj = admins.find(a => a.id === adminId);
  if (!adminObj) return;

  const photoInput = document.getElementById('edit-admin-photo');
  if (photoInput) photoInput.value = '';

  document.getElementById('edit-admin-id').value = adminObj.id;
  document.getElementById('edit-admin-name').value = adminObj.name;
  document.getElementById('edit-admin-username').value = adminObj.username;
  document.getElementById('edit-admin-username').readOnly = false;
  document.getElementById('edit-admin-username').style.backgroundColor = '#ffffff';
  document.getElementById('edit-admin-username').style.cursor = 'text';
  document.getElementById('admin-edit-title').textContent = 'Yönetici Bilgilerini Düzenle';

  const roleSelect = document.getElementById('edit-admin-role');
  if (roleSelect) roleSelect.value = adminObj.role || 'admin';

  const passInput = document.getElementById('edit-admin-password');
  if (passInput) {
    passInput.required = false;
    passInput.value = '';
  }
  const passStar = document.getElementById('admin-password-required-star');
  if (passStar) passStar.style.display = 'none';

  const phoneInput = document.getElementById('edit-admin-phone');
  const emailInput = document.getElementById('edit-admin-email');
  if (phoneInput) phoneInput.value = adminObj.phone || '';
  if (emailInput) emailInput.value = adminObj.email || '';

  populateAdminOtoparksCheckboxes(adminObj.otoparks || []);
  openModal('modal-admin-edit');
}

async function saveAdminConfig(event) {
  event.preventDefault();
  
  const token = localStorage.getItem('parkexpert_token');
  if (!token) {
    alert("Yetkisiz işlem! Lütfen tekrar giriş yapın.");
    return;
  }

  const id = document.getElementById('edit-admin-id').value;
  const name = document.getElementById('edit-admin-name').value.trim();
  const username = document.getElementById('edit-admin-username').value.trim().toLowerCase().replace(/\s+/g, '');
  const password = document.getElementById('edit-admin-password').value;
  const phone = document.getElementById('edit-admin-phone')?.value.trim() || '';
  const email = document.getElementById('edit-admin-email')?.value.trim() || '';
  
  const checkboxes = document.querySelectorAll('input[name="admin-otopark-choice"]:checked');
  const selectedOtoparks = Array.from(checkboxes).map(cb => cb.value);

  if (selectedOtoparks.length === 0) {
    alert("Lütfen en az bir otopark seçiniz.");
    return;
  }

  if (phone) {
    const cleanPhone = phone.replace(/\D/g, "");
    if (cleanPhone.length < 10) {
      alert("Lütfen geçerli bir telefon numarası giriniz.");
      return;
    }
  }

  if (!id && !password) {
    alert("Yeni yöneticiler için şifre zorunludur.");
    return;
  }

  if (password) {
    const hasLength = password.length >= 8;
    const hasUpper = /[A-Z]/.test(password);
    const hasLower = /[a-z]/.test(password);
    const hasDigit = /[0-9]/.test(password);
    const hasSpecial = /[^A-Za-z0-9]/.test(password);

    if (!hasLength || !hasUpper || !hasLower || !hasDigit || !hasSpecial) {
      alert("Şifre en az 8 karakter uzunluğunda olmalı, en az bir büyük harf, bir küçük harf, bir rakam ve bir özel karakter içermelidir.");
      return;
    }
  }

  const photoInput = document.getElementById('edit-admin-photo');
  let photoBase64 = null;
  if (photoInput && photoInput.files && photoInput.files[0]) {
    const file = photoInput.files[0];
    if (file.size > 2 * 1024 * 1024) {
      alert("Profil fotoğrafı boyutu en fazla 2MB olabilir.");
      return;
    }
    photoBase64 = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.readAsDataURL(file);
    });
  }

  const role = document.getElementById('edit-admin-role')?.value || 'admin';

  const payload = {
    id: id || undefined,
    name,
    username,
    otoparks: selectedOtoparks,
    phone: phone || null,
    email: email || null,
    role,
    photo_base64: photoBase64
  };

  if (password) {
    payload.password = password;
  }

  try {
    const res = await fetch('/api/admins', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Yönetici kaydedilirken hata oluştu.");
    }

    closeModal('modal-admin-edit');
    await populateActiveUserSelect();
    renderAdminsTable();
    alert("Yönetici yetkilendirmesi başarıyla kaydedildi.");
  } catch (err) {
    console.error(err);
    alert(err.message);
  }
}

async function deleteAdmin(adminId) {
  const token = localStorage.getItem('parkexpert_token');
  if (!token) {
    alert("Yetkisiz işlem! Lütfen giriş yapın.");
    return;
  }

  if (confirm("Bu yönetici yetkilendirmesini silmek istediğinize emin misiniz?")) {
    try {
      const res = await fetch(`/api/admins?id=${encodeURIComponent(adminId)}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Yönetici silinirken hata oluştu.");
      }

      if (currentAdminUser === adminId) {
        currentAdminUser = 'superadmin';
        localStorage.setItem('parkexpert_current_admin', 'superadmin');
      }
      
      await populateActiveUserSelect();
      renderAdminsTable();
      handleUserRoleChange();
      alert("Yönetici yetkileri kaldırıldı.");
    } catch (err) {
      console.error(err);
      alert(err.message);
    }
  }
}

function openCreateOtoparkModal() {
  document.getElementById('otopark-edit-form').reset();
  document.getElementById('edit-otopark-id').value = '';
  
  const nameInput = document.getElementById('edit-otopark-name');
  if (nameInput) {
    nameInput.readOnly = false;
    nameInput.style.backgroundColor = '#ffffff';
    nameInput.style.cursor = 'text';
  }

  const catGroup = document.getElementById('group-otopark-category');
  if (catGroup) catGroup.style.display = 'block';

  document.getElementById('otopark-modal-title').textContent = 'Yeni Otopark İşletmesi Ekle';
  openModal('modal-otopark-edit');
}

async function deleteOtopark(parkId) {
  const token = localStorage.getItem('parkexpert_token');
  if (!token) {
    alert("Yetkisiz işlem! Lütfen giriş yapın.");
    return;
  }
  if (confirm("Bu otopark işletmesini sistemden tamamen kaldırmak istediğinize emin misiniz?\n\nBu işlem otoparka kayıtlı ödeme ve fatura tanımlarını silecek, ancak mevcut başvuruları etkilemeyecektir.")) {
    try {
      const res = await fetch(`/api/otoparks?id=${encodeURIComponent(parkId)}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Otopark silinirken hata oluştu.");
      }

      await loadOtoparks();
      renderOtoparksTable();
      populateLocationFilter();
      alert("Otopark başarıyla kaldırıldı.");
    } catch (err) {
      console.error(err);
      alert(err.message);
    }
  }
}

async function sendTestNotification(event) {
  if (event) event.preventDefault();
  
  const emailInput = document.getElementById('test-input-email');
  const phoneInput = document.getElementById('test-input-phone');
  
  if (emailInput && !emailInput.value) {
    emailInput.value = "talha.emre.calargun@parkexpert.net";
  }
  if (phoneInput && !phoneInput.value) {
    phoneInput.value = "5372939874";
  }

  // Reset scheduling inputs on modal open
  const scheduleEnabled = document.getElementById('test-schedule-enabled');
  const scheduleTime = document.getElementById('test-input-schedule-time');
  const scheduleContainer = document.getElementById('test-schedule-time-container');
  const testFlashSms = document.getElementById('test-flash-sms-enabled');
  if (scheduleEnabled) scheduleEnabled.checked = false;
  if (scheduleTime) scheduleTime.value = '';
  if (scheduleContainer) scheduleContainer.style.display = 'none';
  if (testFlashSms) testFlashSms.checked = false;
  
  const modal = document.getElementById('test-modal');
  if (modal) {
    modal.style.display = 'flex';
  }
}

function closeTestModal(event) {
  if (event) event.preventDefault();
  const modal = document.getElementById('test-modal');
  if (modal) {
    modal.style.display = 'none';
  }
}

function toggleTestScheduleTime(checked) {
  const container = document.getElementById('test-schedule-time-container');
  if (container) {
    container.style.display = checked ? 'flex' : 'none';
  }
}
window.toggleTestScheduleTime = toggleTestScheduleTime;

async function submitTestNotification(event) {
  if (event) event.preventDefault();
  
  const email = document.getElementById('test-input-email').value.trim();
  const phone = document.getElementById('test-input-phone').value.trim();
  
  if (!email || !phone) {
    alert("Lütfen tüm alanları doldurun.");
    return;
  }

  const scheduleEnabled = document.getElementById('test-schedule-enabled')?.checked;
  const scheduleTimeVal = document.getElementById('test-input-schedule-time')?.value;

  if (scheduleEnabled && !scheduleTimeVal) {
    alert("Lütfen ileri tarihli gönderim için tarih ve saat seçin.");
    return;
  }

  let scheduledDate = null;
  if (scheduleEnabled && scheduleTimeVal) {
    // Treat the input as Turkey Time (UTC+3)
    const parsedDate = new Date(scheduleTimeVal + ":00+03:00");
    if (!isNaN(parsedDate.getTime())) {
      scheduledDate = parsedDate.toISOString();
    }
  }
  
  const btn = document.getElementById('btn-test-submit');
  if (!btn) return;
  
  const originalHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="spinner-border spinner-border-sm" role="status" style="width: 12px; height: 12px; display: inline-block; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spinner-border .75s linear infinite; margin-right: 0.25rem;"></i> Gönderiliyor...';

  const flashSms = document.getElementById('test-flash-sms-enabled')?.checked || false;

  try {
    const res = await fetch('/api/send_test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email, phone, scheduledDate, flashSms })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Test gönderimi sırasında sunucu hatası oluştu.");
    }

    const data = await res.json();
    
    let statusMsg = `Mock Başvuru Kodu: ${data.mockAppId}\n\n`;
    statusMsg += `📧 E-posta (${email}): ${data.email.success ? '✅ Gönderildi' : '❌ HATA: ' + data.email.error}\n`;
    statusMsg += `💬 WhatsApp (${phone}): ${data.whatsapp.success ? '✅ Gönderildi' : '❌ HATA: ' + data.whatsapp.error}\n`;
    statusMsg += `📱 SMS (${phone}): ${data.sms.success ? '✅ Gönderildi' : '❌ HATA: ' + data.sms.error}`;

    alert(`Test Sonucu:\n\n${statusMsg}`);
    
    closeTestModal();

  } catch (err) {
    console.error(err);
    alert(`Test Gönderimi Başarısız!\n\nHata: ${err.message}`);
  } finally {
    btn.innerHTML = originalHTML;
    btn.disabled = false;
  }
}

// ==========================================================================
// REAL-TIME AUDIO & BROWSER LIVE ALERTS SYSTEM
// ==========================================================================

function startLiveTracking() {
  if (liveTrackingInterval) return;
  
  const dot = document.getElementById('live-tracking-dot');
  const text = document.getElementById('live-tracking-text');
  if (dot) {
    dot.style.background = '#10b981';
    dot.style.boxShadow = '0 0 8px #10b981';
  }
  if (text) text.textContent = 'Canlı Takip Aktif';

  liveTrackingInterval = setInterval(async () => {
    await pollApplications();
  }, 15000); // Poll every 15 seconds
}

async function pollApplications() {
  const token = localStorage.getItem('parkexpert_token');
  if (!token) return;

  try {
    const response = await fetch(`/api/applications?_t=${Date.now()}`, {
      headers: {
        "Authorization": `Bearer ${token}`
      }
    });

    if (!response.ok) return;
    const apps = await response.json();
    
    let hasNewApp = false;
    apps.forEach(app => {
      if (!trackedAppIds.has(app.id)) {
        trackedAppIds.add(app.id);
        if (!isInitialLoad) {
          hasNewApp = true;
          showLiveAlertToast(app);
        }
      }
    });
    
    if (isInitialLoad) {
      isInitialLoad = false;
    }
    
    if (hasNewApp) {
      allApplications = apps;
      allApplications.forEach(app => {
        app.plate = app.plate_number;
        app.files = {
          ruhsat: app.ruhsat_url,
          kimlik: app.kimlik_url,
          vergi: app.vergi_url || '',
          calisma: app.calisma_url || '',
          dekont: app.dekont_url,
          sirkuler: app.sirkuler_url || ''
        };
        
        const isSermaye = app.subscription_type === 'Kurumsal (LTD. / A.Ş.)';
        const isSahis = app.subscription_type === 'Kurumsal (Şahıs Şirketi)';
        const companyType = isSermaye ? 'sermaye' : (isSahis ? 'sahis' : 'bireysel');
        
        app.billing = {
          company_type: companyType,
          company: app.company_name || app.full_name,
          tax_office: app.tax_office || '',
          tax_no: app.tax_number || app.tc_no,
          address: app.home_address || ''
        };
      });
      
      filteredApplications = [...allApplications];
      populateCompanyFilter();
      applyFilters();
    }
  } catch (err) {
    console.error("Background polling failed:", err);
  }
}

function showLiveAlertToast(app) {
  let container = document.getElementById('live-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'live-toast-container';
    container.style.position = 'fixed';
    container.style.bottom = '20px';
    container.style.right = '20px';
    container.style.zIndex = '9999';
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.gap = '10px';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.style.background = '#ffffff';
  toast.style.borderLeft = '5px solid #10b981';
  toast.style.borderRadius = '8px';
  toast.style.boxShadow = '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)';
  toast.style.border = '1px solid rgba(16, 185, 129, 0.15)';
  toast.style.padding = '1.25rem';
  toast.style.width = '320px';
  toast.style.display = 'flex';
  toast.style.gap = '12px';
  toast.style.alignItems = 'flex-start';
  toast.style.transform = 'translateX(120%)';
  toast.style.transition = 'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1)';
  
  const iconDiv = document.createElement('div');
  iconDiv.style.background = 'rgba(16, 185, 129, 0.1)';
  iconDiv.style.borderRadius = '50%';
  iconDiv.style.padding = '8px';
  iconDiv.style.display = 'flex';
  iconDiv.style.alignItems = 'center';
  iconDiv.style.justifyContent = 'center';
  iconDiv.innerHTML = '<i data-lucide="bell" style="width: 18px; height: 18px; color: #10b981;"></i>';
  toast.appendChild(iconDiv);
  
  const contentDiv = document.createElement('div');
  contentDiv.style.flex = '1';
  contentDiv.style.textAlign = 'left';
  contentDiv.innerHTML = `
    <h4 style="margin: 0 0 4px 0; font-size: 0.875rem; font-weight: 800; color: var(--color-primary-dark);">YENİ BAŞVURU GELDİ! 🌟</h4>
    <p style="margin: 0; font-size: 0.8rem; font-weight: 700; color: var(--color-text-dark); text-transform: uppercase;">🚗 ${app.plate_number || app.plate}</p>
    <p style="margin: 2px 0 0 0; font-size: 0.75rem; color: var(--color-text-muted);">${app.full_name}</p>
    <p style="margin: 2px 0 0 0; font-size: 0.7rem; color: var(--color-text-muted); font-style: italic;">📍 ${app.parking_location}</p>
  `;
  toast.appendChild(contentDiv);
  
  const closeBtn = document.createElement('button');
  closeBtn.style.background = 'none';
  closeBtn.style.border = 'none';
  closeBtn.style.cursor = 'pointer';
  closeBtn.style.color = '#94a3b8';
  closeBtn.style.fontSize = '1.25rem';
  closeBtn.style.padding = '0';
  closeBtn.style.lineHeight = '1';
  closeBtn.innerHTML = '&times;';
  closeBtn.onclick = () => {
    toast.style.transform = 'translateX(120%)';
    setTimeout(() => toast.remove(), 400);
  };
  toast.appendChild(closeBtn);

  container.appendChild(toast);
  
  if (typeof lucide !== 'undefined') lucide.createIcons({ node: toast });

  setTimeout(() => {
    toast.style.transform = 'translateX(0)';
  }, 50);

  playNotificationChime();
  triggerBrowserNotification(app);

  setTimeout(() => {
    if (toast.parentNode) {
      toast.style.transform = 'translateX(120%)';
      setTimeout(() => toast.remove(), 400);
    }
  }, 8000);
}

function playNotificationChime() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    
    const osc1 = audioCtx.createOscillator();
    const gain1 = audioCtx.createGain();
    osc1.connect(gain1);
    gain1.connect(audioCtx.destination);
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(659.25, audioCtx.currentTime);
    gain1.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain1.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
    osc1.start(audioCtx.currentTime);
    osc1.stop(audioCtx.currentTime + 0.4);
    
    const osc2 = audioCtx.createOscillator();
    const gain2 = audioCtx.createGain();
    osc2.connect(gain2);
    gain2.connect(audioCtx.destination);
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(880.00, audioCtx.currentTime + 0.1);
    gain2.gain.setValueAtTime(0.12, audioCtx.currentTime + 0.1);
    gain2.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);
    osc2.start(audioCtx.currentTime + 0.1);
    osc2.stop(audioCtx.currentTime + 0.5);
    
    const osc3 = audioCtx.createOscillator();
    const gain3 = audioCtx.createGain();
    osc3.connect(gain3);
    gain3.connect(audioCtx.destination);
    osc3.type = 'sine';
    osc3.frequency.setValueAtTime(1109.73, audioCtx.currentTime + 0.2);
    gain3.gain.setValueAtTime(0.10, audioCtx.currentTime + 0.2);
    gain3.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.7);
    osc3.start(audioCtx.currentTime + 0.2);
    osc3.stop(audioCtx.currentTime + 0.7);

  } catch (e) {
    console.error("Audio playback error:", e);
  }
}

function triggerBrowserNotification(app) {
  if (!("Notification" in window)) return;
  
  if (Notification.permission === "granted") {
    new Notification("Yeni Başvuru Geldi! 🚗", {
      body: `${app.plate_number || app.plate} - ${app.full_name}\n📍 ${app.parking_location}`,
      icon: "/assets/logo_square.png"
    });
  }
}

function initBrowserNotifications() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

/* ==========================================================================
   ADMIN PREMIUM ANALYTICS CHARTS & SUMMARY CONTROLLERS
   ========================================================================== */

let chartRevenueOtopark = null;
let chartSubscriptionDistribution = null;
let chartTrendApplications = null;
let chartOtoparkOccupancy = null;
let chartConversionRates = null;

function getAppDate(app) {
  const val = app.created_at || app.date_applied;
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

function parsePrice(priceStr) {
  if (!priceStr) return 0;
  if (typeof priceStr === 'number') return priceStr;
  let clean = priceStr.replace('TL', '').trim();
  clean = clean.replace(/[,.]00$/, '');
  clean = clean.replace(/[^0-9]/g, '');
  const val = parseInt(clean, 10);
  return isNaN(val) ? 0 : val;
}

function formatCurrencyTR(val) {
  return new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 }).format(val) + ' TL';
}

function updateAnalyticsCharts(apps) {
  if (typeof Chart === 'undefined') {
    console.warn("Chart.js library is not loaded yet.");
    return;
  }

  const OTOPARKS_KEY = 'parkexpert_otoparks';
  const otoparks = JSON.parse(localStorage.getItem(OTOPARKS_KEY)) || [];

  // 1. Calculate summary metrics (only Approved ones contribute to Revenue)
  let totalRevenue = 0;
  let bireyselRevenue = 0;
  let kurumsalRevenue = 0;

  let totalApprovedCount = 0;
  let bireyselApprovedCount = 0;
  let kurumsalApprovedCount = 0;

  apps.forEach(app => {
    if (app.status === 'Onaylandı') {
      const park = otoparks.find(p => p.name === app.parking_location) || {};
      const isKurumsal = app.subscription_type && app.subscription_type.includes('Kurumsal') && app.parking_location !== 'Birlik Sanayi Sitesi - Beylikdüzü';
      const priceStr = isKurumsal ? (park.priceExternal || '2400 TL') : (park.priceEmployee || '1200 TL');
      const price = parsePrice(priceStr);

      totalRevenue += price;
      totalApprovedCount++;
      if (isKurumsal) {
        kurumsalRevenue += price;
        kurumsalApprovedCount++;
      } else {
        bireyselRevenue += price;
        bireyselApprovedCount++;
      }
    }
  });

  // Update DOM values
  const totalRevenueEl = document.getElementById('analytics-total-revenue');
  const indivRevenueEl = document.getElementById('analytics-individual-revenue');
  const indivCountEl = document.getElementById('analytics-individual-count');
  const corpRevenueEl = document.getElementById('analytics-corporate-revenue');
  const corpCountEl = document.getElementById('analytics-corporate-count');

  if (totalRevenueEl) totalRevenueEl.textContent = formatCurrencyTR(totalRevenue);
  if (indivRevenueEl) indivRevenueEl.textContent = formatCurrencyTR(bireyselRevenue);
  if (corpRevenueEl) corpRevenueEl.textContent = formatCurrencyTR(kurumsalRevenue);

  const bireyselPct = totalApprovedCount > 0 ? Math.round((bireyselApprovedCount / totalApprovedCount) * 100) : 0;
  const kurumsalPct = totalApprovedCount > 0 ? Math.round((kurumsalApprovedCount / totalApprovedCount) * 100) : 0;

  if (indivCountEl) indivCountEl.textContent = `${bireyselApprovedCount} onaylı abonelik (%${bireyselPct})`;
  if (corpCountEl) corpCountEl.textContent = `${kurumsalApprovedCount} onaylı abonelik (%${kurumsalPct})`;

  // 2. Identify chronological month keys present in the filtered/all apps
  const monthKeys = new Set();
  apps.forEach(app => {
    const d = getAppDate(app);
    if (d) {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      monthKeys.add(`${year}-${month}`);
    }
  });

  const sortedMonthKeys = Array.from(monthKeys).sort();

  // Handle empty state gracefully
  if (sortedMonthKeys.length === 0) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    sortedMonthKeys.push(`${year}-${month}`);
  }

  const turkishMonths = {
    "01": "Ocak", "02": "Şubat", "03": "Mart", "04": "Nisan", "05": "Mayıs", "06": "Haziran",
    "07": "Temmuz", "08": "Ağustos", "09": "Eylül", "10": "Ekim", "11": "Kasım", "12": "Aralık"
  };
  const monthLabels = sortedMonthKeys.map(key => {
    const [year, month] = key.split("-");
    return `${turkishMonths[month]} ${year}`;
  });

  // 3. Compile Chart 1: Revenue per Otopark stacked by Month
  const otoparkNames = new Set(otoparks.map(p => p.name));
  apps.forEach(app => {
    if (app.parking_location) otoparkNames.add(app.parking_location);
  });
  const sortedOtoparks = Array.from(otoparkNames).sort();

  const otoparkRevenues = {};
  sortedOtoparks.forEach(name => {
    otoparkRevenues[name] = {};
    sortedMonthKeys.forEach(mKey => {
      otoparkRevenues[name][mKey] = 0;
    });
  });

  apps.forEach(app => {
    if (app.status === 'Onaylandı') {
      const d = getAppDate(app);
      if (d) {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const mKey = `${year}-${month}`;
        const name = app.parking_location;

        const park = otoparks.find(p => p.name === name) || {};
        const isKurumsal = app.subscription_type && app.subscription_type.includes('Kurumsal') && name !== 'Birlik Sanayi Sitesi - Beylikdüzü';
        const priceStr = isKurumsal ? (park.priceExternal || '2400 TL') : (park.priceEmployee || '1200 TL');
        const price = parsePrice(priceStr);

        if (otoparkRevenues[name] && otoparkRevenues[name][mKey] !== undefined) {
          otoparkRevenues[name][mKey] += price;
        }
      }
    }
  });

  const colorsPalette = [
    '#3b82f6', // Bright Blue
    '#f59e0b', // Amber/Gold
    '#10b981', // Emerald Green
    '#ec4899', // Pink
    '#8b5cf6', // Violet
    '#ef4444', // Red
    '#06b6d4', // Cyan
    '#f97316', // Orange
    '#14b8a6', // Teal
    '#a855f7', // Purple
    '#6366f1', // Indigo
    '#84cc16'  // Lime
  ];

  const datasetsRevenue = sortedOtoparks.map((name, index) => {
    const color = colorsPalette[index % colorsPalette.length];
    const data = sortedMonthKeys.map(mKey => otoparkRevenues[name][mKey]);
    return {
      label: name,
      data: data,
      backgroundColor: color,
      borderColor: color,
      borderWidth: 0,
      borderRadius: 6,
      stack: 'Stack 0'
    };
  });

  // Filter out otoparks with no revenue to avoid legend clutter, but show all if total revenue is 0
  const datasetsRevenueFiltered = datasetsRevenue.filter(ds => ds.data.reduce((a, b) => a + b, 0) > 0);
  const finalDatasetsRevenue = datasetsRevenueFiltered.length > 0 ? datasetsRevenueFiltered : datasetsRevenue;

  const canvasOtopark = document.getElementById('chart-revenue-otopark');
  if (canvasOtopark) {
    const ctxRevenue = canvasOtopark.getContext('2d');
    if (chartRevenueOtopark) chartRevenueOtopark.destroy();
    chartRevenueOtopark = new Chart(ctxRevenue, {
      type: 'bar',
      data: {
        labels: monthLabels,
        datasets: finalDatasetsRevenue
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'top',
            labels: {
              color: '#0f172a',
              font: { family: 'Outfit, Inter, sans-serif', size: 11, weight: '500' }
            }
          },
          tooltip: {
            callbacks: {
              label: function(context) {
                let label = context.dataset.label || '';
                if (label) label += ': ';
                if (context.parsed.y !== null) {
                  label += formatCurrencyTR(context.parsed.y);
                }
                return label;
              }
            }
          }
        },
        scales: {
          x: {
            stacked: true,
            grid: { color: 'rgba(0, 0, 0, 0.05)' },
            ticks: {
              color: '#64748b',
              font: { family: 'Outfit, Inter, sans-serif' }
            }
          },
          y: {
            stacked: true,
            grid: { color: 'rgba(0, 0, 0, 0.05)' },
            ticks: {
              color: '#64748b',
              font: { family: 'Outfit, Inter, sans-serif' },
              callback: function(value) {
                return formatCurrencyTR(value);
              }
            }
          }
        }
      }
    });
  }

  // 4. Compile Chart 2: Subscription Distribution (Doughnut)
  let countBireysel = 0;
  let countKurumsal = 0;

  apps.forEach(app => {
    const isKurumsal = app.subscription_type && app.subscription_type.includes('Kurumsal');
    if (isKurumsal) {
      countKurumsal++;
    } else {
      countBireysel++;
    }
  });

  const canvasSub = document.getElementById('chart-subscription-distribution');
  if (canvasSub) {
    const ctxSub = canvasSub.getContext('2d');
    if (chartSubscriptionDistribution) chartSubscriptionDistribution.destroy();
    chartSubscriptionDistribution = new Chart(ctxSub, {
      type: 'doughnut',
      data: {
        labels: ['Bireysel Abonelik', 'Kurumsal Abonelik'],
        datasets: [{
          data: [countBireysel, countKurumsal],
          backgroundColor: ['#ffd000', '#3b82f6'],
          borderColor: ['#ffffff', '#ffffff'],
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: '#0f172a',
              font: { family: 'Outfit, Inter, sans-serif', size: 12, weight: '500' },
              padding: 15
            }
          },
          tooltip: {
            callbacks: {
              label: function(context) {
                const value = context.raw;
                const total = countBireysel + countKurumsal;
                const percentage = total > 0 ? Math.round((value / total) * 100) : 0;
                return ` ${context.label}: ${value} adet (%${percentage})`;
              }
            }
          }
        },
        cutout: '70%'
      }
    });
  }

  // 5. Compile Chart 3: Monthly Application Trend (Line Chart)
  const monthlyTotalCounts = {};
  const monthlyApprovedCounts = {};

  sortedMonthKeys.forEach(mKey => {
    monthlyTotalCounts[mKey] = 0;
    monthlyApprovedCounts[mKey] = 0;
  });

  apps.forEach(app => {
    const d = getAppDate(app);
    if (d) {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const mKey = `${year}-${month}`;

      if (monthlyTotalCounts[mKey] !== undefined) {
        monthlyTotalCounts[mKey]++;
        if (app.status === 'Onaylandı') {
          monthlyApprovedCounts[mKey]++;
        }
      }
    }
  });

  const dataTotalLine = sortedMonthKeys.map(mKey => monthlyTotalCounts[mKey]);
  const dataApprovedLine = sortedMonthKeys.map(mKey => monthlyApprovedCounts[mKey]);

  const canvasTrend = document.getElementById('chart-trend-applications');
  if (canvasTrend) {
    const ctxTrend = canvasTrend.getContext('2d');
    
    // Create modern gradients for line fills
    const gradientTotal = ctxTrend.createLinearGradient(0, 0, 0, 300);
    gradientTotal.addColorStop(0, 'rgba(148, 163, 184, 0.25)');
    gradientTotal.addColorStop(1, 'rgba(148, 163, 184, 0.01)');
    
    const gradientApproved = ctxTrend.createLinearGradient(0, 0, 0, 300);
    gradientApproved.addColorStop(0, 'rgba(16, 185, 129, 0.25)');
    gradientApproved.addColorStop(1, 'rgba(16, 185, 129, 0.01)');

    if (chartTrendApplications) chartTrendApplications.destroy();
    chartTrendApplications = new Chart(ctxTrend, {
      type: 'line',
      data: {
        labels: monthLabels,
        datasets: [
          {
            label: 'Toplam Başvuru',
            data: dataTotalLine,
            borderColor: '#94a3b8',
            backgroundColor: gradientTotal,
            borderWidth: 2,
            tension: 0.3,
            fill: true
          },
          {
            label: 'Onaylanan Başvuru',
            data: dataApprovedLine,
            borderColor: '#10b981',
            backgroundColor: gradientApproved,
            borderWidth: 2.5,
            tension: 0.3,
            fill: true
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'top',
            labels: {
              color: '#0f172a',
              font: { family: 'Outfit, Inter, sans-serif', size: 11, weight: '500' }
            }
          }
        },
        scales: {
          x: {
            grid: { color: 'rgba(0, 0, 0, 0.05)' },
            ticks: {
              color: '#64748b',
              font: { family: 'Outfit, Inter, sans-serif' }
            }
          },
          y: {
            grid: { color: 'rgba(0, 0, 0, 0.05)' },
            ticks: {
              color: '#64748b',
              font: { family: 'Outfit, Inter, sans-serif' },
              precision: 0
            }
          }
        }
      }
    });
  }

  // 6. Compile Chart 4: Otopark Occupancy/Active Subscribers (Doughnut)
  const otoparkCounts = {};
  apps.forEach(app => {
    if (app.status === 'Onaylandı' && app.parking_location) {
      otoparkCounts[app.parking_location] = (otoparkCounts[app.parking_location] || 0) + 1;
    }
  });
  const otoparkOccupancyLabels = Object.keys(otoparkCounts);
  const otoparkOccupancyData = Object.values(otoparkCounts);

  const canvasOccupancy = document.getElementById('chart-otopark-occupancy');
  if (canvasOccupancy) {
    const ctxOccupancy = canvasOccupancy.getContext('2d');
    if (chartOtoparkOccupancy) chartOtoparkOccupancy.destroy();
    
    // Generate colors dynamically from colorsPalette
    const dynamicColors = otoparkOccupancyLabels.map((_, idx) => colorsPalette[idx % colorsPalette.length]);
    
    chartOtoparkOccupancy = new Chart(ctxOccupancy, {
      type: 'doughnut',
      data: {
        labels: otoparkOccupancyLabels.length > 0 ? otoparkOccupancyLabels : ['Aktif Abone Yok'],
        datasets: [{
          data: otoparkOccupancyData.length > 0 ? otoparkOccupancyData : [1],
          backgroundColor: otoparkOccupancyData.length > 0 ? dynamicColors : ['#e2e8f0'],
          borderColor: '#ffffff',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: '#0f172a',
              font: { family: 'Outfit, Inter, sans-serif', size: 11, weight: '500' },
              padding: 12
            }
          },
          tooltip: {
            callbacks: {
              label: function(context) {
                if (otoparkOccupancyData.length === 0) return ' Aktif abone bulunmuyor';
                const value = context.raw;
                const total = otoparkOccupancyData.reduce((a, b) => a + b, 0);
                const percentage = total > 0 ? Math.round((value / total) * 100) : 0;
                return ` ${context.label}: ${value} abone (%${percentage})`;
              }
            }
          }
        },
        cutout: '70%'
      }
    });
  }

  // 7. Compile Chart 5: Application Conversion Rates (Doughnut)
  let countApproved = 0;
  let countPending = 0;
  let countRejected = 0;

  apps.forEach(app => {
    const status = app.status || 'Beklemede';
    if (status === 'Onaylandı') {
      countApproved++;
    } else if (status === 'Beklemede') {
      countPending++;
    } else if (status.startsWith('Red')) {
      countRejected++;
    } else {
      countPending++;
    }
  });

  const canvasConversion = document.getElementById('chart-conversion-rates');
  if (canvasConversion) {
    const ctxConversion = canvasConversion.getContext('2d');
    if (chartConversionRates) chartConversionRates.destroy();
    
    const totalApps = countApproved + countPending + countRejected;
    
    chartConversionRates = new Chart(ctxConversion, {
      type: 'doughnut',
      data: {
        labels: ['Onaylandı', 'Beklemede', 'Reddedildi'],
        datasets: [{
          data: [countApproved, countPending, countRejected],
          backgroundColor: ['#10b981', '#f59e0b', '#ef4444'],
          borderColor: '#ffffff',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: '#0f172a',
              font: { family: 'Outfit, Inter, sans-serif', size: 11, weight: '500' },
              padding: 12
            }
          },
          tooltip: {
            callbacks: {
              label: function(context) {
                const value = context.raw;
                const percentage = totalApps > 0 ? Math.round((value / totalApps) * 100) : 0;
                return ` ${context.label}: ${value} adet (%${percentage})`;
              }
            }
          }
        },
        cutout: '70%'
      }
    });
  }
}

/* ==========================================================================
   ADMIN PANEL RUHSAT OCR & PLAKA DOĞRULAMA ENTEGRASYONU (AI)
   ========================================================================== */

function loadTesseractScript() {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    script.onload = () => {
      if (window.Tesseract) {
        resolve();
      } else {
        reject(new Error("Tesseract loaded but window.Tesseract not found"));
      }
    };
    script.onerror = () => {
      reject(new Error("Tesseract.js yüklenemedi. İnternet bağlantınızı kontrol edin."));
    };
    document.head.appendChild(script);
  });
}

function rotateImage(imageUrl, degrees) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      
      const rads = (degrees * Math.PI) / 180;
      
      if (degrees === 90 || degrees === 270) {
        canvas.width = img.height;
        canvas.height = img.width;
      } else {
        canvas.width = img.width;
        canvas.height = img.height;
      }
      
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(rads);
      ctx.drawImage(img, -img.width / 2, -img.height / 2);
      
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(URL.createObjectURL(blob));
        } else {
          reject(new Error("Canvas toBlob error"));
        }
      }, 'image/jpeg', 0.9);
    };
    img.onerror = () => reject(new Error("Görsel yüklenemedi"));
    img.src = imageUrl;
  });
}

function normalizePlate(plate) {
  if (!plate) return '';
  return plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function findPlatesInText(text) {
  if (!text) return [];
  
  // Normalize character variations and uppercase
  let cleanedText = text.toUpperCase()
    .replace(/O/g, '0') // Common OCR confusion: letter O instead of digit 0
    .replace(/I/g, '1') // Common OCR confusion: letter I instead of digit 1
    .replace(/[^A-Z0-9\s]/g, ' '); // Clean punctuation and special chars
  
  // Regex: 2 digits (city code), 1 to 3 letters, 2 to 4 digits
  const regex = /\b(\d{2})\s*([A-Z]{1,3})\s*(\d{2,4})\b/g;
  let matches = [];
  let match;
  while ((match = regex.exec(cleanedText)) !== null) {
    const plate = match[1] + match[2] + match[3];
    const cityCode = parseInt(match[1], 10);
    if (cityCode >= 1 && cityCode <= 81) {
      matches.push(plate);
    }
  }
  return matches;
}

async function initRuhsatOCR(app, rotateDegrees = 0) {
  const ocrStatusContainer = document.getElementById('ocr-status-container');
  if (!ocrStatusContainer) return;

  const userPlateNormalized = normalizePlate(app.plate);

  // 1. Check cache if not rotating
  if (rotateDegrees === 0 && ocrCache[app.id]) {
    const cached = ocrCache[app.id];
    renderOcrResult(app, cached.candidates, userPlateNormalized, cached.imageSrc);
    return;
  }

  try {
    // Show spinner and download status
    ocrStatusContainer.innerHTML = `
      <span style="font-size: 0.8rem; color: var(--color-text-muted); display: inline-flex; align-items: center; gap: 0.4rem;">
        <span class="ocr-spinner"></span> Görsel indiriliyor...
      </span>
    `;

    // 2. Fetch the document image with Bearer token
    const token = localStorage.getItem('parkexpert_token');
    if (!token) {
      ocrStatusContainer.innerHTML = `<span style="font-size: 0.8rem; color: var(--color-accent-red);">Erişim Yetkisi Yok</span>`;
      return;
    }

    const res = await fetch(`/api/document?path=${encodeURIComponent(app.files.ruhsat)}`, {
      headers: { "Authorization": `Bearer ${token}` }
    });
    if (!res.ok) {
      throw new Error("Ruhsat dosyası güvenli depodan çekilemedi.");
    }

    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) {
      ocrStatusContainer.innerHTML = `<span style="font-size: 0.8rem; color: var(--color-text-muted);">Uyumsuz Format (PDF/Diğer)</span>`;
      return;
    }

    let imageSrc = URL.createObjectURL(blob);

    // 3. Apply rotation if requested
    if (rotateDegrees !== 0) {
      ocrStatusContainer.innerHTML = `
        <span style="font-size: 0.8rem; color: var(--color-text-muted); display: inline-flex; align-items: center; gap: 0.4rem;">
          <span class="ocr-spinner"></span> Görsel döndürülüyor...
        </span>
      `;
      try {
        const rotatedSrc = await rotateImage(imageSrc, rotateDegrees);
        if (imageSrc.startsWith('blob:')) {
          URL.revokeObjectURL(imageSrc);
        }
        imageSrc = rotatedSrc;
      } catch (err) {
        console.error("Rotation failed:", err);
      }
    }

    // 4. Load Tesseract.js script if not loaded
    if (!window.Tesseract) {
      ocrStatusContainer.innerHTML = `
        <span style="font-size: 0.8rem; color: var(--color-text-muted); display: inline-flex; align-items: center; gap: 0.4rem;">
          <span class="ocr-spinner"></span> OCR motoru yükleniyor...
        </span>
      `;
      await loadTesseractScript();
    }

    // 5. Run Tesseract.js OCR
    ocrStatusContainer.innerHTML = `
      <span style="font-size: 0.8rem; color: var(--color-text-muted); display: inline-flex; align-items: center; gap: 0.4rem;">
        <span class="ocr-spinner"></span> Ruhsat taranıyor... <span id="ocr-progress-percent">0%</span>
      </span>
    `;

    const result = await Tesseract.recognize(
      imageSrc,
      'eng',
      {
        logger: m => {
          if (m.status === 'recognizing text') {
            const pct = Math.round(m.progress * 100);
            const progressEl = document.getElementById('ocr-progress-percent');
            if (progressEl) {
              progressEl.textContent = `${pct}%`;
            }
          }
        }
      }
    );

    const detectedText = result.data.text || '';
    const candidates = findPlatesInText(detectedText);

    // Cache the result (revoke old cached URL if it exists and is different to avoid memory leaks)
    if (ocrCache[app.id] && ocrCache[app.id].imageSrc && ocrCache[app.id].imageSrc !== imageSrc) {
      URL.revokeObjectURL(ocrCache[app.id].imageSrc);
    }
    
    ocrCache[app.id] = {
      text: detectedText,
      candidates: candidates,
      imageSrc: imageSrc
    };

    renderOcrResult(app, candidates, userPlateNormalized, imageSrc);

  } catch (err) {
    console.error("OCR initialization failed:", err);
    ocrStatusContainer.innerHTML = `
      <span style="font-size: 0.8rem; color: #ef4444; display: inline-flex; align-items: center; gap: 0.4rem;">
        <i data-lucide="x-circle" style="width: 12px; height: 12px;"></i> OCR Başlatılamadı
      </span>
    `;
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
}

function renderOcrResult(app, candidates, userPlateNormalized, imageSrc = null) {
  const ocrStatusContainer = document.getElementById('ocr-status-container');
  if (!ocrStatusContainer) return;

  let bestCandidate = null;
  let isMatch = false;

  if (candidates && candidates.length > 0) {
    const matched = candidates.find(c => c === userPlateNormalized);
    if (matched) {
      bestCandidate = matched;
      isMatch = true;
    } else {
      bestCandidate = candidates[0];
    }
  }

  const thumbnailHtml = imageSrc ? `
    <div class="ocr-thumb-box" style="position: relative; flex-shrink: 0; width: 68px; height: 68px; border: 1.5px solid var(--color-border-light); border-radius: var(--radius-sm); overflow: hidden; cursor: pointer; background-color: #f8fafc; box-shadow: var(--shadow-sm); margin-top: 0.15rem;" onclick="openDocPreview('Ruhsat Belgesi (AI)', '${app.files.ruhsat}', '${imageSrc}')" title="Büyütmek için tıklayın">
      <img src="${imageSrc}" style="width: 100%; height: 100%; object-fit: cover;">
      <div style="position: absolute; bottom: 0; left: 0; right: 0; background: rgba(15, 59, 162, 0.85); color: #ffffff; font-size: 0.55rem; text-align: center; padding: 0.1rem 0; font-weight: 700; display: flex; align-items: center; justify-content: center; gap: 0.1rem;">
        <i data-lucide="zoom-in" style="width: 8px; height: 8px;"></i> Büyüt
      </div>
    </div>
  ` : '';

  let resultCardHtml = '';

  if (isMatch) {
    resultCardHtml = `
      <div style="display: flex; align-items: center; gap: 0.4rem;">
        <span class="ocr-badge ocr-badge-success" title="Ruhsattaki plaka ile beyan edilen plaka uyuşuyor.">
          <i data-lucide="check-circle" style="width: 12px; height: 12px;"></i> Uyumlu: Plaka Doğrulandı ✅
        </span>
      </div>
    `;
  } else if (bestCandidate) {
    resultCardHtml = `
      <div style="display: flex; flex-direction: column; gap: 0.4rem; align-items: flex-start; width: 100%; min-width: 0;">
        <div style="display: flex; align-items: center; gap: 0.4rem;">
          <span class="ocr-badge ocr-badge-warning" title="Ruhsattaki plaka ile beyan edilen plaka farklı.">
            <i data-lucide="alert-triangle" style="width: 12px; height: 12px;"></i> Uyuşmazlık! ⚠️
          </span>
        </div>
        <span style="font-size: 0.8rem; color: var(--color-text-dark); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%;">
          Okunan: <strong style="color: var(--color-accent-orange); font-family: monospace; font-size: 0.9rem;">${maskPlate(bestCandidate)}</strong>
        </span>
        <div style="display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.15rem; width: 100%;">
          <button onclick="applyOcrPlate('${app.id}', '${bestCandidate}')" class="btn btn-ocr-apply">
            Uygula ⚡
          </button>
          <button onclick="rotateAndReScan('${app.id}', 90)" class="btn-ocr-rotate" title="90 Derece Döndür">
            <i data-lucide="rotate-cw" style="width: 13px; height: 13px;"></i> Döndür ↻
          </button>
        </div>
      </div>
    `;
  } else {
    resultCardHtml = `
      <div style="display: flex; flex-direction: column; gap: 0.4rem; align-items: flex-start; width: 100%;">
        <div style="display: flex; align-items: center; gap: 0.4rem;">
          <span class="ocr-badge ocr-badge-danger" title="Ruhsat görselinden plaka okunamadı.">
            <i data-lucide="x-circle" style="width: 12px; height: 12px;"></i> Plaka Okunamadı 🔍
          </span>
        </div>
        <span style="font-size: 0.725rem; color: var(--color-text-muted); line-height: 1.3;">
          Görsel yan/ters ise döndürüp tarayın:
        </span>
        <div style="display: flex; gap: 0.35rem; margin-top: 0.15rem; width: 100%;">
          <button onclick="rotateAndReScan('${app.id}', 90)" class="btn-ocr-rotate" style="flex: 1; justify-content: center;">
            <i data-lucide="rotate-cw" style="width: 13px; height: 13px;"></i> Sağa Döndür ↻
          </button>
          <button onclick="rotateAndReScan('${app.id}', 270)" class="btn-ocr-rotate" style="flex: 1; justify-content: center;">
            <i data-lucide="rotate-ccw" style="width: 13px; height: 13px;"></i> Sola Döndür ↺
          </button>
        </div>
      </div>
    `;
  }

  ocrStatusContainer.innerHTML = `
    <div class="ocr-status-wrapper" style="display: flex; gap: 0.75rem; align-items: flex-start; width: 100%;">
      ${thumbnailHtml}
      <div style="flex-grow: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center;">
        ${resultCardHtml}
      </div>
    </div>
  `;

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function applyOcrPlate(appId, ocrPlate) {
  const appIndex = allApplications.findIndex(a => a.id === appId);
  if (appIndex === -1) return;

  const token = localStorage.getItem('parkexpert_token');
  if (!token) {
    alert("Yetkisiz işlem! Lütfen tekrar giriş yapın.");
    return;
  }

  const ocrStatusContainer = document.getElementById('ocr-status-container');
  if (ocrStatusContainer) {
    ocrStatusContainer.innerHTML = `
      <span style="font-size: 0.8rem; color: var(--color-text-muted); display: inline-flex; align-items: center; gap: 0.4rem;">
        <span class="ocr-spinner"></span> Güncelleniyor...
      </span>
    `;
  }

  try {
    const res = await fetch("/api/applications", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        id: appId,
        plate_number: ocrPlate
      })
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Güncelleme sırasında hata oluştu.");
    }

    // Update locally
    allApplications[appIndex].plate = ocrPlate;
    allApplications[appIndex].plate_number = ocrPlate;

    // Refresh UI
    applyFilters();

    // Reopen/refresh drawer to show updated state
    openDrawer(appId);
  } catch (err) {
    console.error("OCR plaka uygulanamadı:", err);
    alert("Hata: " + err.message);
    openDrawer(appId);
  }
}

async function rotateAndReScan(appId, degrees) {
  const newRotation = ((currentRotation[appId] || 0) + degrees) % 360;
  currentRotation[appId] = newRotation;
  
  // Clear cache for this app since we are re-scanning with rotation
  delete ocrCache[appId];
  
  const app = allApplications.find(a => a.id === appId);
  if (app) {
    initRuhsatOCR(app, newRotation);
  }
}

function exportSingleApplicationExcel(appId, type) {
  const app = allApplications.find(a => a.id === appId);
  if (!app) return;

  if (type === 'standard') {
    // 1. Setup headers
    const headers = [
      "Başvuru No",
      "Abonelik Tipi",
      "Otopark Konumu",
      "Ad Soyad",
      "Şoför Adı",
      "T.C. Kimlik No",
      "Telefon",
      "E-posta",
      "Araç Plakası",
      "Araç Marka Model",
      "İşyeri Adresi",
      "Başvuru Tarihi",
      "Başvuru Durumu",
      "Firma Unvanı",
      "Vergi Dairesi",
      "Vergi Numarası",
      "Fatura Adresi"
    ];

    // 2. Setup row
    const row = [
      app.id,
      app.subscription_type,
      app.parking_location,
      app.full_name,
      app.driver_name || app.full_name,
      `'${app.tc_no}`,
      app.phone,
      app.email,
      app.plate,
      app.car_model,
      app.home_address ? app.home_address.replace(/\r?\n/g, " ") : "",
      formatDateTR(app.created_at || app.date_applied),
      app.status,
      app.billing ? app.billing.company : "",
      app.billing ? app.billing.tax_office : "",
      app.billing ? `'${app.billing.tax_no}` : "",
      app.billing ? app.billing.address.replace(/\r?\n/g, " ") : ""
    ];

    // 3. Assemble CSV string with semicolon delimiters
    const csvContent = [
      headers.join(";"),
      row.map(cell => {
        let cellStr = String(cell);
        if (cellStr.includes(";") || cellStr.includes('"') || cellStr.includes("\n")) {
          cellStr = `"${cellStr.replace(/"/g, '""')}"`;
        }
        return cellStr;
      }).join(";")
    ].join("\n");

    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
    const blob = new Blob([bom, csvContent], { type: "text/csv;charset=utf-8;" });
    const filename = `Standart_Excel_${app.id}_${app.plate}.csv`;

    const link = document.createElement("a");
    if (link.download !== undefined) {
      const url = URL.createObjectURL(blob);
      link.setAttribute("href", url);
      link.setAttribute("download", filename);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  } else if (type === 'parkexpert') {
    const btn = document.getElementById('btn-single-parkexpert-export');
    const originalText = btn ? btn.innerHTML : '';
    if (btn) {
      btn.innerHTML = '<i class="spinner-border spinner-border-sm" role="status" style="width: 12px; height: 12px; display: inline-block; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spinner-border .75s linear infinite; margin-right: 0.25rem;"></i>...';
      btn.disabled = true;
    }

    const loadSheetJS = (callback) => {
      if (window.XLSX) {
        callback();
        return;
      }
      const script = document.createElement('script');
      script.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
      script.onload = () => {
        callback();
      };
      script.onerror = () => {
        if (btn) {
          btn.innerHTML = originalText;
          btn.disabled = false;
        }
        alert("Excel kütüphanesi yüklenemedi. İnternet bağlantınızı kontrol edin.");
      };
      document.head.appendChild(script);
    };

    loadSheetJS(() => {
      try {
        const wsData = [
          [
            "Abone Adı",
            "Abone Grubu",
            "Tip (COMPANY/INDIVIDUAL)",
            "Kimlik No",
            "Vergi No",
            "Telefon",
            "E-posta",
            "Abonelik Tip Adı",
            "Başlangıç Zamanı",
            "Plaka",
            "Sürücü Adı",
            "Marka",
            "Model"
          ]
        ];

        let phone = app.phone || "";
        let cleanPhone = phone.replace(/\D/g, "");
        if (cleanPhone.startsWith("90")) cleanPhone = cleanPhone.substring(2);
        if (cleanPhone.startsWith("0")) cleanPhone = cleanPhone.substring(1);

        let marka = "";
        let model = "";
        if (app.car_model) {
          const parts = app.car_model.trim().split(/\s+/);
          if (parts.length > 0) {
            marka = parts[0];
            if (parts.length > 1) {
              model = parts.slice(1).join(" ");
            }
          }
        }

        const dateStr = app.created_at || app.date_applied;
        let parsedDate = null;
        if (dateStr) {
          parsedDate = new Date(dateStr);
          if (isNaN(parsedDate.getTime())) {
            parsedDate = new Date();
          }
        } else {
          parsedDate = new Date();
        }

        const cleanPlate = (app.plate || "").replace(/\s+/g, "").toUpperCase();

        wsData.push([
          app.full_name,
          app.company_name || "",
          "COMPANY",
          app.tc_no || "",
          app.tax_number || (app.billing ? app.billing.tax_no : "") || "",
          cleanPhone,
          app.email || "",
          "Dış Abonelikler (3.750)",
          parsedDate,
          cleanPlate,
          app.driver_name || app.full_name,
          marka,
          model
        ]);

        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet(wsData, { cellDates: true });

        // Set date format on cell I2 (column index 8, row 1)
        const cellRef = XLSX.utils.encode_cell({ r: 1, c: 8 });
        if (ws[cellRef]) {
          ws[cellRef].z = 'yyyy-mm-dd hh:mm:ss';
        }

        XLSX.utils.book_append_sheet(wb, ws, "Abone");
        XLSX.writeFile(wb, `ParkExpert_Excel_${app.id}_${cleanPlate}.xlsx`);
      } catch (err) {
        console.error("Single ParkExpert excel export failed:", err);
        alert("Excel oluşturulurken hata oluştu.");
      } finally {
        if (btn) {
          btn.innerHTML = originalText;
          btn.disabled = false;
        }
      }
    });
  }
}

function updateCharCount(textareaId, counterId) {
  const textarea = document.getElementById(textareaId);
  const counter = document.getElementById(counterId);
  if (textarea && counter) {
    counter.textContent = `${textarea.value.length} karakter`;
  }
}
window.updateCharCount = updateCharCount;

window.toggleAutoReminderFields = function() {
  const enabledCh = document.getElementById('settings-auto-reminders-enabled');
  const container = document.getElementById('auto-reminders-config-container');
  if (enabledCh && container) {
    container.style.display = enabledCh.checked ? 'flex' : 'none';
  }
};

window.insertTemplateVar = function(textareaId, variable) {
  const textarea = document.getElementById(textareaId);
  if (!textarea) return;
  
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;
  const before = text.substring(0, start);
  const after = text.substring(end, text.length);
  
  textarea.value = before + variable + after;
  textarea.focus();
  textarea.selectionStart = textarea.selectionEnd = start + variable.length;
  
  textarea.dispatchEvent(new Event('input'));
};

/* ==========================================================================
   GLOBAL SYSTEM SETTINGS & NOTIFICATION CHANNELS
   ========================================================================== */

async function loadSystemSettings() {
  const emailCh = document.getElementById('settings-email-enabled');
  const whatsappCh = document.getElementById('settings-whatsapp-enabled');
  const smsCh = document.getElementById('settings-sms-enabled');
  const delayNightSmsCh = document.getElementById('settings-delay-night-sms');
  const sendReminderCh = document.getElementById('settings-send-expiration-reminder');
  const reminderDaysInput = document.getElementById('settings-expiration-reminder-days');
  const reminderDaysContainer = document.getElementById('settings-reminder-days-container');
  const flashSmsCh = document.getElementById('settings-flash-sms');
  const twoFactorEnabledCh = document.getElementById('settings-two-factor-enabled');
  const twoFactorWhatsappEnabledCh = document.getElementById('settings-two-factor-whatsapp-enabled');
  const twoFactorSmsEnabledCh = document.getElementById('settings-two-factor-sms-enabled');
  const saveBtn = document.getElementById('btn-save-settings');

  if (!emailCh || !whatsappCh || !smsCh) return;

  try {
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<span class="ocr-spinner"></span> <span>Yükleniyor...</span>';
    }

    const res = await fetch('/api/settings');
    if (!res.ok) throw new Error("Ayarlar yüklenemedi.");

    const settings = await res.json();
    emailCh.checked = settings.email_enabled !== false;
    whatsappCh.checked = settings.whatsapp_enabled !== false;
    smsCh.checked = settings.sms_enabled !== false;

    if (delayNightSmsCh) {
      delayNightSmsCh.checked = settings.delay_night_sms === true;
    }

    if (sendReminderCh) {
      sendReminderCh.checked = settings.send_expiration_reminder !== false;

      // Wire change listener to toggle reminder days input container
      sendReminderCh.onchange = () => {
        if (reminderDaysContainer) {
          reminderDaysContainer.style.display = sendReminderCh.checked ? 'flex' : 'none';
        }
      };

      // Set initial visibility
      if (reminderDaysContainer) {
        reminderDaysContainer.style.display = sendReminderCh.checked ? 'flex' : 'none';
      }
    }

    if (reminderDaysInput) {
      reminderDaysInput.value = settings.expiration_reminder_days || 3;
    }

    if (flashSmsCh) {
      flashSmsCh.checked = settings.flash_sms === true;
    }

    if (twoFactorEnabledCh) {
      twoFactorEnabledCh.checked = settings.two_factor_enabled === true;
    }
    if (twoFactorWhatsappEnabledCh) {
      twoFactorWhatsappEnabledCh.checked = settings.two_factor_whatsapp_enabled === true;
    }
    if (twoFactorSmsEnabledCh) {
      twoFactorSmsEnabledCh.checked = settings.two_factor_sms_enabled === true;
    }

    const autoRemindersEnabledCh = document.getElementById('settings-auto-reminders-enabled');
    const autoRemindersChannelSelect = document.getElementById('settings-auto-reminders-channel');
    const autoRemindersDaysInput = document.getElementById('settings-auto-reminders-days');
    const template7dTextarea = document.getElementById('settings-template-7d');
    const template3dTextarea = document.getElementById('settings-template-3d');
    const template1dTextarea = document.getElementById('settings-template-1d');
    const template0dTextarea = document.getElementById('settings-template-0d');

    if (autoRemindersEnabledCh) {
      autoRemindersEnabledCh.checked = settings.auto_reminders_enabled === true;
      window.toggleAutoReminderFields();
    }
    if (autoRemindersChannelSelect) {
      autoRemindersChannelSelect.value = settings.auto_reminders_channel || 'sms';
    }
    if (autoRemindersDaysInput) {
      autoRemindersDaysInput.value = settings.auto_reminders_days || '7,3,1,0';
    }
    if (template7dTextarea) {
      template7dTextarea.value = settings.auto_reminders_template_7d || '';
      updateCharCount('settings-template-7d', 'char-count-7d');
    }
    if (template3dTextarea) {
      template3dTextarea.value = settings.auto_reminders_template_3d || '';
      updateCharCount('settings-template-3d', 'char-count-3d');
    }
    if (template1dTextarea) {
      template1dTextarea.value = settings.auto_reminders_template_1d || '';
      updateCharCount('settings-template-1d', 'char-count-1d');
    }
    if (template0dTextarea) {
      template0dTextarea.value = settings.auto_reminders_template_0d || '';
      updateCharCount('settings-template-0d', 'char-count-0d');
    }

    // Bind event listeners for character counts
    ['settings-template-7d', 'settings-template-3d', 'settings-template-1d', 'settings-template-0d'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        const countId = 'char-count-' + id.split('-')[2];
        el.addEventListener('input', () => updateCharCount(id, countId));
        updateCharCount(id, countId);
      }
    });

    // Backups list is now loaded on backups tab click

  } catch (err) {
    console.error("Failed to load settings:", err);
    showToastNotification("Sistem Ayarları", "Sistem ayarları yüklenirken hata oluştu.", "alert-circle");
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = '<i data-lucide="save" style="width: 18px; height: 18px;"></i> <span>Ayarları Kaydet</span>';
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  }
}

async function saveSystemSettings(event) {
  event.preventDefault();

  const token = localStorage.getItem('parkexpert_token');
  if (!token) {
    alert("Yetkisiz işlem! Lütfen tekrar giriş yapın.");
    return;
  }

  const emailCh = document.getElementById('settings-email-enabled');
  const whatsappCh = document.getElementById('settings-whatsapp-enabled');
  const smsCh = document.getElementById('settings-sms-enabled');
  const delayNightSmsCh = document.getElementById('settings-delay-night-sms');
  const sendReminderCh = document.getElementById('settings-send-expiration-reminder');
  const reminderDaysInput = document.getElementById('settings-expiration-reminder-days');
  const flashSmsCh = document.getElementById('settings-flash-sms');
  const twoFactorEnabledCh = document.getElementById('settings-two-factor-enabled');
  const twoFactorWhatsappEnabledCh = document.getElementById('settings-two-factor-whatsapp-enabled');
  const twoFactorSmsEnabledCh = document.getElementById('settings-two-factor-sms-enabled');
  
  const autoRemindersEnabledCh = document.getElementById('settings-auto-reminders-enabled');
  const autoRemindersChannelSelect = document.getElementById('settings-auto-reminders-channel');
  const autoRemindersDaysInput = document.getElementById('settings-auto-reminders-days');
  const template7dTextarea = document.getElementById('settings-template-7d');
  const template3dTextarea = document.getElementById('settings-template-3d');
  const template1dTextarea = document.getElementById('settings-template-1d');
  const template0dTextarea = document.getElementById('settings-template-0d');

  const btn = document.getElementById('btn-save-settings');

  if (!emailCh || !whatsappCh || !smsCh || !btn) return;

  const originalHTML = btn.innerHTML;

  try {
    btn.disabled = true;
    btn.innerHTML = '<span class="ocr-spinner"></span> <span>Kaydediliyor...</span>';

    const payload = {
      email_enabled: emailCh.checked,
      whatsapp_enabled: whatsappCh.checked,
      sms_enabled: smsCh.checked,
      delay_night_sms: delayNightSmsCh ? delayNightSmsCh.checked : false,
      send_expiration_reminder: sendReminderCh ? sendReminderCh.checked : false,
      expiration_reminder_days: reminderDaysInput ? (parseInt(reminderDaysInput.value, 10) || 3) : 3,
      flash_sms: flashSmsCh ? flashSmsCh.checked : false,
      two_factor_enabled: twoFactorEnabledCh ? twoFactorEnabledCh.checked : false,
      two_factor_whatsapp_enabled: twoFactorWhatsappEnabledCh ? twoFactorWhatsappEnabledCh.checked : false,
      two_factor_sms_enabled: twoFactorSmsEnabledCh ? twoFactorSmsEnabledCh.checked : false,
      auto_reminders_enabled: autoRemindersEnabledCh ? autoRemindersEnabledCh.checked : false,
      auto_reminders_channel: autoRemindersChannelSelect ? autoRemindersChannelSelect.value : 'sms',
      auto_reminders_days: autoRemindersDaysInput ? autoRemindersDaysInput.value : '7,3,1,0',
      auto_reminders_template_7d: template7dTextarea ? template7dTextarea.value : '',
      auto_reminders_template_3d: template3dTextarea ? template3dTextarea.value : '',
      auto_reminders_template_1d: template1dTextarea ? template1dTextarea.value : '',
      auto_reminders_template_0d: template0dTextarea ? template0dTextarea.value : ''
    };

    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || "Ayarlar kaydedilemedi.");
    }

    const data = await res.json();
    showToastNotification("Sistem Ayarları", "Sistem ayarları başarıyla kaydedildi! ✅", "check-circle");

  } catch (err) {
    console.error("Failed to save settings:", err);
    alert(`Ayar Kaydedilemedi!\n\nHata: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHTML;
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
}

async function runCronManually(event, runType = 'all') {
  if (event) event.preventDefault();

  const token = localStorage.getItem('parkexpert_token');
  if (!token) {
    alert("Yetkisiz işlem! Lütfen tekrar giriş yapın.");
    return;
  }

  let btnId = 'btn-run-cron-manually';
  if (runType === 'reminders') btnId = 'btn-run-reminders-manually';
  else if (runType === 'summaries') btnId = 'btn-run-summaries-manually';

  const btn = document.getElementById(btnId);
  if (!btn) return;

  const originalHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="ocr-spinner"></span> <span>Çalıştırılıyor...</span>';

  try {
    const res = await fetch(`/api/cron_reminders?run=${runType}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || "Cron tetiklenirken sunucu hatası oluştu.");
    }

    const data = await res.json();
    
    let msg = "";
    if (runType === 'reminders') {
      msg = "Müşteri bitiş hatırlatıcıları başarıyla tetiklendi! ✅\n\nSonuçlar:\n";
    } else if (runType === 'summaries') {
      msg = "Günlük özet raporları başarıyla tetiklendi! ✅\n\nSonuçlar:\n";
    } else {
      msg = "Süre hatırlatıcıları ve günlük özet raporları başarıyla tetiklendi! ✅\n\nSonuçlar:\n";
    }

    if (data.results && Array.isArray(data.results)) {
      data.results.forEach(r => {
        if (r.daysLeft !== undefined) {
          msg += `- Bitişine ${r.daysLeft} gün kalanlar: İşlenen: ${r.processed}, Başarılı: ${r.success}, Başarısız: ${r.failed}\n`;
        } else if (r.message) {
          msg += `- Durum: ${r.message}\n`;
        }
      });
    } else {
      msg += data.message || "Tüm işlemler başarıyla tamamlandı.";
    }

    alert(msg);
  } catch (err) {
    console.error("Failed to run cron manually:", err);
    alert(`Tetikleme Başarısız!\n\nHata: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHTML;
  }
}

window.activeTemplates = {};
window.currentTemplateTab = 'apply';

function openTemplatesModal(otoparkId) {
  const OTOPARKS_KEY = 'parkexpert_otoparks';
  const otoparks = JSON.parse(localStorage.getItem(OTOPARKS_KEY)) || [];
  const park = otoparks.find(p => p.id === otoparkId);
  if (!park) {
    alert("Otopark bulunamadı.");
    return;
  }

  document.getElementById('tpl-otopark-id').value = otoparkId;
  document.getElementById('otopark-templates-subtitle').textContent = `"${park.name}" otoparkı için giden bildirim şablonlarını özelleştirin.`;
  
  // Clone or initialize templates
  window.activeTemplates = JSON.parse(JSON.stringify(park.templates || {}));
  
  // Reset active tab to 'apply'
  window.currentTemplateTab = 'apply';
  
  // Style tab headers
  document.querySelectorAll('.template-tab-btn').forEach(btn => {
    btn.style.color = 'var(--color-text-muted)';
    btn.style.borderBottomColor = 'transparent';
  });
  const activeBtn = document.getElementById('tpl-tab-apply');
  if (activeBtn) {
    activeBtn.style.color = 'var(--color-primary)';
    activeBtn.style.borderBottomColor = 'var(--color-primary)';
  }

  // Load active tab fields
  const tpl = window.activeTemplates.apply || {};
  document.getElementById('tpl-input-sms').value = tpl.sms || '';
  document.getElementById('tpl-input-whatsapp').value = tpl.whatsapp || '';
  document.getElementById('tpl-input-email-subject').value = tpl.email_subject || '';
  document.getElementById('tpl-input-email-html').value = tpl.email_html || '';

  const modal = document.getElementById('otopark-templates-modal');
  if (modal) {
    modal.style.display = 'flex';
  }
  
  // Refresh Lucide icons inside modal if needed
  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }
}

function switchTemplateTab(tabName) {
  const prevTab = window.currentTemplateTab;
  
  // Save current values to activeTemplates
  if (prevTab) {
    if (!window.activeTemplates[prevTab]) window.activeTemplates[prevTab] = {};
    window.activeTemplates[prevTab].sms = document.getElementById('tpl-input-sms').value.trim();
    window.activeTemplates[prevTab].whatsapp = document.getElementById('tpl-input-whatsapp').value.trim();
    window.activeTemplates[prevTab].email_subject = document.getElementById('tpl-input-email-subject').value.trim();
    window.activeTemplates[prevTab].email_html = document.getElementById('tpl-input-email-html').value.trim();
  }

  window.currentTemplateTab = tabName;

  // Style tab headers
  document.querySelectorAll('.template-tab-btn').forEach(btn => {
    btn.style.color = 'var(--color-text-muted)';
    btn.style.borderBottomColor = 'transparent';
  });
  const activeBtn = document.getElementById(`tpl-tab-${tabName}`);
  if (activeBtn) {
    activeBtn.style.color = 'var(--color-primary)';
    activeBtn.style.borderBottomColor = 'var(--color-primary)';
  }

  // Load new tab fields
  const tpl = window.activeTemplates[tabName] || {};
  document.getElementById('tpl-input-sms').value = tpl.sms || '';
  document.getElementById('tpl-input-whatsapp').value = tpl.whatsapp || '';
  document.getElementById('tpl-input-email-subject').value = tpl.email_subject || '';
  document.getElementById('tpl-input-email-html').value = tpl.email_html || '';
}

function closeTemplatesModal(event) {
  if (event) event.preventDefault();
  const modal = document.getElementById('otopark-templates-modal');
  if (modal) {
    modal.style.display = 'none';
  }
}

async function saveOtoparkTemplates(event) {
  if (event) event.preventDefault();
  const token = localStorage.getItem('parkexpert_token');
  if (!token) {
    alert("Yetkisiz işlem! Lütfen giriş yapın.");
    return;
  }

  const otoparkId = document.getElementById('tpl-otopark-id').value;
  const OTOPARKS_KEY = 'parkexpert_otoparks';
  const otoparks = JSON.parse(localStorage.getItem(OTOPARKS_KEY)) || [];
  const park = otoparks.find(p => p.id === otoparkId);
  if (!park) {
    alert("Otopark bulunamadı.");
    return;
  }

  // Save active tab values first
  const activeTab = window.currentTemplateTab;
  if (activeTab) {
    if (!window.activeTemplates[activeTab]) window.activeTemplates[activeTab] = {};
    window.activeTemplates[activeTab].sms = document.getElementById('tpl-input-sms').value.trim();
    window.activeTemplates[activeTab].whatsapp = document.getElementById('tpl-input-whatsapp').value.trim();
    window.activeTemplates[activeTab].email_subject = document.getElementById('tpl-input-email-subject').value.trim();
    window.activeTemplates[activeTab].email_html = document.getElementById('tpl-input-email-html').value.trim();
  }

  const btn = document.getElementById('btn-save-templates');
  const originalHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="spinner-border spinner-border-sm" role="status" style="width: 12px; height: 12px; display: inline-block; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spinner-border .75s linear infinite; margin-right: 0.25rem;"></i> Kaydediliyor...';

  // Construct complete payload matching create/update otopark API
  const payload = {
    id: park.id,
    name: park.name,
    category: park.category,
    companyTitle: park.companyTitle,
    taxOffice: park.taxOffice,
    taxNumber: park.taxNumber,
    bankName: park.bankName,
    iban: park.iban,
    priceEmployee: park.priceEmployee,
    priceExternal: park.priceExternal,
    supportPhone: park.supportPhone,
    isActive: park.isActive !== false,
    templates: window.activeTemplates
  };

  try {
    const res = await fetch('/api/otoparks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Şablonlar kaydedilirken hata oluştu.");
    }

    closeTemplatesModal();
    await loadOtoparks();
    renderOtoparksTable();
    alert("Şablonlar başarıyla kaydedildi.");
  } catch (err) {
    console.error(err);
    alert(err.message);
  } finally {
    btn.innerHTML = originalHTML;
    btn.disabled = false;
  }
}

// ==========================================================================
// SMS DELIVERY REPORTS DASHBOARD LOGIC
// ==========================================================================

window.allSMSLogs = [];
window.currentSMSFilter = 'all';

async function loadSMSReports(forceRefresh = false) {
  const tbody = document.getElementById('sms-reports-table-body');
  const refreshBtn = document.getElementById('btn-refresh-sms');
  const token = localStorage.getItem('parkexpert_token');

  if (!tbody || !token) return;

  const originalBtnHTML = refreshBtn ? refreshBtn.innerHTML : '';
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.innerHTML = '<span class="ocr-spinner"></span> <span>Güncelleniyor...</span>';
  }

  tbody.innerHTML = `
    <tr>
      <td colspan="6" style="text-align: center; padding: 3rem; color: var(--color-text-muted);">
        <div style="display: flex; flex-direction: column; gap: 0.5rem; align-items: center; justify-content: center;">
          <i class="spinner-border spinner-border-sm" role="status" style="width: 20px; height: 20px; display: inline-block; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spinner-border .75s linear infinite; color: var(--color-primary); margin-bottom: 0.5rem;"></i>
          <span>SMS raporları yükleniyor...</span>
        </div>
      </td>
    </tr>
  `;

  try {
    const url = `/api/sms_reports?refresh=${forceRefresh ? 'true' : 'false'}`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!res.ok) {
      const errData = await res.json();
      if (errData.error === "sms_logs_table_missing") {
        tbody.innerHTML = `
          <tr>
            <td colspan="6" style="text-align: center; padding: 3rem; color: #b45309;">
              <div style="display: flex; flex-direction: column; gap: 0.8rem; align-items: center; max-width: 550px; margin: 0 auto;">
                <i data-lucide="alert-triangle" style="width: 36px; height: 36px; color: #d97706;"></i>
                <span style="font-weight: 700; font-size: 1rem; color: #d97706;">Supabase Veritabanı Tablosu Eksik veya Güncellenmeli!</span>
                <span style="font-size: 0.825rem; line-height: 1.5; color: var(--color-text-muted);">SMS raporlama özelliğini kullanabilmek ve konumları görebilmek için Supabase panelinizdeki <strong>SQL Editor</strong> ekranında aşağıdaki komutu çalıştırarak tabloyu güncelleyin:</span>
                <pre style="background: #f1f5f9; padding: 0.75rem; border-radius: 6px; font-size: 0.75rem; text-align: left; width: 100%; overflow-x: auto; border: 1px solid var(--color-border-light); color: #334155; font-family: monospace;">
CREATE TABLE IF NOT EXISTS sms_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id VARCHAR(100),
    phone VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    status VARCHAR(50) DEFAULT 'Beklemede',
    location VARCHAR(100) DEFAULT 'Sistem',
    scheduled_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS location VARCHAR(100) DEFAULT 'Sistem';
ALTER TABLE sms_logs DISABLE ROW LEVEL SECURITY;</pre>
              </div>
            </td>
          </tr>
        `;
        if (typeof lucide !== 'undefined') lucide.createIcons();
        return;
      }
      throw new Error(errData.error || "SMS raporları yüklenirken hata oluştu.");
    }

    const rawLogs = await res.json();
    window.allSMSLogs = rawLogs.map(log => {
      if (log.status === 'Durum: 16') {
        log.status = 'İletilemedi (İYS Engeli)';
      }
      return log;
    });
    updateSMSCountBadges();
    filterSMSLogs();

  } catch (err) {
    console.error("loadSMSReports error:", err);
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; padding: 3rem; color: var(--color-accent-red);">
          <div style="display: flex; flex-direction: column; gap: 0.5rem; align-items: center;">
            <i data-lucide="x-circle" style="width: 24px; height: 24px; color: var(--color-accent-red);"></i>
            <span>Hata: ${err.message}</span>
          </div>
        </td>
      </tr>
    `;
    if (typeof lucide !== 'undefined') lucide.createIcons();
  } finally {
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.innerHTML = originalBtnHTML;
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  }
}

function updateSMSCountBadges() {
  const logs = window.allSMSLogs || [];
  
  const countAll = logs.length;
  const countDelivered = logs.filter(log => log.status === 'İletildi' || log.status === 'Simüle Edildi').length;
  const countPending = logs.filter(log => log.status === 'Beklemede' || log.status === 'Zamanlandı').length;
  const countFailed = logs.filter(log => log.status && (log.status.startsWith('Hata') || log.status.startsWith('İletilemedi'))).length;
  
  const badgeAll = document.getElementById('sms-count-all');
  const badgeDelivered = document.getElementById('sms-count-delivered');
  const badgePending = document.getElementById('sms-count-pending');
  const badgeFailed = document.getElementById('sms-count-failed');
  
  if (badgeAll) badgeAll.textContent = countAll;
  if (badgeDelivered) badgeDelivered.textContent = countDelivered;
  if (badgePending) badgePending.textContent = countPending;
  if (badgeFailed) badgeFailed.textContent = countFailed;
}

function filterSMSLogs(filterType) {
  if (filterType) {
    window.currentSMSFilter = filterType;
    
    // Update filter buttons active class
    const buttons = ['all', 'delivered', 'pending', 'failed'];
    buttons.forEach(b => {
      const btn = document.getElementById(`filter-sms-${b}`);
      if (btn) {
        if (b === filterType) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      }
    });
  }

  const searchVal = document.getElementById('sms-search-input')?.value.toLowerCase().trim() || '';
  
  let filtered = window.allSMSLogs;

  // Apply status filter
  if (window.currentSMSFilter === 'delivered') {
    filtered = filtered.filter(log => log.status === 'İletildi' || log.status === 'Simüle Edildi');
  } else if (window.currentSMSFilter === 'pending') {
    filtered = filtered.filter(log => log.status === 'Beklemede' || log.status === 'Zamanlandı');
  } else if (window.currentSMSFilter === 'failed') {
    filtered = filtered.filter(log => log.status.startsWith('Hata') || log.status.startsWith('İletilemedi'));
  }

  // Apply search filter
  if (searchVal) {
    filtered = filtered.filter(log => 
      log.phone.toLowerCase().includes(searchVal) || 
      log.message.toLowerCase().includes(searchVal) ||
      (log.location && log.location.toLowerCase().includes(searchVal)) ||
      (log.job_id && log.job_id.toLowerCase().includes(searchVal))
    );
  }

  renderSMSReportsTable(filtered);
}

function formatTurkishPhoneNumber(phone) {
  if (!phone) return '-';
  let clean = phone.toString().replace(/\D/g, '');
  if (clean.length === 10) {
    return `0 (${clean.substring(0, 3)}) ${clean.substring(3, 6)} ${clean.substring(6, 8)} ${clean.substring(8, 10)}`;
  } else if (clean.length === 11 && clean.startsWith('0')) {
    return `0 (${clean.substring(1, 4)}) ${clean.substring(4, 7)} ${clean.substring(7, 9)} ${clean.substring(9, 11)}`;
  } else if (clean.length === 12 && clean.startsWith('90')) {
    return `0 (${clean.substring(2, 5)}) ${clean.substring(5, 8)} ${clean.substring(8, 10)} ${clean.substring(10, 12)}`;
  }
  return phone;
}

function renderSMSReportsTable(logs) {
  const tbody = document.getElementById('sms-reports-table-body');
  if (!tbody) return;

  if (logs.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; padding: 4rem; color: var(--color-text-muted);">
          <div style="display: flex; flex-direction: column; align-items: center; gap: 0.75rem;">
            <i data-lucide="mail-warning" style="width: 32px; height: 32px; color: #94a3b8;"></i>
            <span style="font-size: 0.9rem; font-weight: 500;">Herhangi bir SMS gönderim kaydı bulunamadı.</span>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = logs.map(log => {
    // Format creation time
    const createdDate = new Date(log.created_at);
    const createdStr = isNaN(createdDate.getTime()) ? '-' : createdDate.toLocaleString('tr-TR');

    // Format scheduled time
    let scheduledStr = '-';
    if (log.scheduled_at) {
      const schedDate = new Date(log.scheduled_at);
      scheduledStr = isNaN(schedDate.getTime()) ? '-' : schedDate.toLocaleString('tr-TR');
    }

    // Determine status badge style
    let badgeStyle = 'background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1;'; // default fallback
    let statusText = log.status || 'Beklemede';
    if (statusText === 'Durum: 16') {
      statusText = 'İletilemedi (İYS Engeli)';
    }
    let statusIcon = 'info';

    if (statusText === 'İletildi') {
      badgeStyle = 'background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0;'; // green
      statusIcon = 'check-circle-2';
    } else if (statusText === 'Simüle Edildi') {
      badgeStyle = 'background: #eff6ff; color: #1e40af; border: 1px solid #bfdbfe;'; // blue
      statusIcon = 'laptop';
    } else if (statusText === 'Zamanlandı') {
      badgeStyle = 'background: #faf5ff; color: #6b21a8; border: 1px dashed #d8b4fe;'; // purple/scheduled
      statusText = 'Zamanlandı';
      statusIcon = 'alarm-clock';
    } else if (statusText === 'Beklemede') {
      badgeStyle = 'background: #fefcbf; color: #744210; border: 1px solid #fef08a;'; // yellow
      statusIcon = 'clock';
    } else if (statusText.startsWith('Hata') || statusText.startsWith('İletilemedi')) {
      badgeStyle = 'background: #fdf2f2; color: #9b1c1c; border: 1px solid #fcd3d3;'; // red
      statusIcon = 'alert-triangle';
    }

    const formattedPhone = formatTurkishPhoneNumber(log.phone);

    // Format job ID representation
    const displayJobId = log.job_id 
      ? (log.job_id.length > 12 
          ? log.job_id.substring(0, 6) + '...' + log.job_id.substring(log.job_id.length - 6) 
          : log.job_id) 
      : '-';

    return `
      <tr style="border-bottom: 1px solid var(--color-border-light); transition: background-color var(--transition-fast);">
        <!-- Recipient Phone -->
        <td style="padding: 1.25rem 1.5rem;">
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <div style="background: rgba(15, 59, 162, 0.08); padding: 0.4rem; border-radius: var(--radius-sm); color: var(--color-primary); display: flex; align-items: center; justify-content: center;">
              <i data-lucide="phone" style="width: 14px; height: 14px;"></i>
            </div>
            <span style="font-weight: 700; color: var(--color-text-dark); font-size: 0.875rem; font-family: var(--font-mono, monospace); letter-spacing: 0.02em;">${formattedPhone}</span>
          </div>
        </td>

        <!-- Location -->
        <td style="padding: 1.25rem 1.5rem;">
          <div style="display: flex; align-items: center; gap: 0.35rem; font-weight: 600; color: var(--color-text-dark); font-size: 0.85rem;">
            <i data-lucide="map-pin" style="width: 14px; height: 14px; color: #64748b;"></i>
            <span>${log.location || 'Sistem'}</span>
          </div>
        </td>

        <!-- Message Content -->
        <td style="padding: 1.25rem 1.5rem; max-width: 400px;">
          <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 0.6rem 0.85rem; max-height: 85px; overflow-y: auto; font-size: 0.8rem; color: #475569; line-height: 1.45; font-family: inherit; white-space: pre-wrap; box-shadow: inset 0 1px 2px rgba(0,0,0,0.02);">
            ${log.message}
          </div>
        </td>

        <!-- Timestamp -->
        <td style="padding: 1.25rem 1.5rem;">
          <div style="display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.8rem; color: var(--color-text-muted);">
            <div style="display: flex; align-items: center; gap: 0.3rem; color: var(--color-text-dark); font-weight: 500;">
              <i data-lucide="calendar" style="width: 13px; height: 13px; color: #94a3b8;"></i>
              <span>${createdStr}</span>
            </div>
            ${log.scheduled_at ? `
            <div style="display: flex; align-items: center; gap: 0.3rem; color: #7c3aed; font-weight: 600; font-size: 0.75rem;">
              <i data-lucide="alarm-clock" style="width: 13px; height: 13px;"></i>
              <span>Planlanan: ${scheduledStr}</span>
            </div>` : ''}
          </div>
        </td>

        <!-- Netgsm Job ID -->
        <td style="padding: 1.25rem 1.5rem;">
          ${log.job_id ? `
          <span style="font-family: var(--font-mono, monospace); background: #f1f5f9; padding: 0.2rem 0.45rem; border-radius: 4px; font-size: 0.75rem; color: #475569; border: 1px solid #cbd5e1; display: inline-flex; align-items: center; gap: 0.25rem; font-weight: 500;" title="${log.job_id}">
            <i data-lucide="hash" style="width: 11px; height: 11px; color: #94a3b8;"></i>
            <span>${displayJobId}</span>
          </span>` : `<span style="color: #94a3b8;">-</span>`}
        </td>

        <!-- Status -->
        <td style="padding: 1.25rem 1.5rem;">
          <span style="display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.25rem 0.65rem; border-radius: 12px; font-size: 0.75rem; font-weight: 700; ${badgeStyle}">
            <i data-lucide="${statusIcon}" style="width: 12px; height: 12px;"></i>
            <span>${statusText}</span>
          </span>
        </td>
      </tr>
    `;
  }).join('');

  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }
}

/* ==========================================================================
   BULK SMS MARKETING & CAMPAIGN CONTROLLERS
   ========================================================================== */

async function loadOtoparksForBulkSms() {
  const otoparkSelect = document.getElementById('bulk-sms-otopark');
  if (!otoparkSelect) return;
  
  let otoparks = JSON.parse(localStorage.getItem('parkexpert_otoparks')) || [];
  if (otoparks.length === 0) {
    await loadOtoparks();
    otoparks = JSON.parse(localStorage.getItem('parkexpert_otoparks')) || [];
  }
  
  otoparkSelect.innerHTML = otoparks.map(p => `
    <option value="${p.id}">${p.name} (${p.location || 'Konum Yok'})</option>
  `).join('');
}

function toggleBulkTargetFields() {
  const target = document.getElementById('bulk-sms-target')?.value;
  const otoparkContainer = document.getElementById('bulk-sms-otopark-container');
  const manualContainer = document.getElementById('bulk-sms-manual-container');
  const varsContainer = document.getElementById('bulk-sms-vars-container');
  
  if (otoparkContainer) otoparkContainer.style.display = target === 'otopark' ? 'flex' : 'none';
  if (manualContainer) manualContainer.style.display = target === 'manual' ? 'flex' : 'none';
  if (varsContainer) varsContainer.style.display = target === 'manual' ? 'none' : 'flex';
}

function insertBulkPlaceholder(placeholder) {
  const textarea = document.getElementById('bulk-sms-message');
  if (!textarea) return;
  
  const startPos = textarea.selectionStart;
  const endPos = textarea.selectionEnd;
  const text = textarea.value;
  
  textarea.value = text.substring(0, startPos) + placeholder + text.substring(endPos);
  textarea.focus();
  textarea.selectionStart = startPos + placeholder.length;
  textarea.selectionEnd = startPos + placeholder.length;
  
  updateBulkSMSCounter();
}

function updateBulkSMSCounter() {
  const textarea = document.getElementById('bulk-sms-message');
  const counter = document.getElementById('bulk-sms-counter');
  if (!textarea || !counter) return;
  
  const len = textarea.value.length;
  let parts = 1;
  if (len > 160) {
    parts = Math.ceil(len / 153);
  }
  counter.textContent = `${len} karakter / ${parts} SMS`;
}

async function submitBulkSMS(event) {
  event.preventDefault();
  
  const targetType = document.getElementById('bulk-sms-target')?.value;
  const otoparkId = document.getElementById('bulk-sms-otopark')?.value;
  const manualNumbers = document.getElementById('bulk-sms-manual-numbers')?.value;
  const message = document.getElementById('bulk-sms-message')?.value;
  const isCommercial = document.querySelector('input[name="bulk-sms-commercial"]:checked')?.value === 'true';
  const flashSms = document.getElementById('bulk-sms-flash')?.checked || false;
  
  const btn = document.getElementById('btn-send-bulk-sms');
  const statusText = document.getElementById('bulk-sms-status-text');
  
  if (!message) {
    alert("Lütfen mesaj içeriği girin.");
    return;
  }
  
  if (targetType === 'manual' && !manualNumbers) {
    alert("Lütfen en az bir telefon numarası girin.");
    return;
  }
  
  const confirmMsg = `Toplu SMS gönderimi başlatılacaktır.\n\nGruptaki numaralara bu mesaj iletilecektir. Emin misiniz?\n\nTür: ${isCommercial ? 'Ticari / Reklam (İYS İzin Kontrollü)' : 'Bilgilendirme (İYS Filtresiz)'}\nFlash SMS: ${flashSms ? 'Evet' : 'Hayır'}`;
  if (!confirm(confirmMsg)) {
    return;
  }
  
  btn.disabled = true;
  const originalBtnHTML = btn.innerHTML;
  btn.innerHTML = '<i class="spinner-border spinner-border-sm" role="status" style="width: 12px; height: 12px; display: inline-block; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spinner-border .75s linear infinite; margin-right: 0.25rem;"></i> Gönderiliyor...';
  
  if (statusText) {
    statusText.style.display = 'inline-block';
    statusText.style.color = 'var(--color-primary)';
    statusText.textContent = 'İstek gönderiliyor, lütfen bekleyin...';
  }
  
  const token = localStorage.getItem(ADMIN_TOKEN_KEY);
  
  try {
    const res = await fetch('/api/send_bulk_sms', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        message,
        targetType,
        otoparkId,
        manualNumbers,
        isCommercial,
        flashSms
      })
    });
    
    const result = await res.json();
    
    if (!res.ok) {
      throw new Error(result.error || "Toplu SMS gönderimi sırasında hata oluştu.");
    }
    
    if (statusText) {
      statusText.style.color = '#10b981';
      if (result.mode === 'personalized') {
        statusText.textContent = `Tamamlandı! ${result.successCount} başarılı, ${result.failCount} başarısız.`;
      } else {
        statusText.textContent = `Tamamlandı! ${result.totalSent} adet SMS kuyruğa iletildi. (Job ID: ${result.jobId})`;
      }
    }
    
    document.getElementById('bulk-sms-message').value = '';
    if (document.getElementById('bulk-sms-manual-numbers')) {
      document.getElementById('bulk-sms-manual-numbers').value = '';
    }
    updateBulkSMSCounter();
    
    alert("Toplu SMS gönderim işlemi başarıyla tamamlandı.");
    
  } catch (err) {
    console.error(err);
    if (statusText) {
      statusText.style.color = '#ef4444';
      statusText.textContent = err.message;
    }
    alert(err.message);
  } finally {
    btn.innerHTML = originalBtnHTML;
    btn.disabled = false;
  }
}

let allAuditLogs = [];
let auditCurrentPage = 1;
let auditTotalCount = 0;

async function loadAuditLogs() {
  const tbody = document.getElementById('audit-logs-table-body');
  if (!tbody) return;

  tbody.innerHTML = `
    <tr>
      <td colspan="6" style="text-align: center; padding: 3rem 1.5rem; color: var(--color-text-muted); font-style: italic;">
        Denetim günlüğü yükleniyor, lütfen bekleyin...
      </td>
    </tr>
  `;

  const token = localStorage.getItem('parkexpert_token');
  if (!token) return;

  const searchQuery = (document.getElementById('audit-search-query')?.value || '').trim();
  const filterAction = document.getElementById('audit-filter-action')?.value || '';
  const startDateVal = document.getElementById('audit-filter-start-date')?.value || '';
  const endDateVal = document.getElementById('audit-filter-end-date')?.value || '';

  const params = new URLSearchParams();
  params.set("page", auditCurrentPage);
  params.set("limit", "50");
  if (searchQuery) params.set("search", searchQuery);
  if (filterAction) params.set("action_type", filterAction);
  if (startDateVal) params.set("start_date", startDateVal);
  if (endDateVal) params.set("end_date", endDateVal);

  try {
    const response = await fetch(`/api/audit_logs?${params.toString()}`, {
      headers: {
        "Authorization": `Bearer ${token}`
      }
    });

    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error || "Günlükler yüklenemedi.");
    }

    const result = await response.json();
    if (Array.isArray(result)) {
      allAuditLogs = result;
      auditTotalCount = result.length;
    } else {
      allAuditLogs = result.data || [];
      auditTotalCount = result.totalCount || 0;
    }

    renderAuditLogsTable(allAuditLogs);
    updateAuditPaginationControls();
  } catch (err) {
    console.error("Failed to load audit logs:", err);
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; padding: 3rem 1.5rem; color: var(--color-danger); font-weight: 600;">
          Hata oluştu: ${err.message}
        </td>
      </tr>
    `;
  }
}

function filterAuditLogs() {
  auditCurrentPage = 1;
  loadAuditLogs();
}

function updateAuditPaginationControls() {
  const infoEl = document.getElementById('audit-pagination-info');
  const prevBtn = document.getElementById('btn-audit-prev');
  const nextBtn = document.getElementById('btn-audit-next');
  if (!infoEl || !prevBtn || !nextBtn) return;

  const limit = 50;
  const start = auditTotalCount === 0 ? 0 : (auditCurrentPage - 1) * limit + 1;
  const end = Math.min(auditCurrentPage * limit, auditTotalCount);

  infoEl.textContent = `Gösterilen: ${start} - ${end} / Toplam: ${auditTotalCount}`;

  prevBtn.disabled = auditCurrentPage <= 1;
  nextBtn.disabled = end >= auditTotalCount;
}

function changeAuditPage(direction) {
  const limit = 50;
  const maxPage = Math.ceil(auditTotalCount / limit);
  
  const targetPage = auditCurrentPage + direction;
  if (targetPage >= 1 && (direction < 0 || targetPage <= maxPage)) {
    auditCurrentPage = targetPage;
    loadAuditLogs();
  }
}

window.changeAuditPage = changeAuditPage;

function renderAuditLogsTable(logs) {
  const tbody = document.getElementById('audit-logs-table-body');
  if (!tbody) return;

  tbody.innerHTML = '';

  if (logs.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; padding: 3rem 1.5rem; color: var(--color-text-muted); font-style: italic;">
          Gösterilecek denetim kaydı bulunamadı.
        </td>
      </tr>
    `;
    return;
  }

  logs.forEach(log => {
    const tr = document.createElement('tr');

    // Format Date
    let dateFormatted = '-';
    if (log.created_at) {
      try {
        const d = new Date(log.created_at);
        if (!isNaN(d.getTime())) {
          // Format with hours and minutes: DD.MM.YYYY HH:mm
          const day = String(d.getDate()).padStart(2, '0');
          const month = String(d.getMonth() + 1).padStart(2, '0');
          const year = d.getFullYear();
          const hours = String(d.getHours()).padStart(2, '0');
          const minutes = String(d.getMinutes()).padStart(2, '0');
          dateFormatted = `${day}.${month}.${year} ${hours}:${minutes}`;
        }
      } catch (e) {
        dateFormatted = log.created_at;
      }
    }

    // Role badge
    let roleBadge = '';
    if (log.admin_role === 'superadmin') {
      roleBadge = `<span class="status-badge" style="background-color: #fff1f2; color: #e11d48; border: 1px solid #fecdd3; font-weight: 700; font-size: 0.75rem;">Süper Admin</span>`;
    } else {
      roleBadge = `<span class="status-badge" style="background-color: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; font-weight: 700; font-size: 0.75rem;">Otopark Admin</span>`;
    }

    // Action Translation
    let actionLabel = log.action_type;
    let actionStyle = 'background-color: #f1f5f9; color: #475569; border: 1px solid #cbd5e1;';
    switch (log.action_type) {
      case 'approve_app':
        actionLabel = 'Başvuru Onaylandı ✅';
        actionStyle = 'background-color: #ecfdf5; color: #059669; border: 1px solid #a7f3d0;';
        break;
      case 'reject_app':
        actionLabel = 'Başvuru Reddedildi ❌';
        actionStyle = 'background-color: #fef2f2; color: #dc2626; border: 1px solid #fca5a5;';
        break;
      case 'management_approve':
        actionLabel = 'Yönetim İzni Verildi 🟢';
        actionStyle = 'background-color: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0;';
        break;
      case 'management_reject':
        actionLabel = 'Yönetim Reddedildi 🔴';
        actionStyle = 'background-color: #fff5f5; color: #e53e3e; border: 1px solid #fed7d7;';
        break;
      case 'extend_subscription':
        actionLabel = 'Abonelik Süresi Uzatıldı ⏳';
        actionStyle = 'background-color: #fffbeb; color: #d97706; border: 1px solid #fde68a;';
        break;
      case 'edit_application':
        actionLabel = 'Başvuru Düzenlendi ✏️';
        actionStyle = 'background-color: #f0fdfa; color: #0d9488; border: 1px solid #99f6e4;';
        break;
      case 'update_settings':
        actionLabel = 'Sistem Ayarları Değişti ⚙️';
        actionStyle = 'background-color: #f5f3ff; color: #7c3aed; border: 1px solid #ddd6fe;';
        break;
      case 'create_otopark':
        actionLabel = 'Yeni Otopark Eklendi ➕';
        actionStyle = 'background-color: #eff6ff; color: #2563eb; border: 1px solid #bfdbfe;';
        break;
      case 'update_otopark':
        actionLabel = 'Otopark Güncellendi 🔄';
        actionStyle = 'background-color: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0;';
        break;
      case 'delete_otopark':
        actionLabel = 'Otopark Silindi 🗑️';
        actionStyle = 'background-color: #fff5f5; color: #e53e3e; border: 1px solid #fed7d7;';
        break;
      case 'create_admin':
        actionLabel = 'Yeni Yönetici Eklendi 👤';
        actionStyle = 'background-color: #eff6ff; color: #2563eb; border: 1px solid #bfdbfe;';
        break;
      case 'update_admin':
        actionLabel = 'Yönetici Güncellendi 👤';
        actionStyle = 'background-color: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0;';
        break;
      case 'delete_admin':
        actionLabel = 'Yönetici Silindi 🗑️';
        actionStyle = 'background-color: #fff5f5; color: #e53e3e; border: 1px solid #fed7d7;';
        break;
    }

    tr.innerHTML = `
      <td style="padding: 0.85rem 1.5rem; font-weight: 600; color: var(--color-text-muted); font-size: 0.8rem; white-space: nowrap;">${dateFormatted}</td>
      <td style="padding: 0.85rem 1.5rem; font-weight: 700; color: var(--color-text-dark);">${log.admin_username}</td>
      <td style="padding: 0.85rem 1.5rem; vertical-align: middle;">${roleBadge}</td>
      <td style="padding: 0.85rem 1.5rem; vertical-align: middle;">
        <span class="status-badge" style="${actionStyle} font-weight: 700; font-size: 0.75rem; white-space: nowrap;">${actionLabel}</span>
      </td>
      <td style="padding: 0.85rem 1.5rem; color: var(--color-text-dark); font-weight: 500; line-height: 1.4; white-space: normal; word-break: break-word; min-width: 250px;">${maskAuditDetails(log.details || '')}</td>
      <td style="padding: 0.85rem 1.5rem; text-align: center; font-family: monospace; font-size: 0.8rem; color: var(--color-text-muted);">${log.ip_address || '-'}</td>
    `;

    tbody.appendChild(tr);
  });
}

// Bind loadAuditLogs to window so inline onclick handlers in admin.html can call it
window.loadAuditLogs = loadAuditLogs;
window.filterAuditLogs = filterAuditLogs;

async function downloadAuditLogsCSV() {
  const token = localStorage.getItem('parkexpert_token');
  if (!token) return;

  const searchQuery = (document.getElementById('audit-search-query')?.value || '').trim();
  const filterAction = document.getElementById('audit-filter-action')?.value || '';
  const startDateVal = document.getElementById('audit-filter-start-date')?.value || '';
  const endDateVal = document.getElementById('audit-filter-end-date')?.value || '';

  showToastNotification("Bilgi", "Arşiv hazırlanıyor, lütfen bekleyin...", "info");

  const params = new URLSearchParams();
  params.set("export", "true");
  if (searchQuery) params.set("search", searchQuery);
  if (filterAction) params.set("action_type", filterAction);
  if (startDateVal) params.set("start_date", startDateVal);
  if (endDateVal) params.set("end_date", endDateVal);

  try {
    const response = await fetch(`/api/audit_logs?${params.toString()}`, {
      headers: {
        "Authorization": `Bearer ${token}`
      }
    });

    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error || "Günlükler indirilemedi.");
    }

    const logsToExport = await response.json();
    if (!logsToExport || logsToExport.length === 0) {
      showToastNotification("Hata", "İndirilecek denetim kaydı bulunamadı.", "alert-triangle");
      return;
    }

    // Helper to format date
    const formatCSVDate = (dateStr) => {
      if (!dateStr) return '-';
      try {
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) {
          const day = String(d.getDate()).padStart(2, '0');
          const month = String(d.getMonth() + 1).padStart(2, '0');
          const year = d.getFullYear();
          const hours = String(d.getHours()).padStart(2, '0');
          const minutes = String(d.getMinutes()).padStart(2, '0');
          return `${day}.${month}.${year} ${hours}:${minutes}`;
        }
      } catch (e) {}
      return dateStr;
    };

    // Build CSV content
    let csvContent = "\uFEFF"; // UTF-8 BOM
    csvContent += "Tarih;Yönetici;Yetki Rolü;İşlem Türü;İşlem Detayı;IP Adresi\n";

    logsToExport.forEach(log => {
      const date = formatCSVDate(log.created_at);
      const username = log.admin_username || '';
      
      let role = 'Temsilci/Admin';
      if (log.admin_role === 'superadmin') role = 'Süper Admin';
      else if (log.admin_role === 'yonetim') role = 'Site Yönetimi';

      // Translate action label
      let actionLabel = log.action_type || '';
      switch (log.action_type) {
        case 'approve_app': actionLabel = 'Başvuru Onaylandı ✅'; break;
        case 'reject_app': actionLabel = 'Başvuru Reddedildi ❌'; break;
        case 'management_approve': actionLabel = 'Yönetim İzni Verildi 🟢'; break;
        case 'management_reject': actionLabel = 'Yönetim Reddedildi 🔴'; break;
        case 'extend_subscription': actionLabel = 'Abonelik Süresi Uzatıldı ⏳'; break;
        case 'edit_application': actionLabel = 'Başvuru Düzenlendi ✏️'; break;
        case 'update_settings': actionLabel = 'Sistem Ayarları Değişti ⚙️'; break;
        case 'create_otopark': actionLabel = 'Yeni Otopark Eklendi ➕'; break;
        case 'update_otopark': actionLabel = 'Otopark Güncellendi 🔄'; break;
        case 'delete_otopark': actionLabel = 'Otopark Silindi 🗑️'; break;
        case 'create_admin': actionLabel = 'Yeni Yönetici Eklendi 👤'; break;
        case 'update_admin': actionLabel = 'Yönetici Güncellendi 👤'; break;
        case 'delete_admin': actionLabel = 'Yönetici Silindi 🗑️'; break;
      }

      const details = (log.details || '').replace(/;/g, ',').replace(/\n/g, ' '); // escape semi-colons and newlines
      const ip = log.ip_address || '';

      csvContent += `"${date}";"${username}";"${role}";"${actionLabel}";"${details}";"${ip}"\n`;
    });

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `denetim_gunlukleri_arşiv_${new Date().toISOString().substring(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    showToastNotification("Başarılı", "Tüm arşiv başarıyla dışa aktarıldı.", "check");
  } catch (err) {
    console.error("Export failed:", err);
    showToastNotification("Hata", `Dışa aktarım başarısız: ${err.message}`, "alert-triangle");
  }
}

window.downloadAuditLogsCSV = downloadAuditLogsCSV;

function downloadSMSReportsCSV() {
  const logs = window.allSMSLogs;
  if (!logs || logs.length === 0) {
    showToastNotification("Hata", "İndirilecek SMS kaydı bulunamadı.", "alert-triangle");
    return;
  }

  const searchVal = document.getElementById('sms-search-input')?.value.toLowerCase().trim() || '';
  
  let filtered = logs;

  // Apply status filter
  if (window.currentSMSFilter === 'delivered') {
    filtered = filtered.filter(log => log.status === 'İletildi' || log.status === 'Simüle Edildi');
  } else if (window.currentSMSFilter === 'pending') {
    filtered = filtered.filter(log => log.status === 'Beklemede' || log.status === 'Zamanlandı');
  } else if (window.currentSMSFilter === 'failed') {
    filtered = filtered.filter(log => log.status && (log.status.startsWith('Hata') || log.status.startsWith('İletilemedi')));
  }

  // Apply search filter
  if (searchVal) {
    filtered = filtered.filter(log => 
      log.phone.toLowerCase().includes(searchVal) || 
      log.message.toLowerCase().includes(searchVal) ||
      (log.location && log.location.toLowerCase().includes(searchVal)) ||
      (log.job_id && log.job_id.toLowerCase().includes(searchVal))
    );
  }

  if (filtered.length === 0) {
    showToastNotification("Hata", "Filtreleme kriterlerine uygun SMS kaydı bulunamadı.", "alert-triangle");
    return;
  }

  // Helper to format date
  const formatCSVDate = (dateStr) => {
    if (!dateStr) return '-';
    try {
      const d = new Date(dateStr);
      if (!isNaN(d.getTime())) {
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        const hours = String(d.getHours()).padStart(2, '0');
        const minutes = String(d.getMinutes()).padStart(2, '0');
        return `${day}.${month}.${year} ${hours}:${minutes}`;
      }
    } catch (e) {}
    return dateStr;
  };

  // Build CSV content
  // Headers with UTF-8 BOM so Turkish characters display correctly in Excel
  let csvContent = "\uFEFF";
  csvContent += "Alıcı Telefon;Lokasyon;Mesaj İçeriği;Zamanlama / Gönderim Tarihi;Netgsm Job ID;Durum\n";

  filtered.forEach(log => {
    const phone = log.phone || '';
    const location = log.location || 'Sistem';
    const message = (log.message || '').replace(/;/g, ',').replace(/\n/g, ' '); // escape semi-colons and newlines
    const date = formatCSVDate(log.scheduled_at || log.created_at);
    const jobId = log.job_id || '-';
    const status = log.status || '';

    csvContent += `"${phone}";"${location}";"${message}";"${date}";"${jobId}";"${status}"\n`;
  });

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `sms_raporlari_${new Date().toISOString().substring(0, 10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

window.downloadSMSReportsCSV = downloadSMSReportsCSV;

/* ==========================================================================
   DATABASE BACKUPS MANAGEMENT FUNCTIONS
   ========================================================================== */

async function loadBackupsList() {
  const container = document.getElementById('backup-list-container');
  if (!container) return;

  const token = localStorage.getItem('parkexpert_token');
  if (!token) {
    container.innerHTML = '<span style="font-size: 0.8rem; color: var(--color-accent-red);">Oturum bulunamadı. Lütfen tekrar giriş yapın.</span>';
    return;
  }

  container.innerHTML = '<span style="font-size: 0.8rem; color: var(--color-text-muted);"><span class="ocr-spinner"></span> Yedekler yükleniyor...</span>';

  try {
    const res = await fetch('/api/backups?action=list', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!res.ok) {
      throw new Error('Yedekler listesi alınamadı.');
    }

    const data = await res.json();
    if (!data.success) {
      if (data.error === 'BACKUP_BUCKET_MISSING') {
        container.innerHTML = `
          <div style="background: rgba(245,158,11,0.05); border: 1px dashed rgba(245,158,11,0.25); border-radius: var(--radius-md); padding: 0.85rem; font-size: 0.75rem; color: #b45309; line-height: 1.5;">
            <strong>Bilgi:</strong> ${data.message}<br><br>
            Yedekleriniz şu anda GitHub Actions aracılığıyla Google Drive'a ve R2'ye otomatik olarak yedeklenmeye devam ediyor ancak panelde listelenmesi için Cloudflare Pages'te R2 binding ayarının (BACKUP_BUCKET) yapılması gereklidir.
          </div>
        `;
      } else {
        container.innerHTML = `<span style="font-size: 0.8rem; color: var(--color-accent-red);">${data.message || 'Bir hata oluştu.'}</span>`;
      }
      return;
    }

    const files = data.files || [];
    if (files.length === 0) {
      container.innerHTML = '<span style="font-size: 0.8rem; color: var(--color-text-muted);">Henüz alınmış bir veritabanı yedeği bulunmuyor.</span>';
      return;
    }

    // Render table
    let html = `
      <table style="width: 100%; border-collapse: collapse; font-size: 0.775rem; text-align: left; margin-top: 0.5rem;">
        <thead>
          <tr style="border-bottom: 2px solid var(--color-border-light); font-weight: 700; color: var(--color-primary-dark); height: 32px;">
            <th style="padding: 0.25rem 0.5rem;">Tarih / Saat</th>
            <th style="padding: 0.25rem 0.5rem;">Dosya Türü</th>
            <th style="padding: 0.25rem 0.5rem; text-align: right; width: 80px;">Boyut</th>
            <th style="padding: 0.25rem 0.5rem; text-align: right; width: 80px;">İndir</th>
          </tr>
        </thead>
        <tbody>
    `;

    files.forEach(f => {
      const dateObj = new Date(f.uploaded);
      const displayTime = dateObj.toLocaleString('tr-TR');
      const isExcel = f.key.endsWith('.xlsx');
      const fileTypeLabel = isExcel ? 'Excel Rapor 📊' : 'Veritabanı Dump 💾';
      const sizeMb = (f.size / (1024 * 1024)).toFixed(2) + ' MB';

      html += `
        <tr style="border-bottom: 1px solid var(--color-border-light); height: 36px; transition: background var(--transition-fast);" onmouseover="this.style.background='rgba(15, 59, 162, 0.02)'" onmouseout="this.style.background='transparent'">
          <td style="padding: 0.25rem 0.5rem; font-weight: 500;">${displayTime}</td>
          <td style="padding: 0.25rem 0.5rem;"><code style="background:#f1f5f9; padding: 0.1rem 0.3rem; border-radius: 4px;">${fileTypeLabel}</code></td>
          <td style="padding: 0.25rem 0.5rem; text-align: right; color: var(--color-text-muted);">${sizeMb}</td>
          <td style="padding: 0.25rem 0.5rem; text-align: right;">
            <button type="button" onclick="downloadBackupFile('${f.key}')" class="btn btn-secondary" style="padding: 0.15rem 0.5rem; font-size: 0.7rem; min-height: 24px; display: inline-flex; align-items: center; gap: 0.2rem;">
              <i data-lucide="download" style="width: 12px; height: 12px;"></i>
              <span>İndir</span>
            </button>
          </td>
        </tr>
      `;
    });

    html += `
        </tbody>
      </table>
    `;

    container.innerHTML = html;
    if (typeof lucide !== 'undefined') lucide.createIcons();

  } catch (error) {
    console.error('loadBackupsList error:', error);
    container.innerHTML = `<span style="font-size: 0.8rem; color: var(--color-accent-red);">Yedek listesi yüklenemedi: ${error.message}</span>`;
  }
}

async function triggerManualBackup() {
  const btn = document.getElementById('btn-trigger-backup');
  if (!btn) return;

  const token = localStorage.getItem('parkexpert_token');
  if (!token) {
    alert("Yetkisiz işlem! Lütfen tekrar giriş yapın.");
    return;
  }

  if (!confirm("Manuel veritabanı yedekleme işlemini başlatmak istediğinize emin misiniz?\nBu işlem GitHub Actions üzerinde yedekleme workflow'unu tetikleyecektir.")) {
    return;
  }

  btn.disabled = true;
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '<span class="ocr-spinner"></span> <span>Tetikleniyor...</span>';

  try {
    const res = await fetch('/api/backups?action=trigger', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!res.ok) throw new Error("Yedekleme tetiklenemedi.");

    const data = await res.json();
    if (data.success) {
      alert(data.message);
      showToastNotification("Yedekleme", "Manuel yedekleme başarıyla tetiklendi.", "check-circle");
    } else {
      if (data.error === 'GITHUB_PAT_MISSING') {
        alert("Hata: GITHUB_PAT (GitHub Personal Access Token) Cloudflare Dashboard'da tanımlanmış olmalıdır.\n\nEğer tanımlı değilse bu işlemi gerçekleştiremezsiniz. Ancak her gün sabaha karşı 06:00'da otomatik yedek alınmaya devam eder.");
      } else {
        alert(data.message || "Bir hata oluştu.");
      }
    }
  } catch (err) {
    console.error(err);
    alert("Tetikleme başarısız: " + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
    if (typeof lucide !== 'undefined') lucide.createIcons();
    setTimeout(loadBackupsList, 3000);
  }
}

async function downloadBackupFile(filename) {
  const token = localStorage.getItem('parkexpert_token');
  if (!token) {
    alert("Yetkisiz işlem! Lütfen tekrar giriş yapın.");
    return;
  }

  try {
    const res = await fetch(`/api/backups?action=download&file=${encodeURIComponent(filename)}`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!res.ok) {
      throw new Error("Yedek dosyası indirilemedi.");
    }

    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);

    showToastNotification("Dosya İndirme", `${filename} başarıyla indirildi.`, "check-circle");
  } catch (err) {
    console.error(err);
    alert("İndirme hatası: " + err.message);
  }
}

window.loadBackupsList = loadBackupsList;
window.triggerManualBackup = triggerManualBackup;
window.downloadBackupFile = downloadBackupFile;

// ==========================================================================
// ACTIVE SESSIONS & HEARTBEAT SYSTEM
// ==========================================================================

function startHeartbeatTimer() {
  if (window.heartbeatInterval) {
    clearInterval(window.heartbeatInterval);
  }
  
  // Heartbeat every 2 minutes (120,000 ms)
  window.heartbeatInterval = setInterval(async () => {
    const token = localStorage.getItem('parkexpert_token');
    if (!token) return;
    
    try {
      const res = await fetch('/api/heartbeat', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (res.status === 401) {
        clearInterval(window.heartbeatInterval);
        alert("Oturumunuz sunucu veya başka bir yönetici tarafından sonlandırıldı. Tekrar giriş yapın.");
        handleAdminLogout('terminated');
      }
    } catch (err) {
      console.error("Heartbeat failed:", err);
    }
  }, 120 * 1000);
}

async function fetchActiveSessions() {
  const token = localStorage.getItem('parkexpert_token');
  const tableBody = document.getElementById('active-sessions-table-body');
  const countSpan = document.getElementById('sessions-results-count');
  
  if (!token || !tableBody) return;
  
  tableBody.innerHTML = `
    <tr>
      <td colspan="6" style="padding: 2rem; text-align: center; color: var(--color-text-muted);">
        <span class="ocr-spinner" style="display: inline-block; margin-right: 0.5rem; vertical-align: middle;"></span> Aktif oturumlar yükleniyor...
      </td>
    </tr>
  `;
  
  try {
    const res = await fetch('/api/active_sessions', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    if (!res.ok) {
      throw new Error(await res.text());
    }
    
    const data = await res.json();
    
    if (countSpan) {
      countSpan.textContent = `(${data.length} aktif oturum)`;
    }
    
    if (data.length === 0) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="6" style="padding: 2rem; text-align: center; color: var(--color-text-muted);">
            Aktif oturum bulunamadı.
          </td>
        </tr>
      `;
      return;
    }
    
    // Get current session token payload to highlight current session
    const parts = token.split('.');
    let currentJti = '';
    if (parts.length >= 2) {
      try {
        const payloadStr = atob(parts[0]);
        const payload = JSON.parse(payloadStr);
        currentJti = payload.jti || '';
      } catch(e){}
    }
    
    tableBody.innerHTML = data.map(session => {
      const isCurrent = session.id === currentJti;
      const createdDate = new Date(session.created_at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) + ' ' + new Date(session.created_at).toLocaleDateString('tr-TR');
      const lastActiveDate = new Date(session.last_active_at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
      
      // Parse User Agent to show a clean browser/OS label
      let clientInfo = "Bilinmeyen Cihaz";
      const ua = session.user_agent || "";
      if (ua.includes("Chrome") && !ua.includes("Edg")) clientInfo = "Google Chrome";
      else if (ua.includes("Safari") && !ua.includes("Chrome")) clientInfo = "Safari";
      else if (ua.includes("Firefox")) clientInfo = "Mozilla Firefox";
      else if (ua.includes("Edg")) clientInfo = "Microsoft Edge";
      
      if (ua.includes("Windows")) clientInfo += " (Windows)";
      else if (ua.includes("Macintosh")) clientInfo += " (Mac)";
      else if (ua.includes("Android")) clientInfo += " (Android)";
      else if (ua.includes("iPhone")) clientInfo += " (iPhone)";

      return `
        <tr style="border-bottom: 1px solid var(--color-border-light); ${isCurrent ? 'background: rgba(16, 185, 129, 0.03);' : ''}">
          <td style="padding: 1rem; font-weight: 600; color: var(--color-text-dark);">
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <span class="user-avatar" style="width: 24px; height: 24px; font-size: 0.7rem; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: ${isCurrent ? '#10b981' : '#0f3ba2'}; color: #ffffff; font-weight: 700;">
                ${session.name.substring(0, 1).toUpperCase()}
              </span>
              <span>${session.name} (${session.username})</span>
              ${isCurrent ? '<span style="font-size: 0.65rem; font-weight: 700; background: #10b981; color: #ffffff; padding: 0.1rem 0.35rem; border-radius: 4px; margin-left: 0.25rem;">BU CİHAZ</span>' : ''}
            </td>
            <td style="padding: 1rem; color: var(--color-text-muted); font-weight: 500;">
              ${session.role === 'superadmin' ? 'Süper Admin' : 'Admin'}
            </td>
            <td style="padding: 1rem; font-family: monospace; color: var(--color-text-dark);">
              ${session.ip_address || 'Bilinmiyor'}<br>
              <span style="font-size: 0.7rem; color: var(--color-text-muted); font-family: sans-serif;">${clientInfo}</span>
            </td>
            <td style="padding: 1rem; color: var(--color-text-muted);">
              ${createdDate}
            </td>
            <td style="padding: 1rem; color: var(--color-text-muted); font-weight: 500;">
              ${lastActiveDate}
            </td>
            <td style="padding: 1rem; text-align: center;">
              ${isCurrent ? `
                <span style="font-size: 0.75rem; color: var(--color-text-muted); font-weight: 600;">Oturum Açık</span>
              ` : `
                <button class="btn btn-secondary" onclick="terminateSession('${session.id}', '${session.created_at}', '${session.username}')" style="padding: 0.3rem 0.6rem; font-size: 0.75rem; border-radius: var(--radius-sm); border: 1px solid #ef4444; color: #ef4444; background: transparent; font-weight: 700; transition: all 0.2s;" onmouseover="this.style.background='#ef4444'; this.style.color='#ffffff';" onmouseout="this.style.background='transparent'; this.style.color='#ef4444';">
                  Sonlandır
                </button>
              `}
            </td>
          </tr>
        `;
    }).join('');
    
    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }
  } catch (err) {
    console.error("Failed to load active sessions:", err);
    tableBody.innerHTML = `
      <tr>
        <td colspan="6" style="padding: 2rem; text-align: center; color: #ef4444; font-weight: 700;">
          Oturumlar yüklenirken hata oluştu: ${err.message}
        </td>
      </tr>
    `;
  }
}

async function terminateSession(jti, expiresAt, username) {
  if (!confirm(`'${username}' kullanıcısının bu oturumunu zorla sonlandırmak istediğinize emin misiniz?\nKullanıcı sistemden anında atılacaktır.`)) {
    return;
  }
  
  const token = localStorage.getItem('parkexpert_token');
  if (!token) return;
  
  try {
    const res = await fetch('/api/active_sessions', {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ jti, expiresAt, username })
    });
    
    if (!res.ok) {
      throw new Error(await res.text());
    }
    
    alert("Oturum başarıyla sonlandırıldı.");
    fetchActiveSessions();
  } catch (err) {
    alert(`Oturum kapatılamadı: ${err.message}`);
  }
}

window.fetchActiveSessions = fetchActiveSessions;
window.terminateSession = terminateSession;



