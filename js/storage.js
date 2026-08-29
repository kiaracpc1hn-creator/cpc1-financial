/**
 * CPC1 Financial Vouchers - Storage Engine (IndexedDB + Firebase Cloud Sync)
 * Supports real-time multi-user cloud synchronization with offline-first IndexedDB resilience.
 */
(function () {
  const DB_NAME = 'CPC1_Financial_DB';
  const DB_VERSION = 1;
  const STORE_NAME = 'cpc1_store';
  const FIREBASE_COLLECTION = 'cpc1_store';

  const DEFAULT_FIREBASE_CONFIG = {
    apiKey: "AIzaSyCAlizFiXYOQ5AfyI0aitbiIoXdlh9bFtE",
    authDomain: "cpc1-vouchers.firebaseapp.com",
    projectId: "cpc1-vouchers",
    storageBucket: "cpc1-vouchers.firebasestorage.app",
    messagingSenderId: "774346596332",
    appId: "1:774346596332:web:448bbca398f890872d6ac9",
    measurementId: "G-C81HKBM8QJ"
  };

  let dbPromise = null;
  let firestoreDb = null;
  let isFirebaseReady = false;

  function initFirebase() {
    try {
      if (window.firebase && !firebase.apps.length) {
        firebase.initializeApp(DEFAULT_FIREBASE_CONFIG);
        firestoreDb = firebase.firestore();
        isFirebaseReady = true;
        console.log("✓ [CPC1] Firebase Cloud Firestore initialized successfully!");
      } else if (window.firebase && firebase.apps.length) {
        firestoreDb = firebase.firestore();
        isFirebaseReady = true;
      }
    } catch (e) {
      console.warn("[CPC1] Firebase initialization warning:", e);
    }
  }

  // Initialize Firebase when script runs or window loads
  if (typeof window !== 'undefined') {
    initFirebase();
    window.addEventListener('load', initFirebase);
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
      request.onsuccess = (e) => {
        resolve(e.target.result);
      };
      request.onerror = (e) => {
        console.warn('Failed to open IndexedDB, falling back to localStorage:', e);
        resolve(null);
      };
    });
    return dbPromise;
  }

  const StorageEngine = {
    isFirebaseConnected() {
      return isFirebaseReady && !!firestoreDb;
    },

    async get(key, isBinary = false) {
      // 1. Try local IndexedDB first for instant UI response
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

      // If local cache hit, return immediately
      if (localResult && localResult.value !== undefined && localResult.value !== null) {
        return localResult;
      }

      // 2. Local cache miss: ALWAYS fetch fresh data (including attachments) from Firebase Cloud Firestore if connected!
      if (this.isFirebaseConnected()) {
        try {
          const docSnap = await firestoreDb.collection(FIREBASE_COLLECTION).doc(key).get();
          if (docSnap.exists) {
            const data = docSnap.data();
            if (data && data.value !== undefined && data.value !== null) {
              // Cache locally into IndexedDB for instant future reads
              this._setLocal(key, data.value).catch(() => {});
              return { key, value: data.value };
            }
          }
        } catch (err) {
          console.warn(`[CPC1 Cloud] Get "${key}" cloud fallback error:`, err.message);
        }
      }

      return null;
    },

    async _setLocal(key, value) {
      const db = await openDB();
      if (db) {
        return new Promise((resolve, reject) => {
          try {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const req = store.put({ key, value });
            req.onsuccess = () => resolve(true);
            req.onerror = () => {
              try { localStorage.setItem('cpc1_' + key, value); resolve(true); } catch (e) { reject(e); }
            };
          } catch (err) {
            try { localStorage.setItem('cpc1_' + key, value); resolve(true); } catch (e) { reject(e); }
          }
        });
      } else {
        localStorage.setItem('cpc1_' + key, value);
        return true;
      }
    },

    async set(key, value, isBinary = false) {
      // 1. Save locally to IndexedDB immediately (instant UX)
      await this._setLocal(key, value);

      // 2. Sync to Firebase Cloud Firestore if connected
      if (this.isFirebaseConnected()) {
        try {
          if (typeof value === 'string' && value.length > 1040000) {
            console.warn(`[CPC1 Cloud] File "${key}" (${Math.round(value.length/1024)}KB) exceeds Firestore 1MB document limit.`);
          } else {
            firestoreDb.collection(FIREBASE_COLLECTION).doc(key).set({
              key: key,
              value: value,
              updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true }).catch(err => {
              console.warn(`[CPC1 Cloud] Firestore set error for "${key}":`, err.message);
            });
          }
        } catch (cloudErr) {
          console.warn(`[CPC1 Cloud] Could not push "${key}" to Firestore:`, cloudErr);
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

      // Sync deletion to Firebase
      if (this.isFirebaseConnected()) {
        try {
          firestoreDb.collection(FIREBASE_COLLECTION).doc(key).delete().catch(() => {});
        } catch (e) {}
      }

      return true;
    },

    listenRealtime(keys, callback) {
      if (!this.isFirebaseConnected()) return () => {};
      const unsubscribers = [];
      keys.forEach(k => {
        try {
          const unsub = firestoreDb.collection(FIREBASE_COLLECTION).doc(k).onSnapshot(docSnap => {
            if (docSnap.exists) {
              const data = docSnap.data();
              if (data && data.value !== undefined) {
                // Update local storage silently
                this._setLocal(k, data.value).catch(() => {});
                callback(k, data.value);
              }
            }
          }, err => {
            console.warn(`[CPC1 Cloud] Realtime sync paused for "${k}":`, err.message);
          });
          unsubscribers.push(unsub);
        } catch (e) {
          console.warn(`[CPC1 Cloud] Listener attach failed for "${k}":`, e);
        }
      });

      return () => unsubscribers.forEach(u => typeof u === 'function' && u());
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
            (req.result || []).forEach(item => {
              result[item.key] = item.value;
            });
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

        // Also push to Firestore if connected
        if (this.isFirebaseConnected()) {
          for (const key of Object.keys(data)) {
            if (data[key] && data[key].length < 950000) {
              firestoreDb.collection(FIREBASE_COLLECTION).doc(key).set({
                key: key,
                value: data[key],
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
              }, { merge: true }).catch(() => {});
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

  // Mount to window.storage
  window.storage = StorageEngine;
  window.CPC1Storage = StorageEngine;
})();
