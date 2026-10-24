// ===== Banco de dados da Baldini =====
// Usa o Firebase quando ele está configurado; senão guarda tudo neste navegador.
// Nenhuma falha aqui pode travar o site: todo erro vira um aviso no console.
(() => {
  const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const cfg = window.BALDINI_FIREBASE || {};
  const useFirebase = !!(cfg.apiKey && cfg.projectId);
  const warn = (...a) => console.warn('[BaldiniDB]', ...a);

  function loadScript(src) {
    return new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = src; s.async = false; s.onload = ok; s.onerror = () => fail(new Error('Falha ao carregar ' + src));
      document.head.appendChild(s);
    });
  }
  const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, f) => setTimeout(() => f(new Error(label + ': tempo esgotado')), ms))]);

  // ---------- Modo local (demonstração) ----------
  const LKEY = 'baldini-db';
  const local = {
    read() { try { return JSON.parse(localStorage.getItem(LKEY)) || {}; } catch { return {}; } },
    write(db) { try { localStorage.setItem(LKEY, JSON.stringify(db)); } catch (e) { warn(e); } emit(); },
    col(name) { const db = this.read(); return db[name] || {}; },
    put(name, id, data, merge) {
      const db = this.read();
      db[name] = db[name] || {};
      db[name][id] = merge ? { ...(db[name][id] || {}), ...data } : data;
      this.write(db);
    },
    del(name, id) { const db = this.read(); if (db[name]) delete db[name][id]; this.write(db); }
  };
  const listeners = new Set();
  function emit() { listeners.forEach(fn => { try { fn(); } catch (e) { warn(e); } }); }
  window.addEventListener('storage', e => { if (e.key === LKEY) emit(); });
  function localWatch(fn) { listeners.add(fn); fn(); return () => listeners.delete(fn); }

  // ---------- Firebase ----------
  let fb = null;
  const ready = (async () => {
    if (!useFirebase) return 'local';
    try {
      await withTimeout(Promise.all([
        loadScript(SDK + 'firebase-app-compat.js')
      ]), 8000, 'Firebase');
      await withTimeout(Promise.all([
        loadScript(SDK + 'firebase-firestore-compat.js'),
        loadScript(SDK + 'firebase-auth-compat.js'),
        loadScript(SDK + 'firebase-functions-compat.js')
      ]), 8000, 'Firebase');
      const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(cfg);
      fb = { app, db: app.firestore(), auth: app.auth(), fn: app.functions('southamerica-east1') };
      if (window.BALDINI_OFFLINE) fb.db.enablePersistence({ synchronizeTabs: true }).catch(e => warn('cache offline:', e.code));
      return 'firebase';
    } catch (e) {
      warn('Firebase indisponível, usando modo local.', e);
      fb = null;
      return 'local';
    }
  })();
  const isFb = () => !!fb;
  const docs = snap => snap.docs.map(d => ({ ...d.data(), id: d.id }));

  const api = {
    ready,
    get mode() { return fb ? 'firebase' : 'local'; },

    // ----- Pedidos -----
    async saveOrder(order) {
      await ready;
      if (isFb()) return fb.db.collection('pedidos').doc(order.id).set(order, { merge: true });
      local.put('pedidos', order.id, order, true);
    },
    async updateOrder(id, patch) {
      await ready;
      patch = { ...patch, atualizadoEm: Date.now() };
      if (isFb()) return fb.db.collection('pedidos').doc(id).update(patch);
      // Campos "a.b" viram objetos aninhados, como no Firestore
      const cur = local.col('pedidos')[id] || {};
      Object.entries(patch).forEach(([k, v]) => {
        const path = k.split('.');
        let o = cur;
        path.slice(0, -1).forEach(p => { o = o[p] = (o[p] && typeof o[p] === 'object') ? o[p] : {}; });
        o[path[path.length - 1]] = v;
      });
      local.put('pedidos', id, cur, false);
    },
    async deleteOrder(id) {
      await ready;
      if (isFb()) return fb.db.collection('pedidos').doc(id).delete();
      local.del('pedidos', id);
    },
    async getOrder(id) {
      await ready;
      if (isFb()) { const d = await fb.db.collection('pedidos').doc(id).get(); return d.exists ? { ...d.data(), id: d.id } : null; }
      return local.col('pedidos')[id] || null;
    },
    // Pedidos a partir de uma data (ms), mais novos primeiro
    watchOrders(since, cb, onError = warn) {
      let stop = () => {};
      ready.then(() => {
        if (isFb()) {
          stop = fb.db.collection('pedidos').where('criadoEm', '>=', since).orderBy('criadoEm', 'desc').limit(1500)
            .onSnapshot(s => cb(docs(s)), onError);
        } else {
          stop = localWatch(() => cb(Object.values(local.col('pedidos')).filter(o => o.criadoEm >= since).sort((a, b) => b.criadoEm - a.criadoEm)));
        }
      });
      return () => stop();
    },
    watchOrder(id, cb) {
      let stop = () => {};
      ready.then(() => {
        if (isFb()) stop = fb.db.collection('pedidos').doc(id).onSnapshot(d => cb(d.exists ? { ...d.data(), id: d.id } : null), warn);
        else stop = localWatch(() => cb(local.col('pedidos')[id] || null));
      });
      return () => stop();
    },

    // ----- Configurações (loja, custos, taxas, mensagens) -----
    async getConfig(name) {
      await ready;
      if (isFb()) { const d = await fb.db.collection('config').doc(name).get(); return d.exists ? d.data() : {}; }
      return local.col('config')[name] || {};
    },
    async setConfig(name, data) {
      await ready;
      if (isFb()) return fb.db.collection('config').doc(name).set(data);
      local.put('config', name, data, false);
    },

    // ----- Despesas -----
    async addExpense(d) {
      await ready;
      const id = BaldiniCore.newOrderId();
      if (isFb()) return fb.db.collection('despesas').doc(id).set(d);
      local.put('despesas', id, d, false);
    },
    async deleteExpense(id) {
      await ready;
      if (isFb()) return fb.db.collection('despesas').doc(id).delete();
      local.del('despesas', id);
    },
    watchExpenses(cb) {
      let stop = () => {};
      ready.then(() => {
        if (isFb()) stop = fb.db.collection('despesas').orderBy('data', 'desc').limit(500).onSnapshot(s => cb(docs(s)), warn);
        else stop = localWatch(() => cb(Object.entries(local.col('despesas')).map(([id, d]) => ({ ...d, id })).sort((a, b) => b.data - a.data)));
      });
      return () => stop();
    },

    // ----- Login da equipe -----
    onAuth(cb) {
      ready.then(() => {
        if (isFb()) fb.auth.onAuthStateChanged(u => cb(u ? { email: u.email } : null));
        else cb({ email: 'modo demonstração', demo: true });
      });
    },
    async signIn(email, pass) { await ready; if (isFb()) return fb.auth.signInWithEmailAndPassword(email, pass); },
    async signOut() { await ready; if (isFb()) return fb.auth.signOut(); },

    // ----- Funções no servidor (nota fiscal, iFood) -----
    async call(name, data) {
      await ready;
      if (!isFb()) throw new Error('Disponível só com o Firebase configurado.');
      const res = await fb.fn.httpsCallable(name)(data);
      return res.data;
    }
  };
  window.BaldiniDB = api;
})();
