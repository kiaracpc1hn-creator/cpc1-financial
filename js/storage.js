/**
 * CPC1 Financial Vouchers - Storage Engine (IndexedDB + Supabase Cloud Sync)
 * Đã chuyển từ Firebase Firestore sang Supabase (Postgres). Giữ nguyên toàn bộ
 * API công khai (window.storage.get/set/delete/listenRealtime/saveVoucherCloud/
 * deleteVoucherCloud/listenVouchersRealtime/exportAll/importAll/isFirebaseConnected)
 * để app.js KHÔNG cần sửa gì thêm.
 */
(function () {
  const DB_NAME = 'CPC1_Financial_DB';
  const DB_VERSION = 1;
  const STORE_NAME = 'cpc1_store';
  const TABLE_STORE = 'cpc1_store';
  const TABLE_VOUCHERS = 'cpc1_vouchers_list';

  // ---- Thông tin dự án Supabase của bạn ----
  const SUPABASE_URL = 'https://cpc1-financial.sb.qlcvdtp.io.vn';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzkwMTUzODY2LCJleHAiOjE5NDc4MzM4NjZ9.-ZGamSZUY_UOPSElNzWN57cqIqlhglVJQmZzp0QAkp8';

  let dbPromise = null;
  let supabaseClient = null;
  let isSupabaseReady = false;
  let anonSignInAttempted = false;

  function ensureAnonSession() {
    if (!supabaseClient || anonSignInAttempted) return;
    anonSignInAttempted = true;
    supabaseClient.auth.getSession().then(({ data }) => {
      if (data && data.session) {
        console.log('✓ [CPC1] Đã có phiên đăng nhập, user id:', data.session.user.id);
        return;
      }
      supabaseClient.auth.signInAnonymously().then(({ data, error }) => {
        if (error) {
          console.warn('[CPC1] Đăng nhập ẩn danh thất bại (kiểm tra Anonymous Sign-Ins đã bật trong Supabase Auth chưa):', error.message);
        } else {
          console.log('✓ [CPC1] Đã xác thực ẩn danh, user id:', data.user && data.user.id);
        }
      });
    });
  }

  function initSupabase() {
    try {
      if (window.supabase && window.supabase.createClient && !supabaseClient) {
        supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          auth: { persistSession: true, autoRefreshToken: true }
        });
        isSupabaseReady = true;
        console.log('✓ [CPC1] Supabase initialized successfully!');
        ensureAnonSession();
        supabaseClient.auth.onAuthStateChange((event) => {
          if (event === 'SIGNED_OUT') {
            anonSignInAttempted = false;
            ensureAnonSession();
          }
        });
      }
    } catch (e) {
      console.warn('[CPC1] Supabase initialization warning:', e);
    }
  }

  if (typeof window !== 'undefined') {
    initSupabase();
    window.addEventListener('load', initSupabase);
  }

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      if (!window.indexedDB) {
        console.warn('IndexedDB not supported, falling back to localStorage.');
        resolve(null);
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };
      request.onsuccess = (e) => resolve(e.target.result);
      request.onerror = (e) => {
        console.warn('Failed to open IndexedDB, falling back to localStorage:', e);
        resolve(null);
      };
    });
    return dbPromise;
  }

  const StorageEngine = {
    // Giữ nguyên tên hàm "isFirebaseConnected" để tương thích ngược với app.js,
    // dù thực chất giờ đang kiểm tra kết nối Supabase.
    isFirebaseConnected() {
      return isSupabaseReady && !!supabaseClient;
    },

    async _getCloud(key) {
      if (!this.isFirebaseConnected()) return null;
      try {
        const { data, error } = await supabaseClient
          .from(TABLE_STORE)
          .select('value')
          .eq('key', key)
          .maybeSingle();
        if (error) throw error;
        if (data && data.value !== undefined && data.value !== null && data.value !== '') {
          this._setLocal(key, data.value).catch(() => {});
          return { key, value: data.value };
        }
      } catch (err) {
        console.warn(`[CPC1 Cloud] Get "${key}" cloud error:`, err.message || err);
      }
      return null;
    },

    async get(key, isBinary = false, forceCloud = false) {
      // 0. Metadata hoặc forceCloud: đọc thẳng từ Supabase
      if ((key === 'users' || forceCloud) && this.isFirebaseConnected()) {
        const cloudRes = await this._getCloud(key);
        if (cloudRes) return cloudRes;
      }

      // 1. Ưu tiên đọc IndexedDB tại chỗ để phản hồi UI tức thì
      const db = await openDB();
      let localResult = null;
      if (db) {
        localResult = await new Promise((resolve) => {
          try {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.get(key);
            req.onsuccess = () => {
              if (req.result && req.result.value !== undefined && req.result.value !== null) {
                resolve({ key: req.result.key, value: req.result.value });
              } else {
                const localVal = localStorage.getItem('cpc1_' + key);
                resolve(localVal !== null ? { key, value: localVal } : null);
              }
            };
            req.onerror = () => {
              const localVal = localStorage.getItem('cpc1_' + key);
              resolve(localVal !== null ? { key, value: localVal } : null);
            };
          } catch (err) {
            const localVal = localStorage.getItem('cpc1_' + key);
            resolve(localVal !== null ? { key, value: localVal } : null);
          }
        });
      } else {
        const val = localStorage.getItem('cpc1_' + key);
        localResult = val !== null ? { key, value: val } : null;
      }

      if (localResult && localResult.value !== undefined && localResult.value !== null) {
        return localResult;
      }

      // 2. Cache local không có: luôn thử lấy từ Supabase nếu đã kết nối
      if (this.isFirebaseConnected()) {
        const cloudRes = await this._getCloud(key);
        if (cloudRes) return cloudRes;
      }

      return null;
    },

    async _setLocal(key, value) {
      const db = await openDB();
      if (db) {
        return new Promise((resolve) => {
          try {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const req = store.put({ key, value });
            req.onsuccess = () => resolve(true);
            req.onerror = () => {
              try { localStorage.setItem('cpc1_' + key, value); resolve(true); } catch (e) {
                console.warn(`[CPC1 Storage] Could not save "${key}" to local cache:`, e);
                resolve(false);
              }
            };
          } catch (err) {
            try { localStorage.setItem('cpc1_' + key, value); resolve(true); } catch (e) {
              console.warn(`[CPC1 Storage] Local cache error for "${key}":`, err);
              resolve(false);
            }
          }
        });
      } else {
        try {
          localStorage.setItem('cpc1_' + key, value);
        } catch (e) {
          console.warn(`[CPC1 Storage] LocalStorage set item failed for "${key}":`, e);
        }
        return true;
      }
    },

    async set(key, value, isBinary = false) {
      // 1. Lưu local ngay lập tức (UX tức thì)
      await this._setLocal(key, value);

      // 2. Đồng bộ lên Supabase nếu đã kết nối. Postgres/text không có giới hạn
      //    1MB/tài liệu như Firestore nên KHÔNG cần chia nhỏ (chunk) như trước.
      if (this.isFirebaseConnected()) {
        try {
          const { error } = await supabaseClient
            .from(TABLE_STORE)
            .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
          if (error) throw error;
        } catch (cloudErr) {
          console.warn(`[CPC1 Cloud] Could not push "${key}" to Supabase:`, cloudErr.message || cloudErr);
        }
      }

      return true;
    },

    async delete(key, isBinary = false) {
      const db = await openDB();
      if (db) {
        await new Promise((resolve) => {
          try {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const req = store.delete(key);
            req.onsuccess = () => { localStorage.removeItem('cpc1_' + key); resolve(true); };
            req.onerror = () => { localStorage.removeItem('cpc1_' + key); resolve(true); };
          } catch (err) {
            localStorage.removeItem('cpc1_' + key);
            resolve(true);
          }
        });
      } else {
        localStorage.removeItem('cpc1_' + key);
      }

      if (this.isFirebaseConnected()) {
        try {
          await supabaseClient.from(TABLE_STORE).delete().eq('key', key);
        } catch (e) {}
      }

      return true;
    },

    // Lắng nghe thay đổi thời gian thực cho các key đơn lẻ (users, invoices, payees, trash...)
    listenRealtime(keys, callback) {
      if (!this.isFirebaseConnected()) return () => {};
      const channels = [];
      keys.forEach(k => {
        try {
          const channel = supabaseClient
            .channel('cpc1_store_' + k)
            .on('postgres_changes',
              { event: '*', schema: 'public', table: TABLE_STORE, filter: `key=eq.${k}` },
              (payload) => {
                const row = payload.new;
                if (row && row.value !== undefined && row.value !== null && row.value !== '') {
                  this._setLocal(k, row.value).catch(() => {});
                  callback(k, row.value);
                }
              })
            .subscribe();
          channels.push(channel);
        } catch (e) {
          console.warn(`[CPC1 Cloud] Listener attach failed for "${k}":`, e);
        }
      });
      return () => channels.forEach(ch => { try { supabaseClient.removeChannel(ch); } catch (e) {} });
    },

    // Lưu 1 phiếu tài chính đơn lẻ lên bảng cpc1_vouchers_list
    async saveVoucherCloud(docObj) {
      if (!this.isFirebaseConnected() || !docObj || !docObj.id) return;
      try {
        const copy = Object.assign({}, docObj);
        if (Array.isArray(copy.attachments)) {
          copy.attachments = copy.attachments.map(a => {
            if (!a) return a;
            const { dataUrl, fileDataUrl, content, ...rest } = a;
            return rest;
          });
        }
        const { error } = await supabaseClient
          .from(TABLE_VOUCHERS)
          .upsert({ id: docObj.id, data: copy, updated_at: new Date().toISOString() }, { onConflict: 'id' });
        if (error) throw error;
      } catch (err) {
        console.warn(`[CPC1 Cloud] Error saving voucher ${docObj.id}:`, err.message || err);
      }
    },

    async deleteVoucherCloud(docId) {
      if (!this.isFirebaseConnected() || !docId) return;
      try {
        await supabaseClient.from(TABLE_VOUCHERS).delete().eq('id', docId);
      } catch (err) {
        console.warn(`[CPC1 Cloud] Error deleting voucher ${docId}:`, err.message || err);
      }
    },

    // Lắng nghe thời gian thực TOÀN BỘ danh sách phiếu — tương đương onSnapshot(collection) bên Firestore
    listenVouchersRealtime(callback) {
      if (!this.isFirebaseConnected()) return () => {};
      const currentVouchers = new Map();
      try {
        // Tải toàn bộ 1 lần đầu tiên
        supabaseClient.from(TABLE_VOUCHERS).select('id, data').then(({ data, error }) => {
          if (error) { console.warn('[CPC1 Cloud] Initial vouchers load error:', error.message); return; }
          (data || []).forEach(row => currentVouchers.set(row.id, row.data));
          callback(Array.from(currentVouchers.values()), []);
        });

        const channel = supabaseClient
          .channel('cpc1_vouchers_realtime')
          .on('postgres_changes', { event: '*', schema: 'public', table: TABLE_VOUCHERS }, (payload) => {
            // Supabase Realtime chỉ bắn sự kiện khi Postgres THẬT SỰ ghi xong (không có khái niệm
            // "pending write" như Firestore) nên bản thân cơ chế này không tự lặp lại vô hạn.
            if (payload.eventType === 'DELETE') {
              const oldId = payload.old && payload.old.id;
              const oldData = (payload.old && payload.old.data) || null;
              currentVouchers.delete(oldId);
              callback(Array.from(currentVouchers.values()), [{ type: 'removed', doc: oldData, id: oldId }]);
            } else {
              currentVouchers.set(payload.new.id, payload.new.data);
              callback(Array.from(currentVouchers.values()), [{
                type: payload.eventType === 'INSERT' ? 'added' : 'modified',
                doc: payload.new.data,
                id: payload.new.id
              }]);
            }
          })
          .subscribe();

        return () => { try { supabaseClient.removeChannel(channel); } catch (e) {} };
      } catch (e) {
        console.warn('[CPC1 Cloud] Vouchers listener attach failed:', e);
        return () => {};
      }
    },

    async exportAll() {
      const db = await openDB();
      if (db) {
        return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readonly');
          const store = tx.objectStore(STORE_NAME);
          const req = store.getAll();
          req.onsuccess = () => {
            const result = {};
            (req.result || []).forEach(item => { result[item.key] = item.value; });
            resolve(JSON.stringify(result, null, 2));
          };
          req.onerror = (e) => reject(e);
        });
      } else {
        const result = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith('cpc1_')) {
            result[k.replace('cpc1_', '')] = localStorage.getItem(k);
          }
        }
        return JSON.stringify(result, null, 2);
      }
    },

    async importAll(jsonStr) {
      try {
        const data = JSON.parse(jsonStr);
        const db = await openDB();
        if (db) {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          for (const key of Object.keys(data)) {
            store.put({ key, value: data[key] });
          }
          await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e);
          });
        } else {
          for (const key of Object.keys(data)) {
            localStorage.setItem('cpc1_' + key, data[key]);
          }
        }

        if (this.isFirebaseConnected()) {
          const rows = Object.keys(data).map(key => ({
            key, value: data[key], updated_at: new Date().toISOString()
          }));
          if (rows.length) {
            try {
              await supabaseClient.from(TABLE_STORE).upsert(rows, { onConflict: 'key' });
            } catch (e) {
              console.warn('[CPC1 Cloud] Import push to Supabase warning:', e.message || e);
            }
          }
        }

        return true;
      } catch (err) {
        console.error('Import failed:', err);
        throw err;
      }
    }
  };

  window.storage = StorageEngine;
  window.CPC1Storage = StorageEngine;
})();
