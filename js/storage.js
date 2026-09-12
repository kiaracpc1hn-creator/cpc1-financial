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

    async _getCloud(key) {
      if (!this.isFirebaseConnected()) return null;
      try {
        const docSnap = await firestoreDb.collection(FIREBASE_COLLECTION).doc(key).get();
        if (docSnap.exists) {
          const data = docSnap.data();
          if (data) {
            let val = data.value;
            if (data.isChunked && data.totalChunks > 0) {
              const chunkFetchers = [];
              for (let i = 0; i < data.totalChunks; i++) {
                chunkFetchers.push(firestoreDb.collection(FIREBASE_COLLECTION).doc(`${key}_chunk_${i}`).get());
              }
              const chunkSnaps = await Promise.all(chunkFetchers);
              const parts = chunkSnaps.map((snap, i) => {
                if (snap.exists && snap.data() && snap.data().value) return snap.data().value;
                return data['chunk_' + i] || '';
              });
              val = parts.join('');
            }
            if (val !== undefined && val !== null && val !== '') {
              this._setLocal(key, val).catch(() => {});
              return { key, value: val };
            }
          }
        }
      } catch (err) {
        console.warn(`[CPC1 Cloud] Get "${key}" cloud error:`, err.message);
      }
      return null;
    },

    async get(key, isBinary = false, forceCloud = false) {
      // 0. Metadata or forceCloud directly from Firestore
      if ((key === 'users' || forceCloud) && this.isFirebaseConnected()) {
        const cloudRes = await this._getCloud(key);
        if (cloudRes) return cloudRes;
      }

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
            req.onerror = (err) => {
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
      // 1. Save locally to IndexedDB immediately (instant UX)
      await this._setLocal(key, value);

      // 2. Sync to Firebase Cloud Firestore if connected
      if (this.isFirebaseConnected()) {
        try {
          if (typeof value === 'string' && value.length > 550000) {
            // Split into dedicated ~550KB chunk documents (each well below 1MB limit)
            const chunkSize = 550000;
            const totalChunks = Math.ceil(value.length / chunkSize);

            // Save main document header
            await firestoreDb.collection(FIREBASE_COLLECTION).doc(key).set({
              key: key,
              isChunked: true,
              totalChunks: totalChunks,
              updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            // Save chunk sub-documents in parallel
            const chunkPromises = [];
            for (let i = 0; i < totalChunks; i++) {
              const chunkData = value.slice(i * chunkSize, (i + 1) * chunkSize);
              chunkPromises.push(
                firestoreDb.collection(FIREBASE_COLLECTION).doc(`${key}_chunk_${i}`).set({
                  value: chunkData,
                  updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                })
              );
            }
            await Promise.all(chunkPromises);
          } else {
            await firestoreDb.collection(FIREBASE_COLLECTION).doc(key).set({
              key: key,
              isChunked: false,
              value: value,
              updatedAt: firebase.firestore.FieldValue.serverTimestamp()
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
          const unsub = firestoreDb.collection(FIREBASE_COLLECTION).doc(k).onSnapshot(async docSnap => {
            if (docSnap.exists) {
              const data = docSnap.data();
              if (data) {
                let val = data.value;
                if (data.isChunked && data.totalChunks > 0) {
                  const chunkFetchers = [];
                  for (let i = 0; i < data.totalChunks; i++) {
                    chunkFetchers.push(firestoreDb.collection(FIREBASE_COLLECTION).doc(`${k}_chunk_${i}`).get());
                  }
                  const chunkSnaps = await Promise.all(chunkFetchers);
                  const parts = chunkSnaps.map((snap, i) => {
                    if (snap.exists && snap.data() && snap.data().value) return snap.data().value;
                    return data['chunk_' + i] || '';
                  });
                  val = parts.join('');
                }
                if (val !== undefined && val !== null && val !== '') {
                  this._setLocal(k, val).catch(() => {});
                  callback(k, val);
                }
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

    // Granular Per-Voucher Collection Cloud Operations for 100% Data Persistence
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
        await firestoreDb.collection('cpc1_vouchers_list').doc(docObj.id).set({
          ...copy,
          updatedAtCloud: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      } catch (err) {
        console.warn(`[CPC1 Cloud] Error saving voucher ${docObj.id}:`, err.message);
      }
    },

    async deleteVoucherCloud(docId) {
      if (!this.isFirebaseConnected() || !docId) return;
      try {
        await firestoreDb.collection('cpc1_vouchers_list').doc(docId).delete();
      } catch (err) {
        console.warn(`[CPC1 Cloud] Error deleting voucher ${docId}:`, err.message);
      }
    },

    listenVouchersRealtime(callback) {
      if (!this.isFirebaseConnected()) return () => {};
      try {
        const unsub = firestoreDb.collection('cpc1_vouchers_list').onSnapshot(snapshot => {
          const vouchers = [];
          const changes = [];
          snapshot.docChanges().forEach(change => {
            const data = change.doc.data();
            if (data && data.id) {
              changes.push({ type: change.type, doc: data, id: change.doc.id });
            }
          });
          snapshot.forEach(docSnap => {
            const data = docSnap.data();
            if (data && data.id) {
              vouchers.push(data);
            }
          });
          callback(vouchers, changes);
        }, err => {
          console.warn(`[CPC1 Cloud] Realtime vouchers sync error:`, err.message);
        });
        return unsub;
      } catch (e) {
        console.warn(`[CPC1 Cloud] Vouchers listener attach failed:`, e);
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
