// TIMBERPRO - MAIN APPLICATION
// Cloudflare Workers + D1 + Vanilla JS

// ==================== CONFIGURATION ====================
const API_BASE_URL = 'https://your-worker-url.workers.dev'; // CHANGE THIS!
const APP_VERSION = '1.0.0';
const DB_NAME = 'TimberProDB';
const DB_VERSION = 1;

// ==================== STATE ====================
let currentUser = null;
let currentPage = 'dashboard';
let products = [];
let services = [];
let cart = [];
let branches = [];
let isOnline = navigator.onLine;
let syncInProgress = false;

// ==================== INDEXEDDB (OFFLINE SUPPORT) ====================
class OfflineDB {
    constructor() {
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => { this.db = request.result; resolve(); };
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('sales_queue')) {
                    db.createObjectStore('sales_queue', { keyPath: 'id', autoIncrement: true });
                }
                if (!db.objectStoreNames.contains('products_cache')) {
                    db.createObjectStore('products_cache', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('drafts_local')) {
                    db.createObjectStore('drafts_local', { keyPath: 'id', autoIncrement: true });
                }
                if (!db.objectStoreNames.contains('settings')) {
                    db.createObjectStore('settings', { keyPath: 'key' });
                }
            };
        });
    }

    async addToQueue(sale) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('sales_queue', 'readwrite');
            const store = tx.objectStore('sales_queue');
            const request = store.add({ ...sale, queued_at: new Date().toISOString(), synced: false });
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getQueue() {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('sales_queue', 'readonly');
            const store = tx.objectStore('sales_queue');
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async removeFromQueue(id) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('sales_queue', 'readwrite');
            const store = tx.objectStore('sales_queue');
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async cacheProducts(products) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('products_cache', 'readwrite');
            const store = tx.objectStore('products_cache');
            products.forEach(p => store.put(p));
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async getCachedProducts() {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('products_cache', 'readonly');
            const store = tx.objectStore('products_cache');
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async saveSetting(key, value) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('settings', 'readwrite');
            const store = tx.objectStore('settings');
            const request = store.put({ key, value, updated: new Date().toISOString() });
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async getSetting(key) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('settings', 'readonly');
            const store = tx.objectStore('settings');
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result?.value || null);
            request.onerror = () => reject(request.error);
        });
    }
}

const offlineDB = new OfflineDB();

// ==================== API CLIENT ====================
class API {
    static getToken() { return localStorage.getItem('token'); }

    static async request(method, endpoint, data = null, options = {}) {
        const url = `${API_BASE_URL}/api${endpoint}`;
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.getToken()}`
        };

        const config = {
            method,
            headers,
            ...options
        };

        if (data && method !== 'GET') {
            config.body = JSON.stringify(data);
        }

        try {
            const response = await fetch(url, config);
            if (response.status === 401) {
                logout();
                return { success: false, error: 'Session expired' };
            }
            const result = await response.json();
            return result;
        } catch (error) {
            console.error('API Error:', error);
            return { success: false, error: error.message || 'Network error' };
        }
    }

    static get(endpoint) { return this.request('GET', endpoint); }
    static post(endpoint, data) { return this.request('POST', endpoint, data); }
    static put(endpoint, data) { return this.request('PUT', endpoint, data); }
    static delete(endpoint) { return this.request('DELETE', endpoint); }
}

// ==================== AUTHENTICATION ====================
async function initAuth() {
    const token = localStorage.getItem('token');
    if (!token) {
        showLogin();
        return;
    }

    const result = await API.get('/auth/me');
    if (result.success && result.user) {
        currentUser = result.user;
        showApp();
        loadPage('dashboard');
        updateSidebarUser();
        filterNavByPermissions();
    } else {
        logout();
    }
}

async function login(username, password) {
    showLoading(true);
    const result = await API.post('/auth/login', { username, password });
    showLoading(false);

    if (result.success && result.token) {
        localStorage.setItem('token', result.token);
        currentUser = result.user;
        showApp();
        loadPage('dashboard');
        updateSidebarUser();
        filterNavByPermissions();
        showToast('Welcome back!', 'success');
    } else {
        const errorEl = document.getElementById('login-error');
        errorEl.textContent = result.error || 'Login failed';
        errorEl.classList.remove('hidden');
        document.getElementById('login-form').classList.add('shake');
        setTimeout(() => document.getElementById('login-form').classList.remove('shake'), 500);
    }
}

function logout() {
    localStorage.removeItem('token');
    currentUser = null;
    cart = [];
    showLogin();
    showToast('Logged out successfully', 'info');
}

function updateSidebarUser() {
    if (!currentUser) return;
    document.getElementById('user-name').textContent = currentUser.full_name || currentUser.username;
    document.getElementById('user-role').textContent = currentUser.role || 'User';
}

function filterNavByPermissions() {
    if (!currentUser) return;
    const permissions = currentUser.permissions || [];
    const isAdmin = currentUser.role === 'admin';

    document.querySelectorAll('.nav-item[data-perm]').forEach(item => {
        const perm = item.dataset.perm;
        if (!isAdmin && !permissions.includes(perm) && !permissions.includes('*')) {
            item.classList.add('hidden');
        }
    });
}

// ==================== UI HELPERS ====================
function showLogin() {
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');
    document.getElementById('splash-screen').classList.add('hidden');
}

function showApp() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    document.getElementById('splash-screen').classList.add('hidden');
}

function showLoading(show) {
    document.getElementById('loading-overlay').classList.toggle('hidden', !show);
}

function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    toast.innerHTML = `
        <span>${icons[type] || 'ℹ️'}</span>
        <span>${message}</span>
        <button class="toast-close" onclick="this.parentElement.remove()">✕</button>
    `;

    container.appendChild(toast);

    if (duration > 0) {
        setTimeout(() => toast.remove(), duration);
    }
}

function openModal(content, centered = true) {
    const container = document.getElementById('modal-container');
    const modalContent = container.querySelector('.modal-content');
    modalContent.innerHTML = content;
    container.classList.remove('hidden');
    if (centered) container.classList.add('centered');
    else container.classList.remove('centered');

    // Close on overlay click
    container.querySelector('.modal-overlay').onclick = closeModal;
}

function closeModal() {
    document.getElementById('modal-container').classList.add('hidden');
}

function formatCurrency(amount) {
    return 'GHS ' + parseFloat(amount || 0).toFixed(2);
}

function formatDate(dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatDateTime(dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ==================== ROUTER ====================
function loadPage(page, params = {}) {
    currentPage = page;
    const mainContent = document.getElementById('main-content');

    // Update sidebar active state
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    const activeNav = document.querySelector(`.nav-item[data-page="${page}"]`);
    if (activeNav) activeNav.classList.add('active');

    // Close sidebar on mobile
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('active');
    document.getElementById('menu-toggle').classList.remove('active');

    // Render page
    window.scrollTo(0, 0);

    const pageRenderers = {
        'dashboard': renderDashboard,
        'sales': renderSales,
        'drafts': renderDrafts,
        'orders': renderOrders,
        'inventory': renderInventory,
        'products': renderProducts,
        'services': renderServices,
        'expenses': renderExpenses,
        'employees': renderEmployees,
        'payroll': renderPayroll,
        'customers': renderCustomers,
        'analytics': renderAnalytics,
        'reports': renderReports,
        'branches': renderBranches,
        'users': renderUsers,
        'audit-logs': renderAuditLogs,
        'settings': renderSettings
    };

    const renderer = pageRenderers[page];
    if (renderer) {
        mainContent.innerHTML = `<div class="page">${renderer(params)}</div>`;
        if (window[`init${page.charAt(0).toUpperCase() + page.slice(1)}Page`]) {
            window[`init${page.charAt(0).toUpperCase() + page.slice(1)}Page`](params);
        }
    } else {
        mainContent.innerHTML = `<div class="page"><div class="empty-state"><div class="empty-icon">📄</div><div class="empty-title">Page Not Found</div></div></div>`;
    }
}

// ==================== SPLASH SCREEN ====================
window.addEventListener('load', () => {
    setTimeout(() => {
        document.querySelector('.splash-loader-bar').style.width = '100%';
    }, 100);

    setTimeout(() => {
        initAuth();
    }, 1500);
});

// ==================== EVENT LISTENERS ====================
document.addEventListener('DOMContentLoaded', () => {
    // Login form
    document.getElementById('login-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;
        login(username, password);
    });

    // Menu toggle
    document.getElementById('menu-toggle').addEventListener('click', () => {
        document.getElementById('sidebar').classList.toggle('open');
        document.getElementById('sidebar-overlay').classList.toggle('active');
        document.getElementById('menu-toggle').classList.toggle('active');
    });

    // Sidebar close
    document.getElementById('sidebar-close').addEventListener('click', () => {
        document.getElementById('sidebar').classList.remove('open');
        document.getElementById('sidebar-overlay').classList.remove('active');
        document.getElementById('menu-toggle').classList.remove('active');
    });

    // Sidebar overlay
    document.getElementById('sidebar-overlay').addEventListener('click', () => {
        document.getElementById('sidebar').classList.remove('open');
        document.getElementById('sidebar-overlay').classList.remove('active');
        document.getElementById('menu-toggle').classList.remove('active');
    });

    // Navigation
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const page = item.dataset.page;
            if (page) loadPage(page);
        });
    });

    // Logout
    document.getElementById('logout-btn').addEventListener('click', logout);

    // Online/Offline detection
    window.addEventListener('online', () => {
        isOnline = true;
        document.getElementById('offline-banner').classList.add('hidden');
        showToast('Back online! Syncing queued sales...', 'success');
        syncQueuedSales();
    });

    window.addEventListener('offline', () => {
        isOnline = false;
        document.getElementById('offline-banner').classList.remove('hidden');
        showToast('You are offline. Sales will be queued.', 'warning');
    });

    // Initialize IndexedDB
    offlineDB.init().catch(console.error);
});

// ==================== SYNC QUEUED SALES ====================
async function syncQueuedSales() {
    if (syncInProgress || !isOnline) return;
    syncInProgress = true;

    try {
        const queue = await offlineDB.getQueue();
        for (const sale of queue) {
            const result = await API.post('/sales', sale.data);
            if (result.success) {
                await offlineDB.removeFromQueue(sale.id);
            }
        }
        if (queue.length > 0) {
            showToast(`${queue.length} sales synced successfully!`, 'success');
        }
    } catch (error) {
        console.error('Sync error:', error);
    } finally {
        syncInProgress = false;
    }
}

// ==================== DASHBOARD ====================
function renderDashboard() {
    return `
        <div class="page-header">
            <div>
                <h1 class="page-title">Dashboard</h1>
                <p class="page-subtitle">Overview of your business</p>
            </div>
        </div>
        <div class="grid-4" id="dashboard-stats">
            <div class="stat-card">
                <div class="stat-label">Today's Sales</div>
                <div class="stat-value" id="stat-today-sales">Loading...</div>
                <div class="stat-change" id="stat-today-count">0 transactions</div>
            </div>
            <div class="stat-card success">
                <div class="stat-label">This Month</div>
                <div class="stat-value" id="stat-month-sales">Loading...</div>
                <div class="stat-change up">Revenue</div>
            </div>
            <div class="stat-card warning">
                <div class="stat-label">Expenses</div>
                <div class="stat-value" id="stat-expenses">Loading...</div>
                <div class="stat-change down">This month</div>
            </div>
            <div class="stat-card danger">
                <div class="stat-label">Low Stock</div>
                <div class="stat-value" id="stat-low-stock">Loading...</div>
                <div class="stat-change">Items need attention</div>
            </div>
        </div>
        <div class="grid-2">
            <div class="card">
                <div class="card-header">
                    <div class="card-title">Sales Trend (Last 7 Days)</div>
                </div>
                <div class="chart-container" id="sales-chart">
                    <div class="empty-state"><div class="empty-icon">📊</div><div class="empty-text">Loading chart...</div></div>
                </div>
            </div>
            <div class="card">
                <div class="card-header">
                    <div class="card-title">Payment Methods</div>
                </div>
                <div class="chart-container" id="payment-chart">
                    <div class="empty-state"><div class="empty-icon">💳</div><div class="empty-text">Loading...</div></div>
                </div>
            </div>
        </div>
        <div class="card">
            <div class="card-header">
                <div class="card-title">Top Products (This Month)</div>
            </div>
            <div id="top-products-table">
                <div class="empty-state"><div class="empty-icon">🪵</div><div class="empty-text">Loading...</div></div>
            </div>
        </div>
    `;
}

async function initDashboardPage() {
    const result = await API.get('/analytics/dashboard');
    if (!result.success) {
        showToast('Failed to load dashboard', 'error');
        return;
    }

    const data = result.dashboard;

    document.getElementById('stat-today-sales').textContent = formatCurrency(data.today_sales.total);
    document.getElementById('stat-today-count').textContent = `${data.today_sales.count} transactions`;
    document.getElementById('stat-month-sales').textContent = formatCurrency(data.month_sales.total);
    document.getElementById('stat-expenses').textContent = formatCurrency(data.month_expenses.total);
    document.getElementById('stat-low-stock').textContent = data.low_stock_count;

    // Render sales chart
    if (data.sales_chart && data.sales_chart.length > 0) {
        const maxVal = Math.max(...data.sales_chart.map(d => d.total));
        const chartHtml = `
            <div class="bar-chart">
                ${data.sales_chart.map(d => `
                    <div class="bar-chart-item">
                        <div class="bar-chart-bar" style="height: ${maxVal > 0 ? (d.total / maxVal * 100) : 0}%"></div>
                        <div class="bar-chart-label">${new Date(d.date).getDate()}</div>
                        <div class="bar-chart-value">${formatCurrency(d.total)}</div>
                    </div>
                `).join('')}
            </div>
        `;
        document.getElementById('sales-chart').innerHTML = chartHtml;
    }

    // Render payment breakdown
    if (data.payment_breakdown && data.payment_breakdown.length > 0) {
        const colors = ['#1a5f4a', '#f4a261', '#e76f51', '#74b9ff'];
        const total = data.payment_breakdown.reduce((sum, p) => sum + p.total, 0);
        let currentAngle = 0;

        const pieHtml = `
            <div style="display: flex; align-items: center; gap: 24px; flex-wrap: wrap;">
                <div class="pie-chart" style="background: conic-gradient(${data.payment_breakdown.map((p, i) => {
                    const angle = (p.total / total) * 360;
                    const start = currentAngle;
                    currentAngle += angle;
                    return `${colors[i % colors.length]} ${start}deg ${currentAngle}deg`;
                }).join(', ')}"></div>
                <div class="pie-chart-legend">
                    ${data.payment_breakdown.map((p, i) => `
                        <div class="pie-legend-item">
                            <div class="pie-legend-color" style="background: ${colors[i % colors.length]}"></div>
                            <span>${p.payment_method}: ${formatCurrency(p.total)} (${p.count})</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
        document.getElementById('payment-chart').innerHTML = pieHtml;
    }

    // Render top products
    if (data.top_products && data.top_products.length > 0) {
        const tableHtml = `
            <div class="table-container table-responsive">
                <table class="table">
                    <thead><tr><th>Product</th><th>Qty Sold</th><th>Revenue</th></tr></thead>
                    <tbody>
                        ${data.top_products.map(p => `
                            <tr>
                                <td data-label="Product">${escapeHtml(p.name)}</td>
                                <td data-label="Qty">${p.total_qty}</td>
                                <td data-label="Revenue">${formatCurrency(p.total_revenue)}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
        document.getElementById('top-products-table').innerHTML = tableHtml;
    }

    // Low stock alerts
    if (data.low_stock_items && data.low_stock_items.length > 0) {
        showToast(`${data.low_stock_items.length} products are low on stock!`, 'warning', 5000);
    }
}

// ==================== SALES PAGE (CRITICAL - FAST UI) ====================
function renderSales() {
    return `
        <div class="page-header">
            <div>
                <h1 class="page-title">New Sale</h1>
                <p class="page-subtitle">Tap products to add to cart</p>
            </div>
            <div id="cart-badge" style="background: var(--primary); color: white; padding: 6px 14px; border-radius: 20px; font-weight: 700; font-size: 14px; display: none;">
                🛒 <span id="cart-badge-count">0</span> items
            </div>
        </div>

        <!-- Products Section -->
        <div class="sales-search" style="margin-bottom: 16px;">
            <span class="search-icon">🔍</span>
            <input type="text" id="product-search" placeholder="Search products & services..." autocomplete="off">
        </div>
        <div id="product-results" class="product-grid" style="margin-bottom: 20px; min-height: 200px;"></div>

        <!-- Cart Section - Collapsible on mobile -->
        <div class="cart-section" id="cart-section">
            <div class="cart-header" onclick="toggleCart()" style="display: flex; justify-content: space-between; align-items: center; cursor: pointer; padding-bottom: 12px; border-bottom: 2px solid var(--border-light);">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-size: 20px;">🛒</span>
                    <h3 style="font-size: 16px; font-weight: 600; margin: 0;">Cart</h3>
                    <span id="cart-count-badge" style="background: var(--primary); color: white; padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 700;">0</span>
                </div>
                <div style="display: flex; align-items: center; gap: 12px;">
                    <span id="cart-header-total" style="font-weight: 700; color: var(--primary); font-size: 16px;">GHS 0.00</span>
                    <span id="cart-toggle-icon" style="font-size: 18px; transition: transform 0.2s;">▼</span>
                </div>
            </div>

            <div id="cart-body" class="cart-body" style="padding-top: 12px;">
                <div id="cart-items" class="cart-items" style="max-height: 250px; overflow-y: auto;">
                    <div class="empty-state" style="padding: 16px;">
                        <div class="empty-icon" style="font-size: 28px;">🛒</div>
                        <div class="empty-text" style="font-size: 13px;">Tap products above to add items</div>
                    </div>
                </div>

                <div class="cart-summary" style="border-top: 2px solid var(--border-light); padding-top: 12px; margin-top: 12px;">
                    <div class="cart-summary-row"><span>Subtotal</span><span id="cart-subtotal">GHS 0.00</span></div>
                    <div class="cart-summary-row total"><span>Total</span><span id="cart-total">GHS 0.00</span></div>
                </div>

                <div class="payment-methods" style="margin-top: 12px;">
                    <div class="payment-method selected" data-method="cash" onclick="selectPayment(this)">
                        <div class="method-icon">💵</div>
                        <div class="method-name">Cash</div>
                    </div>
                    <div class="payment-method" data-method="momo" onclick="selectPayment(this)">
                        <div class="method-icon">📱</div>
                        <div class="method-name">Mobile Money</div>
                    </div>
                </div>

                <div class="form-group" style="margin-top: 12px; margin-bottom: 8px;">
                    <input type="text" id="customer-name" placeholder="Customer name (optional)" style="font-size: 14px; padding: 10px 14px;">
                </div>
                <div class="form-group" style="margin-bottom: 8px;">
                    <input type="text" id="sale-notes" placeholder="Notes (optional)" style="font-size: 14px; padding: 10px 14px;">
                </div>

                <div class="cart-actions" style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px;">
                    <button onclick="saveDraft()" class="btn btn-outline" style="padding: 12px; font-size: 14px;">Save Draft</button>
                    <button onclick="completeSale()" class="btn btn-success" style="padding: 12px; font-size: 14px;">✅ Complete Sale</button>
                </div>
            </div>
        </div>
    `;
}

async function initSalesPage() {
    // Load products and services
    const [productsResult, servicesResult] = await Promise.all([
        API.get('/products'),
        API.get('/services')
    ]);

    if (productsResult.success) products = productsResult.products;
    if (servicesResult.success) services = servicesResult.services;

    // Cache products for offline use
    if (products.length > 0) {
        await offlineDB.cacheProducts(products);
    }

    renderProductGrid(products, services);

    // Search functionality
    const searchInput = document.getElementById('product-search');
    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        const filteredProducts = products.filter(p => p.name.toLowerCase().includes(query) && p.is_active);
        const filteredServices = services.filter(s => s.name.toLowerCase().includes(query) && s.is_active);
        renderProductGrid(filteredProducts, filteredServices);
    });

    // Focus search on load
    searchInput.focus();
}

function renderProductGrid(productList, serviceList) {
    const container = document.getElementById('product-results');
    let html = '';

    // Products
    productList.forEach(p => {
        const inCart = cart.find(c => c.id === p.id && c.type === 'product');
        html += `
            <div class="product-card ${inCart ? 'selected' : ''}" onclick="addToCart('product', ${p.id}, '${escapeHtml(p.name)}', ${p.price}, '${p.unit}')">
                <div class="product-icon">🪵</div>
                <div class="product-name">${escapeHtml(p.name)}</div>
                <div class="product-price">${formatCurrency(p.price)}</div>
                <div class="product-stock ${p.stock < p.stock_threshold ? 'low' : ''}">
                    Stock: ${p.stock || 0} ${p.unit}
                </div>
                ${inCart ? `<div style="position: absolute; top: 8px; right: 8px; background: var(--primary); color: white; border-radius: 50%; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700;">${inCart.quantity}</div>` : ''}
            </div>
        `;
    });

    // Services
    serviceList.forEach(s => {
        const inCart = cart.find(c => c.id === s.id && c.type === 'service');
        html += `
            <div class="product-card ${inCart ? 'selected' : ''}" onclick="addToCart('service', ${s.id}, '${escapeHtml(s.name)}', ${s.price}, 'service')">
                <div class="product-icon">⚙️</div>
                <div class="product-name">${escapeHtml(s.name)}</div>
                <div class="product-price">${formatCurrency(s.price)}</div>
                <div class="product-stock">Service</div>
                ${inCart ? `<div style="position: absolute; top: 8px; right: 8px; background: var(--primary); color: white; border-radius: 50%; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700;">${inCart.quantity}</div>` : ''}
            </div>
        `;
    });

    if (html === '') {
        html = `
            <div style="grid-column: 1 / -1; text-align: center; padding: 32px; color: var(--text-light);">
                <div style="font-size: 32px; margin-bottom: 8px;">🔍</div>
                <div>No products or services found</div>
            </div>
        `;
    }

    container.innerHTML = html;
}

function addToCart(type, id, name, price, unit) {
    const existing = cart.find(c => c.id === id && c.type === type);

    if (existing) {
        existing.quantity += 1;
    } else {
        cart.push({ type, id, name, price, unit, quantity: 1 });
    }

    updateCartUI();
    renderProductGrid(products, services);
    showToast(`${name} added to cart`, 'success', 1500);
}

function updateCartItemQuantity(index, delta) {
    cart[index].quantity += delta;
    if (cart[index].quantity <= 0) {
        cart.splice(index, 1);
    }
    updateCartUI();
    renderProductGrid(products, services);
}

function removeCartItem(index) {
    cart.splice(index, 1);
    updateCartUI();
    renderProductGrid(products, services);
}

function clearCart() {
    cart = [];
    updateCartUI();
    renderProductGrid(products, services);
}

function updateCartUI() {
    const container = document.getElementById('cart-items');
    const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
    const subtotal = cart.reduce((sum, item) => sum + (item.quantity * item.price), 0);

    // Update header badge
    const countBadge = document.getElementById('cart-count-badge');
    const headerTotal = document.getElementById('cart-header-total');
    const cartBadge = document.getElementById('cart-badge');
    const cartBadgeCount = document.getElementById('cart-badge-count');

    if (countBadge) countBadge.textContent = totalItems;
    if (headerTotal) headerTotal.textContent = formatCurrency(subtotal);
    if (cartBadge) cartBadge.style.display = totalItems > 0 ? 'inline-block' : 'none';
    if (cartBadgeCount) cartBadgeCount.textContent = totalItems;

    if (cart.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="padding: 16px;">
                <div class="empty-icon" style="font-size: 28px;">🛒</div>
                <div class="empty-text" style="font-size: 13px;">Tap products above to add items</div>
            </div>
        `;
    } else {
        container.innerHTML = cart.map((item, index) => `
            <div class="cart-item">
                <div class="cart-item-info">
                    <div class="cart-item-name">${escapeHtml(item.name)}</div>
                    <div class="cart-item-price">${formatCurrency(item.price)} / ${item.unit}</div>
                    <div class="qty-presets">
                        ${[0.5, 1, 2, 5, 10].map(q => `<button class="qty-preset" onclick="setCartQty(${index}, ${q})">${q}</button>`).join('')}
                    </div>
                </div>
                <div class="cart-item-qty">
                    <button onclick="updateCartItemQuantity(${index}, -1)">−</button>
                    <span class="qty-value">${item.quantity}</span>
                    <button onclick="updateCartItemQuantity(${index}, 1)">+</button>
                </div>
                <div class="cart-item-total">${formatCurrency(item.quantity * item.price)}</div>
                <button class="cart-item-remove" onclick="removeCartItem(${index})">🗑️</button>
            </div>
        `).join('');
    }

    document.getElementById('cart-subtotal').textContent = formatCurrency(subtotal);
    document.getElementById('cart-total').textContent = formatCurrency(subtotal);
}

function toggleCart() {
    const body = document.getElementById('cart-body');
    const icon = document.getElementById('cart-toggle-icon');
    if (body.style.display === 'none') {
        body.style.display = 'block';
        icon.style.transform = 'rotate(0deg)';
    } else {
        body.style.display = 'none';
        icon.style.transform = 'rotate(-90deg)';
    }
}

function setCartQty(index, qty) {
    cart[index].quantity = qty;
    updateCartUI();
}

function selectPayment(el) {
    document.querySelectorAll('.payment-method').forEach(m => m.classList.remove('selected'));
    el.classList.add('selected');
}

async function completeSale() {
    if (cart.length === 0) {
        showToast('Cart is empty!', 'error');
        return;
    }

    const paymentMethod = document.querySelector('.payment-method.selected')?.dataset.method || 'cash';
    const customerName = document.getElementById('customer-name').value;
    const notes = document.getElementById('sale-notes').value;

    const items = cart.map(item => ({
        product_id: item.type === 'product' ? item.id : null,
        service_id: item.type === 'service' ? item.id : null,
        item_type: item.type,
        name: item.name,
        quantity: item.quantity,
        unit_price: item.price
    }));

    const saleData = {
        items,
        payment_method: paymentMethod,
        customer_name: customerName || null,
        notes: notes || null
    };

    showLoading(true);

    if (!isOnline) {
        // Queue for offline sync
        await offlineDB.addToQueue({ data: saleData });
        showLoading(false);
        showToast('Sale queued for sync (offline)', 'warning');
        clearCart();
        document.getElementById('customer-name').value = '';
        document.getElementById('sale-notes').value = '';
        return;
    }

    const result = await API.post('/sales', saleData);
    showLoading(false);

    if (result.success) {
        showToast('Sale completed! Invoice: ' + result.invoice_number, 'success');
        showInvoice(result.invoice_number, result.sale_id);
        clearCart();
        document.getElementById('customer-name').value = '';
        document.getElementById('sale-notes').value = '';
    } else {
        showToast(result.error || 'Failed to complete sale', 'error');
    }
}

async function saveDraft() {
    if (cart.length === 0) {
        showToast('Cart is empty!', 'error');
        return;
    }

    const customerName = document.getElementById('customer-name').value;
    const notes = document.getElementById('sale-notes').value;

    const items = cart.map(item => ({
        product_id: item.type === 'product' ? item.id : null,
        service_id: item.type === 'service' ? item.id : null,
        item_type: item.type,
        name: item.name,
        quantity: item.quantity,
        unit_price: item.price
    }));

    const result = await API.post('/drafts', {
        items,
        customer_name: customerName || null,
        notes: notes || null
    });

    if (result.success) {
        showToast('Draft saved!', 'success');
        clearCart();
    } else {
        showToast(result.error || 'Failed to save draft', 'error');
    }
}

function showInvoice(invoiceNumber, saleId) {
    // Fetch sale details and show modal
    API.get(`/sales/${saleId}`).then(result => {
        if (!result.success) return;
        const sale = result.sale;

        const modalContent = `
            <div class="invoice-container">
                <div class="invoice-header">
                    <div class="invoice-logo">🌲</div>
                    <div class="invoice-title">TIMBERPRO</div>
                    <div class="invoice-number">${sale.invoice_number}</div>
                </div>
                <div class="invoice-details">
                    <div class="invoice-detail"><span>Date</span><span>${formatDateTime(sale.created_at)}</span></div>
                    <div class="invoice-detail"><span>Branch</span><span>${escapeHtml(sale.branch_name || 'Main')}</span></div>
                    <div class="invoice-detail"><span>Cashier</span><span>${escapeHtml(sale.user_name || 'Staff')}</span></div>
                    <div class="invoice-detail"><span>Customer</span><span>${escapeHtml(sale.customer_name || 'Walk-in')}</span></div>
                    <div class="invoice-detail"><span>Payment</span><span>${sale.payment_method.toUpperCase()}</span></div>
                </div>
                <div class="invoice-items">
                    ${sale.items.map(item => `
                        <div class="invoice-item">
                            <span>${escapeHtml(item.name)} x ${item.quantity}</span>
                            <span>${formatCurrency(item.total_price)}</span>
                        </div>
                    `).join('')}
                    <div class="invoice-total">
                        <span>TOTAL</span>
                        <span>${formatCurrency(sale.total_amount)}</span>
                    </div>
                </div>
                <div class="invoice-footer">
                    <p>Thank you for your business!</p>
                    <p>TimberPro Management System</p>
                </div>
                <div style="display: flex; gap: 12px; margin-top: 20px;">
                    <button onclick="window.print()" class="btn btn-primary btn-full">🖨️ Print</button>
                    <button onclick="closeModal()" class="btn btn-outline btn-full">Close</button>
                </div>
            </div>
        `;

        openModal(modalContent, true);
    });
}

// ==================== DRAFTS ====================
function renderDrafts() {
    return `
        <div class="page-header">
            <div>
                <h1 class="page-title">Draft Sales</h1>
                <p class="page-subtitle">Resume or delete saved drafts</p>
            </div>
        </div>
        <div id="drafts-list">
            <div class="empty-state"><div class="empty-icon">📝</div><div class="empty-text">Loading drafts...</div></div>
        </div>
    `;
}

async function initDraftsPage() {
    const result = await API.get('/drafts');
    const container = document.getElementById('drafts-list');

    if (!result.success || !result.drafts || result.drafts.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📝</div>
                <div class="empty-title">No Drafts</div>
                <div class="empty-text">Save a draft from the sales page to see it here.</div>
            </div>
        `;
        return;
    }

    container.innerHTML = `
        <div class="grid-2">
            ${result.drafts.map(draft => `
                <div class="card" style="cursor: pointer;" onclick="loadDraft(${draft.id})">
                    <div style="display: flex; justify-content: space-between; align-items: start;">
                        <div>
                            <div style="font-weight: 600; font-size: 14px;">${draft.draft_number}</div>
                            <div style="font-size: 12px; color: var(--text-light); margin-top: 4px;">${formatDateTime(draft.created_at)}</div>
                            <div style="font-size: 12px; color: var(--text-light);">${draft.customer_name || 'No customer'}</div>
                        </div>
                        <div style="font-weight: 700; font-size: 18px; color: var(--primary);">${formatCurrency(draft.total_amount)}</div>
                    </div>
                    <div style="margin-top: 12px; font-size: 12px; color: var(--text-light);">
                        ${JSON.parse(draft.items || '[]').length} items
                    </div>
                    <div style="display: flex; gap: 8px; margin-top: 12px;">
                        <button onclick="event.stopPropagation(); loadDraft(${draft.id})" class="btn btn-primary btn-small">Resume</button>
                        <button onclick="event.stopPropagation(); deleteDraft(${draft.id})" class="btn btn-danger btn-small">Delete</button>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

async function loadDraft(draftId) {
    const result = await API.get('/drafts'); // In real app, fetch specific draft
    if (!result.success) return;
    const draft = result.drafts.find(d => d.id === draftId);
    if (!draft) return;

    cart = JSON.parse(draft.items || '[]').map(item => ({
        type: item.item_type,
        id: item.product_id || item.service_id,
        name: item.name,
        price: item.unit_price,
        unit: item.item_type === 'product' ? 'piece' : 'service',
        quantity: item.quantity
    }));

    await API.delete(`/drafts/${draftId}`);
    loadPage('sales');
    showToast('Draft loaded. Complete the sale!', 'info');
}

async function deleteDraft(draftId) {
    if (!confirm('Delete this draft?')) return;
    const result = await API.delete(`/drafts/${draftId}`);
    if (result.success) {
        showToast('Draft deleted', 'success');
        initDraftsPage();
    }
}

// ==================== SALES HISTORY ====================
function renderSalesHistory() {
    return `
        <div class="page-header">
            <div>
                <h1 class="page-title">Sales History</h1>
                <p class="page-subtitle">View and manage all sales</p>
            </div>
        </div>
        <div class="filter-bar">
            <input type="date" id="filter-date-from" class="form-control">
            <input type="date" id="filter-date-to" class="form-control">
            <button onclick="filterSales()" class="btn btn-primary btn-small">Filter</button>
        </div>
        <div id="sales-list">
            <div class="empty-state"><div class="empty-icon">💰</div><div class="empty-text">Loading sales...</div></div>
        </div>
    `;
}

async function initSalesHistoryPage() {
    await loadSalesList();
}

async function loadSalesList() {
    const result = await API.get('/sales?limit=50');
    const container = document.getElementById('sales-list');

    if (!result.success || !result.sales || result.sales.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">💰</div>
                <div class="empty-title">No Sales</div>
                <div class="empty-text">Complete a sale to see it here.</div>
            </div>
        `;
        return;
    }

    container.innerHTML = `
        <div class="table-container table-responsive">
            <table class="table">
                <thead>
                    <tr>
                        <th>Invoice</th>
                        <th>Date</th>
                        <th>Customer</th>
                        <th>Amount</th>
                        <th>Payment</th>
                        <th>Status</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${result.sales.map(sale => `
                        <tr>
                            <td data-label="Invoice">${sale.invoice_number}</td>
                            <td data-label="Date">${formatDateTime(sale.created_at)}</td>
                            <td data-label="Customer">${escapeHtml(sale.customer_name || 'Walk-in')}</td>
                            <td data-label="Amount">${formatCurrency(sale.total_amount)}</td>
                            <td data-label="Payment">${sale.payment_method.toUpperCase()}</td>
                            <td data-label="Status"><span class="status-badge ${sale.status}">${sale.status}</span></td>
                            <td data-label="Actions" class="actions">
                                <button onclick="viewInvoice(${sale.id})" class="btn btn-primary btn-small">View</button>
                                ${sale.status === 'completed' ? `<button onclick="cancelSale(${sale.id})" class="btn btn-danger btn-small">Cancel</button>` : ''}
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
}

async function viewInvoice(saleId) {
    showInvoice(null, saleId);
}

async function cancelSale(saleId) {
    if (!confirm('Cancel this sale? Stock will be restored.')) return;
    const result = await API.put(`/sales/${saleId}/cancel`, {});
    if (result.success) {
        showToast('Sale cancelled', 'success');
        loadSalesList();
    } else {
        showToast(result.error || 'Failed to cancel', 'error');
    }
}

function filterSales() {
    // Implementation for date filtering
    loadSalesList();
}

// ==================== INVENTORY ====================
function renderInventory() {
    return `
        <div class="page-header">
            <div>
                <h1 class="page-title">Inventory</h1>
                <p class="page-subtitle">Stock levels and management</p>
            </div>
            <button onclick="showReceiveInventory()" class="btn btn-primary">+ Receive Stock</button>
        </div>
        <div class="search-box">
            <span class="search-icon">🔍</span>
            <input type="text" id="inventory-search" placeholder="Search inventory..." oninput="filterInventory()">
        </div>
        <div id="inventory-list">
            <div class="empty-state"><div class="empty-icon">📦</div><div class="empty-text">Loading inventory...</div></div>
        </div>
    `;
}

async function initInventoryPage() {
    await loadInventory();
}

async function loadInventory() {
    const result = await API.get('/inventory');
    const container = document.getElementById('inventory-list');

    if (!result.success || !result.inventory || result.inventory.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📦</div>
                <div class="empty-title">No Inventory</div>
                <div class="empty-text">Receive stock to see items here.</div>
            </div>
        `;
        return;
    }

    container.innerHTML = `
        <div class="table-container table-responsive">
            <table class="table" id="inventory-table">
                <thead>
                    <tr>
                        <th>Product</th>
                        <th>Branch</th>
                        <th>Stock</th>
                        <th>Reserved</th>
                        <th>Available</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
                    ${result.inventory.map(item => {
                        const available = item.quantity - item.reserved_quantity;
                        const isLow = available <= item.stock_threshold;
                        return `
                            <tr>
                                <td data-label="Product">${escapeHtml(item.product_name)}</td>
                                <td data-label="Branch">${escapeHtml(item.branch_name || 'Main')}</td>
                                <td data-label="Stock">${item.quantity} ${item.unit}</td>
                                <td data-label="Reserved">${item.reserved_quantity} ${item.unit}</td>
                                <td data-label="Available">${available} ${item.unit}</td>
                                <td data-label="Status">
                                    <span class="status-badge ${isLow ? 'cancelled' : 'completed'}">${isLow ? 'LOW' : 'OK'}</span>
                                </td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        </div>
    `;
}

function filterInventory() {
    const query = document.getElementById('inventory-search').value.toLowerCase();
    const rows = document.querySelectorAll('#inventory-table tbody tr');
    rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(query) ? '' : 'none';
    });
}

function showReceiveInventory() {
    const modalContent = `
        <div class="modal-header">
            <div class="modal-title">Receive Inventory</div>
            <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <form id="receive-form" onsubmit="submitReceiveInventory(event)">
            <div class="form-group">
                <label>Product</label>
                <select id="receive-product" required>
                    <option value="">Select product...</option>
                    ${products.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}
                </select>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Quantity</label>
                    <input type="number" id="receive-quantity" step="0.01" min="0.01" required placeholder="e.g. 50.5">
                </div>
                <div class="form-group">
                    <label>Cost Price (optional)</label>
                    <input type="number" id="receive-cost" step="0.01" min="0" placeholder="0.00">
                </div>
            </div>
            <div class="form-group">
                <label>Supplier (optional)</label>
                <input type="text" id="receive-supplier" placeholder="Supplier name">
            </div>
            <div class="form-group">
                <label>Notes</label>
                <textarea id="receive-notes" placeholder="Any notes..."></textarea>
            </div>
            <div class="form-actions">
                <button type="button" onclick="closeModal()" class="btn btn-outline">Cancel</button>
                <button type="submit" class="btn btn-success">Receive Stock</button>
            </div>
        </form>
    `;
    openModal(modalContent, true);
}

async function submitReceiveInventory(e) {
    e.preventDefault();
    const data = {
        product_id: parseInt(document.getElementById('receive-product').value),
        quantity: parseFloat(document.getElementById('receive-quantity').value),
        cost_price: parseFloat(document.getElementById('receive-cost').value) || 0,
        supplier: document.getElementById('receive-supplier').value || null,
        notes: document.getElementById('receive-notes').value || null
    };

    showLoading(true);
    const result = await API.post('/inventory/receive', data);
    showLoading(false);

    if (result.success) {
        showToast('Stock received successfully!', 'success');
        closeModal();
        loadInventory();
    } else {
        showToast(result.error || 'Failed to receive stock', 'error');
    }
}

// ==================== PRODUCTS ====================
function renderProducts() {
    return `
        <div class="page-header">
            <div>
                <h1 class="page-title">Products</h1>
                <p class="page-subtitle">Manage timber products</p>
            </div>
            <button onclick="showProductForm()" class="btn btn-primary">+ Add Product</button>
        </div>
        <div class="search-box">
            <span class="search-icon">🔍</span>
            <input type="text" id="product-search-admin" placeholder="Search products..." oninput="filterProducts()">
        </div>
        <div id="products-list">
            <div class="empty-state"><div class="empty-icon">🪵</div><div class="empty-text">Loading products...</div></div>
        </div>
    `;
}

async function initProductsPage() {
    await loadProducts();
}

async function loadProducts() {
    const result = await API.get('/products');
    const container = document.getElementById('products-list');

    if (!result.success || !result.products) {
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">🪵</div><div class="empty-title">No products found</div></div>`;
        return;
    }

    products = result.products; // Update global products

    container.innerHTML = `
        <div class="grid-2" id="products-grid">
            ${result.products.map(p => `
                <div class="card" style="opacity: ${p.is_active ? 1 : 0.6};">
                    <div style="display: flex; justify-content: space-between; align-items: start;">
                        <div>
                            <div style="font-weight: 700; font-size: 16px;">${escapeHtml(p.name)}</div>
                            <div style="font-size: 12px; color: var(--text-light); margin-top: 4px;">${escapeHtml(p.description || '')}</div>
                        </div>
                        <span class="status-badge ${p.is_active ? 'completed' : 'cancelled'}">${p.is_active ? 'Active' : 'Inactive'}</span>
                    </div>
                    <div style="display: flex; gap: 16px; margin-top: 12px; font-size: 14px;">
                        <div><strong>Price:</strong> ${formatCurrency(p.price)}</div>
                        <div><strong>Cost:</strong> ${formatCurrency(p.cost_price)}</div>
                        <div><strong>Threshold:</strong> ${p.stock_threshold}</div>
                    </div>
                    <div style="display: flex; gap: 8px; margin-top: 16px;">
                        <button onclick="editProduct(${p.id})" class="btn btn-primary btn-small">Edit</button>
                        <button onclick="toggleProduct(${p.id}, ${!p.is_active})" class="btn btn-outline btn-small">${p.is_active ? 'Disable' : 'Enable'}</button>
                        <button onclick="deleteProduct(${p.id})" class="btn btn-danger btn-small">Delete</button>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

function filterProducts() {
    const query = document.getElementById('product-search-admin').value.toLowerCase();
    const cards = document.querySelectorAll('#products-grid .card');
    cards.forEach(card => {
        const text = card.textContent.toLowerCase();
        card.style.display = text.includes(query) ? '' : 'none';
    });
}

function showProductForm(product = null) {
    const isEdit = !!product;
    const modalContent = `
        <div class="modal-header">
            <div class="modal-title">${isEdit ? 'Edit' : 'Add'} Product</div>
            <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <form id="product-form" onsubmit="submitProduct(event, ${isEdit ? product.id : 'null'})">
            <div class="form-group">
                <label>Product Name *</label>
                <input type="text" id="prod-name" value="${isEdit ? escapeHtml(product.name) : ''}" required placeholder="e.g. Afram Board">
            </div>
            <div class="form-group">
                <label>Description</label>
                <input type="text" id="prod-desc" value="${isEdit ? escapeHtml(product.description || '') : ''}" placeholder="Short description">
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Unit</label>
                    <select id="prod-unit">
                        <option value="piece" ${isEdit && product.unit === 'piece' ? 'selected' : ''}>Piece</option>
                        <option value="board" ${isEdit && product.unit === 'board' ? 'selected' : ''}>Board</option>
                        <option value="meter" ${isEdit && product.unit === 'meter' ? 'selected' : ''}>Meter</option>
                        <option value="ft" ${isEdit && product.unit === 'ft' ? 'selected' : ''}>Feet</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Category</label>
                    <input type="text" id="prod-category" value="${isEdit ? escapeHtml(product.category || 'timber') : 'timber'}" placeholder="timber">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Selling Price *</label>
                    <input type="number" id="prod-price" step="0.01" min="0" value="${isEdit ? product.price : ''}" required placeholder="0.00">
                </div>
                <div class="form-group">
                    <label>Cost Price</label>
                    <input type="number" id="prod-cost" step="0.01" min="0" value="${isEdit ? product.cost_price || '' : ''}" placeholder="0.00">
                </div>
            </div>
            <div class="form-group">
                <label>Stock Alert Threshold</label>
                <input type="number" id="prod-threshold" step="0.01" min="0" value="${isEdit ? product.stock_threshold : '10'}" placeholder="10">
            </div>
            <div class="form-actions">
                <button type="button" onclick="closeModal()" class="btn btn-outline">Cancel</button>
                <button type="submit" class="btn btn-success">${isEdit ? 'Update' : 'Create'} Product</button>
            </div>
        </form>
    `;
    openModal(modalContent, true);
}

async function submitProduct(e, productId) {
    e.preventDefault();
    const data = {
        name: document.getElementById('prod-name').value,
        description: document.getElementById('prod-desc').value,
        unit: document.getElementById('prod-unit').value,
        category: document.getElementById('prod-category').value,
        price: parseFloat(document.getElementById('prod-price').value),
        cost_price: parseFloat(document.getElementById('prod-cost').value) || 0,
        stock_threshold: parseFloat(document.getElementById('prod-threshold').value) || 10,
        is_active: 1
    };

    showLoading(true);
    const result = productId 
        ? await API.put(`/products/${productId}`, data)
        : await API.post('/products', data);
    showLoading(false);

    if (result.success) {
        showToast(`Product ${productId ? 'updated' : 'created'}!`, 'success');
        closeModal();
        loadProducts();
    } else {
        showToast(result.error || 'Failed to save product', 'error');
    }
}

async function editProduct(id) {
    const result = await API.get(`/products/${id}`);
    if (result.success && result.product) {
        showProductForm(result.product);
    }
}

async function toggleProduct(id, active) {
    const result = await API.put(`/products/${id}`, { is_active: active ? 1 : 0 });
    if (result.success) {
        showToast(`Product ${active ? 'enabled' : 'disabled'}`, 'success');
        loadProducts();
    }
}

async function deleteProduct(id) {
    if (!confirm('Delete this product? It will be hidden from sales but kept in records.')) return;
    const result = await API.delete(`/products/${id}`);
    if (result.success) {
        showToast('Product deleted (soft delete)', 'success');
        loadProducts();
    }
}

// ==================== SERVICES ====================
function renderServices() {
    return `
        <div class="page-header">
            <div>
                <h1 class="page-title">Services</h1>
                <p class="page-subtitle">Machine work and services</p>
            </div>
            <button onclick="showServiceForm()" class="btn btn-primary">+ Add Service</button>
        </div>
        <div id="services-list">
            <div class="empty-state"><div class="empty-icon">⚙️</div><div class="empty-text">Loading services...</div></div>
        </div>
    `;
}

async function initServicesPage() {
    await loadServices();
}

async function loadServices() {
    const result = await API.get('/services');
    const container = document.getElementById('services-list');

    if (!result.success || !result.services) {
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚙️</div><div class="empty-title">No services</div></div>`;
        return;
    }

    services = result.services;

    container.innerHTML = `
        <div class="grid-2">
            ${result.services.map(s => `
                <div class="card" style="opacity: ${s.is_active ? 1 : 0.6};">
                    <div style="display: flex; justify-content: space-between; align-items: start;">
                        <div>
                            <div style="font-weight: 700; font-size: 16px;">${escapeHtml(s.name)}</div>
                            <div style="font-size: 12px; color: var(--text-light); margin-top: 4px;">${escapeHtml(s.description || '')}</div>
                        </div>
                        <span class="status-badge ${s.is_active ? 'completed' : 'cancelled'}">${s.is_active ? 'Active' : 'Inactive'}</span>
                    </div>
                    <div style="margin-top: 12px; font-size: 18px; font-weight: 700; color: var(--primary);">
                        ${formatCurrency(s.price)}
                    </div>
                    <div style="display: flex; gap: 8px; margin-top: 16px;">
                        <button onclick="editService(${s.id})" class="btn btn-primary btn-small">Edit</button>
                        <button onclick="toggleService(${s.id}, ${!s.is_active})" class="btn btn-outline btn-small">${s.is_active ? 'Disable' : 'Enable'}</button>
                        <button onclick="deleteService(${s.id})" class="btn btn-danger btn-small">Delete</button>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

function showServiceForm(service = null) {
    const isEdit = !!service;
    const modalContent = `
        <div class="modal-header">
            <div class="modal-title">${isEdit ? 'Edit' : 'Add'} Service</div>
            <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <form id="service-form" onsubmit="submitService(event, ${isEdit ? service.id : 'null'})">
            <div class="form-group">
                <label>Service Name *</label>
                <input type="text" id="svc-name" value="${isEdit ? escapeHtml(service.name) : ''}" required placeholder="e.g. Machine Cutting">
            </div>
            <div class="form-group">
                <label>Description</label>
                <input type="text" id="svc-desc" value="${isEdit ? escapeHtml(service.description || '') : ''}" placeholder="Service description">
            </div>
            <div class="form-group">
                <label>Price *</label>
                <input type="number" id="svc-price" step="0.01" min="0" value="${isEdit ? service.price : ''}" required placeholder="0.00">
            </div>
            <div class="form-actions">
                <button type="button" onclick="closeModal()" class="btn btn-outline">Cancel</button>
                <button type="submit" class="btn btn-success">${isEdit ? 'Update' : 'Create'} Service</button>
            </div>
        </form>
    `;
    openModal(modalContent, true);
}

async function submitService(e, serviceId) {
    e.preventDefault();
    const data = {
        name: document.getElementById('svc-name').value,
        description: document.getElementById('svc-desc').value,
        price: parseFloat(document.getElementById('svc-price').value),
        is_active: 1
    };

    showLoading(true);
    const result = serviceId
        ? await API.put(`/services/${serviceId}`, data)
        : await API.post('/services', data);
    showLoading(false);

    if (result.success) {
        showToast(`Service ${serviceId ? 'updated' : 'created'}!`, 'success');
        closeModal();
        loadServices();
    } else {
        showToast(result.error || 'Failed to save service', 'error');
    }
}

async function editService(id) {
    const result = await API.get(`/services/${id}`);
    if (result.success && result.service) {
        showServiceForm(result.service);
    }
}

async function toggleService(id, active) {
    const result = await API.put(`/services/${id}`, { is_active: active ? 1 : 0 });
    if (result.success) {
        showToast(`Service ${active ? 'enabled' : 'disabled'}`, 'success');
        loadServices();
    }
}

async function deleteService(id) {
    if (!confirm('Delete this service?')) return;
    const result = await API.delete(`/services/${id}`);
    if (result.success) {
        showToast('Service deleted', 'success');
        loadServices();
    }
}

// ==================== ORDERS ====================
function renderOrders() {
    return `
        <div class="page-header">
            <div>
                <h1 class="page-title">Orders</h1>
                <p class="page-subtitle">Pay now, deliver later</p>
            </div>
            <button onclick="showCreateOrder()" class="btn btn-primary">+ New Order</button>
        </div>
        <div class="tabs">
            <button class="tab active" onclick="filterOrders('all')">All</button>
            <button class="tab" onclick="filterOrders('pending')">Pending</button>
            <button class="tab" onclick="filterOrders('paid')">Paid</button>
            <button class="tab" onclick="filterOrders('ready')">Ready</button>
            <button class="tab" onclick="filterOrders('delivered')">Delivered</button>
        </div>
        <div id="orders-list">
            <div class="empty-state"><div class="empty-icon">📦</div><div class="empty-text">Loading orders...</div></div>
        </div>
    `;
}

async function initOrdersPage() {
    await loadOrders();
}

async function loadOrders(status = null) {
    const url = status && status !== 'all' ? `/orders?status=${status}` : '/orders';
    const result = await API.get(url);
    const container = document.getElementById('orders-list');

    if (!result.success || !result.orders || result.orders.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📦</div>
                <div class="empty-title">No Orders</div>
                <div class="empty-text">Create an order to see it here.</div>
            </div>
        `;
        return;
    }

    container.innerHTML = `
        <div class="grid-2">
            ${result.orders.map(o => `
                <div class="card">
                    <div style="display: flex; justify-content: space-between; align-items: start;">
                        <div>
                            <div style="font-weight: 700; font-size: 14px;">${o.order_number}</div>
                            <div style="font-size: 12px; color: var(--text-light); margin-top: 4px;">${formatDateTime(o.created_at)}</div>
                        </div>
                        <span class="status-badge ${o.status}">${o.status.toUpperCase()}</span>
                    </div>
                    <div style="margin-top: 12px;">
                        <div style="font-size: 14px;"><strong>Customer:</strong> ${escapeHtml(o.customer_name || 'N/A')}</div>
                        <div style="font-size: 14px;"><strong>Amount:</strong> ${formatCurrency(o.total_amount)}</div>
                        <div style="font-size: 12px; color: var(--text-light); margin-top: 4px;">
                            ${o.items ? o.items.length : 0} items | ${o.payment_method.toUpperCase()}
                        </div>
                    </div>
                    <div style="display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap;">
                        ${o.status === 'pending' ? `<button onclick="updateOrderStatus(${o.id}, 'paid')" class="btn btn-success btn-small">Mark Paid</button>` : ''}
                        ${o.status === 'paid' ? `<button onclick="updateOrderStatus(${o.id}, 'ready')" class="btn btn-primary btn-small">Mark Ready</button>` : ''}
                        ${o.status === 'ready' ? `<button onclick="updateOrderStatus(${o.id}, 'delivered')" class="btn btn-success btn-small">Deliver</button>` : ''}
                        ${o.status !== 'cancelled' && o.status !== 'delivered' ? `<button onclick="updateOrderStatus(${o.id}, 'cancelled')" class="btn btn-danger btn-small">Cancel</button>` : ''}
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

function filterOrders(status) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    event.target.classList.add('active');
    loadOrders(status);
}

async function updateOrderStatus(id, status) {
    const result = await API.put(`/orders/${id}/status`, { status });
    if (result.success) {
        showToast(`Order marked as ${status}`, 'success');
        loadOrders();
    } else {
        showToast(result.error || 'Failed to update order', 'error');
    }
}

function showCreateOrder() {
    // Reuse sales cart for order creation
    cart = [];
    const modalContent = `
        <div class="modal-header">
            <div class="modal-title">New Order</div>
            <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <div id="order-products" style="max-height: 300px; overflow-y: auto; margin-bottom: 16px;">
            ${products.filter(p => p.is_active).map(p => `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border-light);">
                    <div>
                        <div style="font-weight: 600;">${escapeHtml(p.name)}</div>
                        <div style="font-size: 12px; color: var(--text-light);">${formatCurrency(p.price)}</div>
                    </div>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <button onclick="addOrderItem(${p.id}, '${escapeHtml(p.name)}', ${p.price}, -1)" style="width: 28px; height: 28px; border-radius: 50%; border: 1px solid var(--border); background: white; cursor: pointer;">−</button>
                        <span id="order-qty-${p.id}" style="min-width: 30px; text-align: center; font-weight: 700;">0</span>
                        <button onclick="addOrderItem(${p.id}, '${escapeHtml(p.name)}', ${p.price}, 1)" style="width: 28px; height: 28px; border-radius: 50%; border: 1px solid var(--border); background: white; cursor: pointer;">+</button>
                    </div>
                </div>
            `).join('')}
        </div>
        <div class="form-group">
            <label>Customer Name</label>
            <input type="text" id="order-customer" placeholder="Customer name">
        </div>
        <div class="form-group">
            <label>Expected Delivery Date</label>
            <input type="date" id="order-delivery-date">
        </div>
        <div class="form-group">
            <label>Payment Method</label>
            <select id="order-payment">
                <option value="cash">Cash</option>
                <option value="momo">Mobile Money</option>
            </select>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; margin: 16px 0; font-size: 18px; font-weight: 700;">
            <span>Total:</span>
            <span id="order-total">GHS 0.00</span>
        </div>
        <div class="form-actions">
            <button type="button" onclick="closeModal()" class="btn btn-outline">Cancel</button>
            <button onclick="submitOrder()" class="btn btn-success">Create Order</button>
        </div>
    `;
    openModal(modalContent, true);
}

let orderItems = {};

function addOrderItem(productId, name, price, delta) {
    if (!orderItems[productId]) orderItems[productId] = { product_id: productId, name, price, quantity: 0 };
    orderItems[productId].quantity += delta;
    if (orderItems[productId].quantity < 0) orderItems[productId].quantity = 0;

    const qtyEl = document.getElementById(`order-qty-${productId}`);
    if (qtyEl) qtyEl.textContent = orderItems[productId].quantity;

    updateOrderTotal();
}

function updateOrderTotal() {
    const total = Object.values(orderItems).reduce((sum, item) => sum + (item.quantity * item.price), 0);
    const totalEl = document.getElementById('order-total');
    if (totalEl) totalEl.textContent = formatCurrency(total);
}

async function submitOrder() {
    const items = Object.values(orderItems).filter(i => i.quantity > 0);
    if (items.length === 0) {
        showToast('Add items to the order', 'error');
        return;
    }

    const data = {
        items: items.map(i => ({
            product_id: i.product_id,
            name: i.name,
            quantity: i.quantity,
            unit_price: i.price
        })),
        customer_name: document.getElementById('order-customer').value || null,
        expected_delivery_date: document.getElementById('order-delivery-date').value || null,
        payment_method: document.getElementById('order-payment').value
    };

    showLoading(true);
    const result = await API.post('/orders', data);
    showLoading(false);

    if (result.success) {
        showToast('Order created!', 'success');
        orderItems = {};
        closeModal();
        loadOrders();
    } else {
        showToast(result.error || 'Failed to create order', 'error');
    }
}

// ==================== EXPENSES ====================
function renderExpenses() {
    return `
        <div class="page-header">
            <div>
                <h1 class="page-title">Expenses</h1>
                <p class="page-subtitle">Track business expenses</p>
            </div>
            <button onclick="showExpenseForm()" class="btn btn-primary">+ Add Expense</button>
        </div>
        <div id="expenses-list">
            <div class="empty-state"><div class="empty-icon">💸</div><div class="empty-text">Loading expenses...</div></div>
        </div>
    `;
}

async function initExpensesPage() {
    await loadExpenses();
}

async function loadExpenses() {
    const result = await API.get('/expenses');
    const container = document.getElementById('expenses-list');

    if (!result.success || !result.expenses || result.expenses.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">💸</div>
                <div class="empty-title">No Expenses</div>
                <div class="empty-text">Add an expense to track spending.</div>
            </div>
        `;
        return;
    }

    const categories = { fuel: '⛽', rent: '🏠', salaries: '💵', repairs: '🔧', miscellaneous: '📋' };

    container.innerHTML = `
        <div class="grid-2">
            ${result.expenses.map(e => `
                <div class="card">
                    <div style="display: flex; justify-content: space-between; align-items: start;">
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <div style="font-size: 28px;">${categories[e.category] || '📋'}</div>
                            <div>
                                <div style="font-weight: 700; font-size: 14px; text-transform: capitalize;">${e.category}</div>
                                <div style="font-size: 12px; color: var(--text-light);">${formatDate(e.date)}</div>
                            </div>
                        </div>
                        <div style="font-weight: 700; font-size: 18px; color: var(--danger);">${formatCurrency(e.amount)}</div>
                    </div>
                    <div style="margin-top: 8px; font-size: 13px; color: var(--text-light);">${escapeHtml(e.description || '')}</div>
                    <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">${escapeHtml(e.branch_name || 'Main')} | ${escapeHtml(e.created_by_name || 'Staff')}</div>
                </div>
            `).join('')}
        </div>
    `;
}

function showExpenseForm() {
    const modalContent = `
        <div class="modal-header">
            <div class="modal-title">Add Expense</div>
            <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <form id="expense-form" onsubmit="submitExpense(event)">
            <div class="form-group">
                <label>Category *</label>
                <select id="exp-category" required>
                    <option value="">Select category...</option>
                    <option value="fuel">⛽ Fuel</option>
                    <option value="rent">🏠 Rent</option>
                    <option value="salaries">💵 Salaries</option>
                    <option value="repairs">🔧 Repairs</option>
                    <option value="miscellaneous">📋 Miscellaneous</option>
                </select>
            </div>
            <div class="form-group">
                <label>Amount *</label>
                <input type="number" id="exp-amount" step="0.01" min="0.01" required placeholder="0.00">
            </div>
            <div class="form-group">
                <label>Date</label>
                <input type="date" id="exp-date" value="${new Date().toISOString().split('T')[0]}">
            </div>
            <div class="form-group">
                <label>Description</label>
                <textarea id="exp-desc" placeholder="Details about this expense..."></textarea>
            </div>
            <div class="form-group">
                <label>Receipt Number</label>
                <input type="text" id="exp-receipt" placeholder="Receipt # (optional)">
            </div>
            <div class="form-actions">
                <button type="button" onclick="closeModal()" class="btn btn-outline">Cancel</button>
                <button type="submit" class="btn btn-success">Save Expense</button>
            </div>
        </form>
    `;
    openModal(modalContent, true);
}

async function submitExpense(e) {
    e.preventDefault();
    const data = {
        category: document.getElementById('exp-category').value,
        amount: parseFloat(document.getElementById('exp-amount').value),
        date: document.getElementById('exp-date').value,
        description: document.getElementById('exp-desc').value || null,
        receipt_number: document.getElementById('exp-receipt').value || null
    };

    showLoading(true);
    const result = await API.post('/expenses', data);
    showLoading(false);

    if (result.success) {
        showToast('Expense added!', 'success');
        closeModal();
        loadExpenses();
    } else {
        showToast(result.error || 'Failed to add expense', 'error');
    }
}

// ==================== EMPLOYEES ====================
function renderEmployees() {
    return `
        <div class="page-header">
            <div>
                <h1 class="page-title">Employees</h1>
                <p class="page-subtitle">Staff management</p>
            </div>
            <button onclick="showEmployeeForm()" class="btn btn-primary">+ Add Employee</button>
        </div>
        <div id="employees-list">
            <div class="empty-state"><div class="empty-icon">👥</div><div class="empty-text">Loading employees...</div></div>
        </div>
    `;
}

async function initEmployeesPage() {
    await loadEmployees();
}

async function loadEmployees() {
    const result = await API.get('/employees');
    const container = document.getElementById('employees-list');

    if (!result.success || !result.employees || result.employees.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">👥</div>
                <div class="empty-title">No Employees</div>
                <div class="empty-text">Add employees to manage your team.</div>
            </div>
        `;
        return;
    }

    container.innerHTML = `
        <div class="grid-2">
            ${result.employees.map(e => `
                <div class="card">
                    <div style="display: flex; justify-content: space-between; align-items: start;">
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <div style="width: 48px; height: 48px; border-radius: 50%; background: var(--primary); color: white; display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 700;">${e.name.charAt(0).toUpperCase()}</div>
                            <div>
                                <div style="font-weight: 700; font-size: 16px;">${escapeHtml(e.name)}</div>
                                <div style="font-size: 12px; color: var(--text-light); text-transform: capitalize;">${e.role}</div>
                            </div>
                        </div>
                        <span class="status-badge ${e.is_active ? 'completed' : 'cancelled'}">${e.is_active ? 'Active' : 'Inactive'}</span>
                    </div>
                    <div style="margin-top: 12px; font-size: 14px;">
                        <div><strong>Branch:</strong> ${escapeHtml(e.branch_name || 'Main')}</div>
                        <div><strong>Salary:</strong> ${formatCurrency(e.salary)}</div>
                        <div><strong>Phone:</strong> ${escapeHtml(e.phone || 'N/A')}</div>
                    </div>
                    <div style="display: flex; gap: 8px; margin-top: 16px;">
                        <button onclick="editEmployee(${e.id})" class="btn btn-primary btn-small">Edit</button>
                        <button onclick="toggleEmployee(${e.id}, ${!e.is_active})" class="btn btn-outline btn-small">${e.is_active ? 'Disable' : 'Enable'}</button>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

function showEmployeeForm(employee = null) {
    const isEdit = !!employee;
    const modalContent = `
        <div class="modal-header">
            <div class="modal-title">${isEdit ? 'Edit' : 'Add'} Employee</div>
            <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <form id="employee-form" onsubmit="submitEmployee(event, ${isEdit ? employee.id : 'null'})">
            <div class="form-group">
                <label>Full Name *</label>
                <input type="text" id="emp-name" value="${isEdit ? escapeHtml(employee.name) : ''}" required placeholder="Employee name">
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Role *</label>
                    <input type="text" id="emp-role" value="${isEdit ? escapeHtml(employee.role) : ''}" required placeholder="e.g. Cashier, Manager">
                </div>
                <div class="form-group">
                    <label>Salary</label>
                    <input type="number" id="emp-salary" step="0.01" min="0" value="${isEdit ? employee.salary || '' : ''}" placeholder="0.00">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Phone</label>
                    <input type="tel" id="emp-phone" value="${isEdit ? escapeHtml(employee.phone || '') : ''}" placeholder="Phone number">
                </div>
                <div class="form-group">
                    <label>Email</label>
                    <input type="email" id="emp-email" value="${isEdit ? escapeHtml(employee.email || '') : ''}" placeholder="Email address">
                </div>
            </div>
            <div class="form-group">
                <label>Hire Date</label>
                <input type="date" id="emp-hire-date" value="${isEdit ? employee.hire_date || '' : ''}">
            </div>
            <div class="form-actions">
                <button type="button" onclick="closeModal()" class="btn btn-outline">Cancel</button>
                <button type="submit" class="btn btn-success">${isEdit ? 'Update' : 'Add'} Employee</button>
            </div>
        </form>
    `;
    openModal(modalContent, true);
}

async function submitEmployee(e, employeeId) {
    e.preventDefault();
    const data = {
        name: document.getElementById('emp-name').value,
        role: document.getElementById('emp-role').value,
        salary: parseFloat(document.getElementById('emp-salary').value) || 0,
        phone: document.getElementById('emp-phone').value || null,
        email: document.getElementById('emp-email').value || null,
        hire_date: document.getElementById('emp-hire-date').value || null
    };

    showLoading(true);
    const result = employeeId
        ? await API.put(`/employees/${employeeId}`, data)
        : await API.post('/employees', data);
    showLoading(false);

    if (result.success) {
        showToast(`Employee ${employeeId ? 'updated' : 'added'}!`, 'success');
        closeModal();
        loadEmployees();
    } else {
        showToast(result.error || 'Failed to save employee', 'error');
    }
}

async function editEmployee(id) {
    const result = await API.get('/employees');
    if (result.success && result.employees) {
        const emp = result.employees.find(e => e.id === id);
        if (emp) showEmployeeForm(emp);
    }
}

async function toggleEmployee(id, active) {
    const result = await API.put(`/employees/${id}`, { is_active: active ? 1 : 0 });
    if (result.success) {
        showToast(`Employee ${active ? 'enabled' : 'disabled'}`, 'success');
        loadEmployees();
    }
}

// ==================== PAYROLL ====================
function renderPayroll() {
    return `
        <div class="page-header">
            <div>
                <h1 class="page-title">Payroll</h1>
                <p class="page-subtitle">Salary management</p>
            </div>
            <button onclick="showPayrollForm()" class="btn btn-primary">+ Process Payroll</button>
        </div>
        <div class="filter-bar">
            <select id="payroll-month" onchange="loadPayroll()">
                <option value="">All Months</option>
                ${['January','February','March','April','May','June','July','August','September','October','November','December'].map((m, i) => `<option value="${m}">${m}</option>`).join('')}
            </select>
            <select id="payroll-year" onchange="loadPayroll()">
                <option value="">All Years</option>
                <option value="2024">2024</option>
                <option value="2025">2025</option>
                <option value="2026">2026</option>
            </select>
        </div>
        <div id="payroll-list">
            <div class="empty-state"><div class="empty-icon">💵</div><div class="empty-text">Loading payroll...</div></div>
        </div>
    `;
}

async function initPayrollPage() {
    await loadPayroll();
}

async function loadPayroll() {
    const month = document.getElementById('payroll-month')?.value;
    const year = document.getElementById('payroll-year')?.value;
    let url = '/payroll';
    if (month && year) url += `?month=${month}&year=${year}`;
    else if (month) url += `?month=${month}`;
    else if (year) url += `?year=${year}`;

    const result = await API.get(url);
    const container = document.getElementById('payroll-list');

    if (!result.success || !result.payroll || result.payroll.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">💵</div>
                <div class="empty-title">No Payroll Records</div>
                <div class="empty-text">Process payroll to see records here.</div>
            </div>
        `;
        return;
    }

    container.innerHTML = `
        <div class="table-container table-responsive">
            <table class="table">
                <thead>
                    <tr><th>Employee</th><th>Month</th><th>Base</th><th>Bonus</th><th>Deductions</th><th>Net</th><th>Status</th><th>Actions</th></tr>
                </thead>
                <tbody>
                    ${result.payroll.map(p => `
                        <tr>
                            <td data-label="Employee">${escapeHtml(p.employee_name)}<br><small style="color: var(--text-light);">${escapeHtml(p.employee_role)}</small></td>
                            <td data-label="Month">${p.month} ${p.year}</td>
                            <td data-label="Base">${formatCurrency(p.base_salary)}</td>
                            <td data-label="Bonus">${formatCurrency(p.bonuses)}</td>
                            <td data-label="Deductions">${formatCurrency(p.deductions)}</td>
                            <td data-label="Net" style="font-weight: 700;">${formatCurrency(p.net_salary)}</td>
                            <td data-label="Status"><span class="status-badge ${p.status}">${p.status.toUpperCase()}</span></td>
                            <td data-label="Actions">
                                ${p.status === 'pending' ? `<button onclick="paySalary(${p.id})" class="btn btn-success btn-small">Pay</button>` : '<span style="color: var(--success);">✓ Paid</span>'}
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
}

function showPayrollForm() {
    const modalContent = `
        <div class="modal-header">
            <div class="modal-title">Process Payroll</div>
            <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <form id="payroll-form" onsubmit="submitPayroll(event)">
            <div class="form-group">
                <label>Employee</label>
                <select id="payroll-employee" required>
                    <option value="">Select employee...</option>
                </select>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Month</label>
                    <select id="payroll-month-input" required>
                        ${['January','February','March','April','May','June','July','August','September','October','November','December'].map(m => `<option value="${m}">${m}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label>Year</label>
                    <select id="payroll-year-input" required>
                        <option value="2024">2024</option>
                        <option value="2025" selected>2025</option>
                        <option value="2026">2026</option>
                    </select>
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Base Salary</label>
                    <input type="number" id="payroll-base" step="0.01" min="0" required placeholder="0.00">
                </div>
                <div class="form-group">
                    <label>Bonuses</label>
                    <input type="number" id="payroll-bonus" step="0.01" min="0" value="0" placeholder="0.00">
                </div>
            </div>
            <div class="form-group">
                <label>Deductions</label>
                <input type="number" id="payroll-deduction" step="0.01" min="0" value="0" placeholder="0.00">
            </div>
            <div class="form-group">
                <label>Notes</label>
                <textarea id="payroll-notes" placeholder="Any notes..."></textarea>
            </div>
            <div class="form-actions">
                <button type="button" onclick="closeModal()" class="btn btn-outline">Cancel</button>
                <button type="submit" class="btn btn-success">Process</button>
            </div>
        </form>
    `;
    openModal(modalContent, true);

    // Load employees into select
    API.get('/employees').then(result => {
        if (result.success && result.employees) {
            const select = document.getElementById('payroll-employee');
            result.employees.forEach(e => {
                const option = document.createElement('option');
                option.value = e.id;
                option.textContent = `${e.name} - ${e.role}`;
                select.appendChild(option);
            });
        }
    });
}

async function submitPayroll(e) {
    e.preventDefault();
    const data = {
        employee_id: parseInt(document.getElementById('payroll-employee').value),
        month: document.getElementById('payroll-month-input').value,
        year: parseInt(document.getElementById('payroll-year-input').value),
        base_salary: parseFloat(document.getElementById('payroll-base').value),
        bonuses: parseFloat(document.getElementById('payroll-bonus').value) || 0,
        deductions: parseFloat(document.getElementById('payroll-deduction').value) || 0,
        notes: document.getElementById('payroll-notes').value || null
    };

    showLoading(true);
    const result = await API.post('/payroll', data);
    showLoading(false);

    if (result.success) {
        showToast('Payroll processed!', 'success');
        closeModal();
        loadPayroll();
    } else {
        showToast(result.error || 'Failed to process payroll', 'error');
    }
}

async function paySalary(id) {
    if (!confirm('Mark this salary as paid?')) return;
    const result = await API.put(`/payroll/${id}/pay`, { payment_date: new Date().toISOString().split('T')[0] });
    if (result.success) {
        showToast('Salary marked as paid!', 'success');
        loadPayroll();
    }
}

// ==================== CUSTOMERS ====================
function renderCustomers() {
    return `
        <div class="page-header">
            <div>
                <h1 class="page-title">Customers</h1>
                <p class="page-subtitle">Customer directory</p>
            </div>
            <button onclick="showCustomerForm()" class="btn btn-primary">+ Add Customer</button>
        </div>
        <div class="search-box">
            <span class="search-icon">🔍</span>
            <input type="text" id="customer-search" placeholder="Search customers..." oninput="filterCustomers()">
        </div>
        <div id="customers-list">
            <div class="empty-state"><div class="empty-icon">🤝</div><div class="empty-text">Loading customers...</div></div>
        </div>
    `;
}

async function initCustomersPage() {
    await loadCustomers();
}

async function loadCustomers() {
    const result = await API.get('/customers');
    const container = document.getElementById('customers-list');

    if (!result.success || !result.customers || result.customers.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">🤝</div>
                <div class="empty-title">No Customers</div>
                <div class="empty-text">Add customers to track them.</div>
            </div>
        `;
        return;
    }

    container.innerHTML = `
        <div class="grid-2">
            ${result.customers.map(c => `
                <div class="card">
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <div style="width: 48px; height: 48px; border-radius: 50%; background: var(--secondary); color: var(--text); display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 700;">${c.name.charAt(0).toUpperCase()}</div>
                        <div>
                            <div style="font-weight: 700; font-size: 16px;">${escapeHtml(c.name)}</div>
                            <div style="font-size: 12px; color: var(--text-light);">${escapeHtml(c.phone || 'No phone')}</div>
                        </div>
                    </div>
                    <div style="margin-top: 12px; font-size: 14px;">
                        <div><strong>Total Purchases:</strong> ${formatCurrency(c.total_purchases)}</div>
                        <div><strong>Last Purchase:</strong> ${formatDate(c.last_purchase)}</div>
                        <div><strong>Email:</strong> ${escapeHtml(c.email || 'N/A')}</div>
                    </div>
                    <div style="display: flex; gap: 8px; margin-top: 16px;">
                        <button onclick="editCustomer(${c.id})" class="btn btn-primary btn-small">Edit</button>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

function filterCustomers() {
    const query = document.getElementById('customer-search').value.toLowerCase();
    const cards = document.querySelectorAll('#customers-list .card');
    cards.forEach(card => {
        const text = card.textContent.toLowerCase();
        card.style.display = text.includes(query) ? '' : 'none';
    });
}

function showCustomerForm(customer = null) {
    const isEdit = !!customer;
    const modalContent = `
        <div class="modal-header">
            <div class="modal-title">${isEdit ? 'Edit' : 'Add'} Customer</div>
            <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <form id="customer-form" onsubmit="submitCustomer(event, ${isEdit ? customer.id : 'null'})">
            <div class="form-group">
                <label>Name *</label>
                <input type="text" id="cust-name" value="${isEdit ? escapeHtml(customer.name) : ''}" required placeholder="Customer name">
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Phone</label>
                    <input type="tel" id="cust-phone" value="${isEdit ? escapeHtml(customer.phone || '') : ''}" placeholder="Phone number">
                </div>
                <div class="form-group">
                    <label>Email</label>
                    <input type="email" id="cust-email" value="${isEdit ? escapeHtml(customer.email || '') : ''}" placeholder="Email address">
                </div>
            </div>
            <div class="form-group">
                <label>Address</label>
                <textarea id="cust-address" placeholder="Customer address">${isEdit ? escapeHtml(customer.address || '') : ''}</textarea>
            </div>
            <div class="form-actions">
                <button type="button" onclick="closeModal()" class="btn btn-outline">Cancel</button>
                <button type="submit" class="btn btn-success">${isEdit ? 'Update' : 'Add'} Customer</button>
            </div>
        </form>
    `;
    openModal(modalContent, true);
}

async function submitCustomer(e, customerId) {
    e.preventDefault();
    const data = {
        name: document.getElementById('cust-name').value,
        phone: document.getElementById('cust-phone').value || null,
        email: document.getElementById('cust-email').value || null,
        address: document.getElementById('cust-address').value || null
    };

    showLoading(true);
    const result = customerId
        ? await API.put(`/customers/${customerId}`, data)
        : await API.post('/customers', data);
    showLoading(false);

    if (result.success) {
        showToast(`Customer ${customerId ? 'updated' : 'added'}!`, 'success');
        closeModal();
        loadCustomers();
    } else {
        showToast(result.error || 'Failed to save customer', 'error');
    }
}

async function editCustomer(id) {
    const result = await API.get('/customers');
    if (result.success && result.customers) {
        const cust = result.customers.find(c => c.id === id);
        if (cust) showCustomerForm(cust);
    }
}

// ==================== ANALYTICS ====================
function renderAnalytics() {
    return `
        <div class="page-header">
            <div>
                <h1 class="page-title">Analytics</h1>
                <p class="page-subtitle">Business insights and trends</p>
            </div>
        </div>
        <div class="grid-2">
            <div class="card">
                <div class="card-header">
                    <div class="card-title">Sales Overview</div>
                </div>
                <div id="analytics-sales-chart" style="height: 250px; display: flex; align-items: center; justify-content: center;">
                    <div class="empty-icon">📊</div>
                </div>
            </div>
            <div class="card">
                <div class="card-header">
                    <div class="card-title">Payment Methods</div>
                </div>
                <div id="analytics-payment-chart" style="height: 250px; display: flex; align-items: center; justify-content: center;">
                    <div class="empty-icon">💳</div>
                </div>
            </div>
        </div>
        <div class="card">
            <div class="card-header">
                <div class="card-title">Top Products</div>
            </div>
            <div id="analytics-top-products">
                <div class="empty-state"><div class="empty-icon">🪵</div><div class="empty-text">Loading...</div></div>
            </div>
        </div>
        <div class="grid-2">
            <div class="card">
                <div class="card-header">
                    <div class="card-title">Expenses Breakdown</div>
                </div>
                <div id="analytics-expenses">
                    <div class="empty-state"><div class="empty-icon">💸</div><div class="empty-text">Loading...</div></div>
                </div>
            </div>
            <div class="card">
                <div class="card-header">
                    <div class="card-title">Branch Comparison</div>
                </div>
                <div id="analytics-branches">
                    <div class="empty-state"><div class="empty-icon">🏢</div><div class="empty-text">Loading...</div></div>
                </div>
            </div>
        </div>
    `;
}

async function initAnalyticsPage() {
    // Reuse dashboard data for now - in production, fetch more detailed analytics
    const result = await API.get('/analytics/dashboard');
    if (!result.success) {
        showToast('Failed to load analytics', 'error');
        return;
    }

    const data = result.dashboard;

    // Sales chart
    if (data.sales_chart && data.sales_chart.length > 0) {
        const maxVal = Math.max(...data.sales_chart.map(d => d.total));
        document.getElementById('analytics-sales-chart').innerHTML = `
            <div class="bar-chart" style="width: 100%;">
                ${data.sales_chart.map(d => `
                    <div class="bar-chart-item" style="flex: 1;">
                        <div class="bar-chart-bar" style="height: ${maxVal > 0 ? (d.total / maxVal * 180) : 4}px; background: var(--primary);"></div>
                        <div class="bar-chart-label" style="position: relative; bottom: 0;">${new Date(d.date).getDate()}/${new Date(d.date).getMonth()+1}</div>
                        <div class="bar-chart-value" style="font-size: 10px;">${formatCurrency(d.total)}</div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    // Payment breakdown
    if (data.payment_breakdown && data.payment_breakdown.length > 0) {
        const colors = ['#1a5f4a', '#f4a261', '#e76f51', '#74b9ff', '#a29bfe'];
        const total = data.payment_breakdown.reduce((sum, p) => sum + p.total, 0);
        let currentAngle = 0;

        document.getElementById('analytics-payment-chart').innerHTML = `
            <div style="display: flex; align-items: center; gap: 24px; flex-wrap: wrap; justify-content: center;">
                <div class="pie-chart" style="width: 120px; height: 120px; background: conic-gradient(${data.payment_breakdown.map((p, i) => {
                    const angle = (p.total / total) * 360;
                    const start = currentAngle;
                    currentAngle += angle;
                    return `${colors[i % colors.length]} ${start}deg ${currentAngle}deg`;
                }).join(', ')});"></div>
                <div class="pie-chart-legend" style="display: flex; flex-direction: column; gap: 8px;">
                    ${data.payment_breakdown.map((p, i) => `
                        <div class="pie-legend-item">
                            <div class="pie-legend-color" style="background: ${colors[i % colors.length]}; width: 16px; height: 16px;"></div>
                            <span style="font-size: 13px;">${p.payment_method}: ${formatCurrency(p.total)} (${Math.round(p.total/total*100)}%)</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    // Top products
    if (data.top_products && data.top_products.length > 0) {
        document.getElementById('analytics-top-products').innerHTML = `
            <div class="table-container table-responsive">
                <table class="table">
                    <thead><tr><th>Product</th><th>Quantity Sold</th><th>Revenue</th><th>Performance</th></tr></thead>
                    <tbody>
                        ${data.top_products.map((p, i) => {
                            const maxQty = Math.max(...data.top_products.map(x => x.total_qty));
                            const pct = maxQty > 0 ? (p.total_qty / maxQty * 100) : 0;
                            return `
                                <tr>
                                    <td data-label="Product"><strong>#${i+1}</strong> ${escapeHtml(p.name)}</td>
                                    <td data-label="Qty">${p.total_qty}</td>
                                    <td data-label="Revenue">${formatCurrency(p.total_revenue)}</td>
                                    <td data-label="Performance">
                                        <div style="width: 100%; background: var(--border-light); border-radius: 4px; height: 8px;">
                                            <div style="width: ${pct}%; background: var(--primary); height: 100%; border-radius: 4px; transition: width 0.5s ease;"></div>
                                        </div>
                                    </td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    // Expenses breakdown (simplified - would need dedicated endpoint)
    document.getElementById('analytics-expenses').innerHTML = `
        <div class="empty-state" style="padding: 24px;">
            <div class="empty-icon" style="font-size: 32px;">📊</div>
            <div class="empty-text">Expense analytics available in Reports</div>
        </div>
    `;

    document.getElementById('analytics-branches').innerHTML = `
        <div class="empty-state" style="padding: 24px;">
            <div class="empty-icon" style="font-size: 32px;">🏢</div>
            <div class="empty-text">Multi-branch comparison available for admin</div>
        </div>
    `;
}

// ==================== REPORTS ====================
function renderReports() {
    return `
        <div class="page-header">
            <div>
                <h1 class="page-title">Reports</h1>
                <p class="page-subtitle">Export and view reports</p>
            </div>
        </div>
        <div class="grid-2">
            <div class="card" style="cursor: pointer;" onclick="showSalesReport()">
                <div style="display: flex; align-items: center; gap: 16px;">
                    <div style="font-size: 36px;">💰</div>
                    <div>
                        <div style="font-weight: 700; font-size: 16px;">Sales Report</div>
                        <div style="font-size: 13px; color: var(--text-light); margin-top: 4px;">Export sales data to CSV</div>
                    </div>
                </div>
            </div>
            <div class="card" style="cursor: pointer;" onclick="showInventoryReport()">
                <div style="display: flex; align-items: center; gap: 16px;">
                    <div style="font-size: 36px;">📦</div>
                    <div>
                        <div style="font-weight: 700; font-size: 16px;">Inventory Report</div>
                        <div style="font-size: 13px; color: var(--text-light); margin-top: 4px;">Current stock levels</div>
                    </div>
                </div>
            </div>
            <div class="card" style="cursor: pointer;" onclick="showExpensesReport()">
                <div style="display: flex; align-items: center; gap: 16px;">
                    <div style="font-size: 36px;">💸</div>
                    <div>
                        <div style="font-weight: 700; font-size: 16px;">Expenses Report</div>
                        <div style="font-size: 13px; color: var(--text-light); margin-top: 4px;">Expense breakdown by category</div>
                    </div>
                </div>
            </div>
            <div class="card" style="cursor: pointer;" onclick="showPayrollReport()">
                <div style="display: flex; align-items: center; gap: 16px;">
                    <div style="font-size: 36px;">💵</div>
                    <div>
                        <div style="font-weight: 700; font-size: 16px;">Payroll Report</div>
                        <div style="font-size: 13px; color: var(--text-light); margin-top: 4px;">Salary payments history</div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

async function initReportsPage() {
    // Reports page is mostly static links
}

function showSalesReport() {
    const modalContent = `
        <div class="modal-header">
            <div class="modal-title">Sales Report</div>
            <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <div class="form-group">
            <label>Date Range</label>
            <div class="form-row">
                <input type="date" id="report-date-from" value="${new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0]}">
                <input type="date" id="report-date-to" value="${new Date().toISOString().split('T')[0]}">
            </div>
        </div>
        <div class="form-actions">
            <button onclick="closeModal()" class="btn btn-outline">Cancel</button>
            <button onclick="exportSalesReport()" class="btn btn-success">📥 Download CSV</button>
        </div>
    `;
    openModal(modalContent, true);
}

function exportSalesReport() {
    const from = document.getElementById('report-date-from').value;
    const to = document.getElementById('report-date-to').value;
    window.open(`${API_BASE_URL}/api/reports/sales?date_from=${from}&date_to=${to}&format=csv`, '_blank');
    closeModal();
    showToast('Report downloading...', 'success');
}

function showInventoryReport() {
    window.open(`${API_BASE_URL}/api/reports/inventory?format=csv`, '_blank');
    showToast('Inventory report downloading...', 'success');
}

function showExpensesReport() {
    showToast('Expenses report feature coming soon', 'info');
}

function showPayrollReport() {
    showToast('Payroll report feature coming soon', 'info');
}

// ==================== BRANCHES ====================
function renderBranches() {
    return `
        <div class="page-header">
            <div>
                <h1 class="page-title">Branches</h1>
                <p class="page-subtitle">Manage business locations</p>
            </div>
            <button onclick="showBranchForm()" class="btn btn-primary">+ Add Branch</button>
        </div>
        <div id="branches-list">
            <div class="empty-state"><div class="empty-icon">🏢</div><div class="empty-text">Loading branches...</div></div>
        </div>
    `;
}

async function initBranchesPage() {
    await loadBranches();
}

async function loadBranches() {
    const result = await API.get('/branches');
    const container = document.getElementById('branches-list');

    if (!result.success || !result.branches || result.branches.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">🏢</div>
                <div class="empty-title">No Branches</div>
                <div class="empty-text">Add your first branch to get started.</div>
            </div>
        `;
        return;
    }

    branches = result.branches;

    container.innerHTML = `
        <div class="grid-2">
            ${result.branches.map(b => `
                <div class="card">
                    <div style="display: flex; justify-content: space-between; align-items: start;">
                        <div>
                            <div style="font-weight: 700; font-size: 18px;">${escapeHtml(b.name)}</div>
                            <div style="font-size: 13px; color: var(--text-light); margin-top: 4px;">📍 ${escapeHtml(b.location || 'No location')}</div>
                        </div>
                        <span class="status-badge ${b.is_active ? 'completed' : 'cancelled'}">${b.is_active ? 'Active' : 'Inactive'}</span>
                    </div>
                    <div style="margin-top: 12px; font-size: 14px;">
                        <div>📞 ${escapeHtml(b.phone || 'No phone')}</div>
                        <div>✉️ ${escapeHtml(b.email || 'No email')}</div>
                    </div>
                    <div style="display: flex; gap: 8px; margin-top: 16px;">
                        <button onclick="editBranch(${b.id})" class="btn btn-primary btn-small">Edit</button>
                        <button onclick="toggleBranch(${b.id}, ${!b.is_active})" class="btn btn-outline btn-small">${b.is_active ? 'Deactivate' : 'Activate'}</button>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

function showBranchForm(branch = null) {
    const isEdit = !!branch;
    const modalContent = `
        <div class="modal-header">
            <div class="modal-title">${isEdit ? 'Edit' : 'Add'} Branch</div>
            <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <form id="branch-form" onsubmit="submitBranch(event, ${isEdit ? branch.id : 'null'})">
            <div class="form-group">
                <label>Branch Name *</label>
                <input type="text" id="branch-name" value="${isEdit ? escapeHtml(branch.name) : ''}" required placeholder="Branch name">
            </div>
            <div class="form-group">
                <label>Location</label>
                <input type="text" id="branch-location" value="${isEdit ? escapeHtml(branch.location || '') : ''}" placeholder="Address or location">
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Phone</label>
                    <input type="tel" id="branch-phone" value="${isEdit ? escapeHtml(branch.phone || '') : ''}" placeholder="Phone number">
                </div>
                <div class="form-group">
                    <label>Email</label>
                    <input type="email" id="branch-email" value="${isEdit ? escapeHtml(branch.email || '') : ''}" placeholder="Email address">
                </div>
            </div>
            <div class="form-actions">
                <button type="button" onclick="closeModal()" class="btn btn-outline">Cancel</button>
                <button type="submit" class="btn btn-success">${isEdit ? 'Update' : 'Add'} Branch</button>
            </div>
        </form>
    `;
    openModal(modalContent, true);
}

async function submitBranch(e, branchId) {
    e.preventDefault();
    const data = {
        name: document.getElementById('branch-name').value,
        location: document.getElementById('branch-location').value || null,
        phone: document.getElementById('branch-phone').value || null,
        email: document.getElementById('branch-email').value || null,
        is_active: 1
    };

    showLoading(true);
    const result = branchId
        ? await API.put(`/branches/${branchId}`, data)
        : await API.post('/branches', data);
    showLoading(false);

    if (result.success) {
        showToast(`Branch ${branchId ? 'updated' : 'added'}!`, 'success');
        closeModal();
        loadBranches();
    } else {
        showToast(result.error || 'Failed to save branch', 'error');
    }
}

async function editBranch(id) {
    const branch = branches.find(b => b.id === id);
    if (branch) showBranchForm(branch);
}

async function toggleBranch(id, active) {
    const branch = branches.find(b => b.id === id);
    if (!branch) return;
    const data = { ...branch, is_active: active ? 1 : 0 };
    const result = await API.put(`/branches/${id}`, data);
    if (result.success) {
        showToast(`Branch ${active ? 'activated' : 'deactivated'}`, 'success');
        loadBranches();
    }
}

// ==================== USERS & ROLES ====================
function renderUsers() {
    return `
        <div class="page-header">
            <div>
                <h1 class="page-title">Users & Roles</h1>
                <p class="page-subtitle">Manage access control</p>
            </div>
            <button onclick="showUserForm()" class="btn btn-primary">+ Add User</button>
        </div>
        <div id="users-list">
            <div class="empty-state"><div class="empty-icon">🔐</div><div class="empty-text">Loading users...</div></div>
        </div>
    `;
}

async function initUsersPage() {
    await loadUsers();
}

async function loadUsers() {
    const result = await API.get('/users');
    const container = document.getElementById('users-list');

    if (!result.success || !result.users || result.users.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">🔐</div>
                <div class="empty-title">No Users</div>
                <div class="empty-text">Add users to manage access.</div>
            </div>
        `;
        return;
    }

    container.innerHTML = `
        <div class="table-container table-responsive">
            <table class="table">
                <thead>
                    <tr><th>User</th><th>Role</th><th>Branch</th><th>Status</th><th>Last Login</th><th>Actions</th></tr>
                </thead>
                <tbody>
                    ${result.users.map(u => `
                        <tr>
                            <td data-label="User">
                                <div style="font-weight: 600;">${escapeHtml(u.full_name)}</div>
                                <div style="font-size: 12px; color: var(--text-light);">${escapeHtml(u.username)}</div>
                            </td>
                            <td data-label="Role"><span class="status-badge ${u.role_name === 'admin' ? 'danger' : 'info'}">${u.role_name.toUpperCase()}</span></td>
                            <td data-label="Branch">${escapeHtml(u.branch_name || 'All')}</td>
                            <td data-label="Status"><span class="status-badge ${u.is_active ? 'completed' : 'cancelled'}">${u.is_active ? 'Active' : 'Inactive'}</span></td>
                            <td data-label="Last Login">${u.last_login ? formatDateTime(u.last_login) : 'Never'}</td>
                            <td data-label="Actions">
                                <button onclick="editUser(${u.id})" class="btn btn-primary btn-small">Edit</button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
}

function showUserForm(user = null) {
    const isEdit = !!user;
    const modalContent = `
        <div class="modal-header">
            <div class="modal-title">${isEdit ? 'Edit' : 'Add'} User</div>
            <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <form id="user-form" onsubmit="submitUser(event, ${isEdit ? user.id : 'null'})">
            <div class="form-row">
                <div class="form-group">
                    <label>Username *</label>
                    <input type="text" id="user-username" value="${isEdit ? escapeHtml(user.username) : ''}" required placeholder="Username" ${isEdit ? 'disabled' : ''}>
                </div>
                <div class="form-group">
                    <label>Full Name *</label>
                    <input type="text" id="user-fullname" value="${isEdit ? escapeHtml(user.full_name) : ''}" required placeholder="Full name">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Email</label>
                    <input type="email" id="user-email" value="${isEdit ? escapeHtml(user.email || '') : ''}" placeholder="Email">
                </div>
                <div class="form-group">
                    <label>Phone</label>
                    <input type="tel" id="user-phone" value="${isEdit ? escapeHtml(user.phone || '') : ''}" placeholder="Phone">
                </div>
            </div>
            ${!isEdit ? `
            <div class="form-group">
                <label>Password *</label>
                <input type="password" id="user-password" required placeholder="Password" minlength="6">
            </div>
            ` : ''}
            <div class="form-row">
                <div class="form-group">
                    <label>Role *</label>
                    <select id="user-role" required>
                        <option value="">Select role...</option>
                        <option value="1">Admin</option>
                        <option value="2">Manager</option>
                        <option value="3">Cashier</option>
                        <option value="4">Storekeeper</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Branch</label>
                    <select id="user-branch">
                        <option value="">All Branches</option>
                        ${branches.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('')}
                    </select>
                </div>
            </div>
            <div class="form-group">
                <label>
                    <input type="checkbox" id="user-active" ${!isEdit || user.is_active ? 'checked' : ''}>
                    Active
                </label>
            </div>
            <div class="form-actions">
                <button type="button" onclick="closeModal()" class="btn btn-outline">Cancel</button>
                <button type="submit" class="btn btn-success">${isEdit ? 'Update' : 'Add'} User</button>
            </div>
        </form>
    `;
    openModal(modalContent, true);
}

async function submitUser(e, userId) {
    e.preventDefault();

    const roleId = document.getElementById('user-role').value;
    if (!roleId || isNaN(parseInt(roleId))) {
        showToast('Please select a role', 'error');
        return;
    }

    const data = {
        username: document.getElementById('user-username').value,
        full_name: document.getElementById('user-fullname').value,
        email: document.getElementById('user-email').value || null,
        phone: document.getElementById('user-phone').value || null,
        role_id: parseInt(roleId),
        branch_id: document.getElementById('user-branch').value ? parseInt(document.getElementById('user-branch').value) : null,
        is_active: document.getElementById('user-active').checked ? 1 : 0
    };

    if (!userId) {
        const password = document.getElementById('user-password').value;
        if (!password || password.length < 6) {
            showToast('Password must be at least 6 characters', 'error');
            return;
        }
        data.password = password;
    }

    showLoading(true);
    const result = userId
        ? await API.put(`/users/${userId}`, data)
        : await API.post('/users', data);
    showLoading(false);

    if (result.success) {
        showToast(`User ${userId ? 'updated' : 'added'}!`, 'success');
        closeModal();
        loadUsers();
    } else {
        showToast(result.error || 'Failed to save user', 'error');
    }
}

async function editUser(id) {
    const result = await API.get('/users');
    if (result.success && result.users) {
        const user = result.users.find(u => u.id === id);
        if (user) showUserForm(user);
    }
}

// ==================== AUDIT LOGS ====================
function renderAuditLogs() {
    return `
        <div class="page-header">
            <div>
                <h1 class="page-title">Audit Logs</h1>
                <p class="page-subtitle">Activity tracking</p>
            </div>
        </div>
        <div id="audit-logs-list">
            <div class="empty-state"><div class="empty-icon">📋</div><div class="empty-text">Loading audit logs...</div></div>
        </div>
    `;
}

async function initAuditLogsPage() {
    await loadAuditLogs();
}

async function loadAuditLogs() {
    const result = await API.get('/audit-logs');
    const container = document.getElementById('audit-logs-list');

    if (!result.success || !result.logs || result.logs.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📋</div>
                <div class="empty-title">No Logs</div>
                <div class="empty-text">Activity will be logged here.</div>
            </div>
        `;
        return;
    }

    const actionIcons = {
        create: '➕', update: '✏️', delete: '🗑️', soft_delete: '🗑️',
        cancel: '❌', status_change: '🔄', receive_stock: '📥'
    };

    container.innerHTML = `
        <div class="table-container table-responsive">
            <table class="table">
                <thead>
                    <tr><th>Action</th><th>User</th><th>Entity</th><th>Date</th></tr>
                </thead>
                <tbody>
                    ${result.logs.map(l => `
                        <tr>
                            <td data-label="Action">
                                <span style="font-size: 18px; margin-right: 8px;">${actionIcons[l.action] || '📝'}</span>
                                <span style="text-transform: capitalize; font-weight: 600;">${l.action}</span>
                            </td>
                            <td data-label="User">${escapeHtml(l.user_name || 'System')}</td>
                            <td data-label="Entity">${l.entity_type} #${l.entity_id}</td>
                            <td data-label="Date">${formatDateTime(l.created_at)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
}

// ==================== SETTINGS ====================
function renderSettings() {
    return `
        <div class="page-header">
            <div>
                <h1 class="page-title">Settings</h1>
                <p class="page-subtitle">System configuration</p>
            </div>
        </div>
        <div class="grid-2">
            <div class="card">
                <div class="card-header">
                    <div class="card-title">🔔 Notifications</div>
                </div>
                <div style="display: flex; flex-direction: column; gap: 12px;">
                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                        <input type="checkbox" checked style="width: 20px; height: 20px;">
                        <span>Every sale notification</span>
                    </label>
                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                        <input type="checkbox" checked style="width: 20px; height: 20px;">
                        <span>Hourly summary</span>
                    </label>
                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                        <input type="checkbox" checked style="width: 20px; height: 20px;">
                        <span>End-of-day summary</span>
                    </label>
                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                        <input type="checkbox" checked style="width: 20px; height: 20px;">
                        <span>Low stock alerts</span>
                    </label>
                </div>
            </div>
            <div class="card">
                <div class="card-header">
                    <div class="card-title">⚙️ System</div>
                </div>
                <div style="display: flex; flex-direction: column; gap: 12px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--border-light);">
                        <span>App Version</span>
                        <span style="font-weight: 600;">${APP_VERSION}</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--border-light);">
                        <span>API URL</span>
                        <span style="font-weight: 600; font-size: 12px; color: var(--text-light);">${API_BASE_URL}</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 0;">
                        <span>Offline Mode</span>
                        <span style="font-weight: 600; color: ${isOnline ? 'var(--success)' : 'var(--danger)'}">${isOnline ? 'Online' : 'Offline'}</span>
                    </div>
                </div>
                <div style="margin-top: 16px;">
                    <button onclick="clearCache()" class="btn btn-outline btn-full">🗑️ Clear Cache</button>
                </div>
            </div>
        </div>
        <div class="card" style="margin-top: 16px;">
            <div class="card-header">
                <div class="card-title">🌐 API Configuration</div>
            </div>
            <div class="form-group">
                <label>API Base URL</label>
                <input type="text" id="settings-api-url" value="${API_BASE_URL}" placeholder="https://your-worker.workers.dev">
            </div>
            <button onclick="saveApiUrl()" class="btn btn-success">Save API URL</button>
        </div>
    `;
}

async function initSettingsPage() {
    // Settings page initialization
}

function saveApiUrl() {
    const url = document.getElementById('settings-api-url').value;
    if (url) {
        localStorage.setItem('api_base_url', url);
        showToast('API URL saved. Refresh to apply.', 'success');
    }
}

function clearCache() {
    if (confirm('Clear all cached data? This will not affect server data.')) {
        indexedDB.deleteDatabase(DB_NAME);
        showToast('Cache cleared. Refreshing...', 'success');
        setTimeout(() => location.reload(), 1500);
    }
}

// Load saved API URL on startup
const savedApiUrl = localStorage.getItem('api_base_url');
if (savedApiUrl) {
    // Note: In a real app, we'd update the API_BASE_URL variable
    console.log('Saved API URL:', savedApiUrl);
}
