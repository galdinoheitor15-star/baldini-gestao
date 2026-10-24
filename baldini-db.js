// ===== Banco de dados da Baldini =====
// Usa o Firebase quando ele está configurado; senão guarda tudo neste navegador.
// Nenhuma falha aqui pode travar o site: todo erro vira um aviso no console.
(() => {
  const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const cfg = window.BALDINI_FIREBASE || {};
  const useFirebase = !!(cfg.apiKey && cfg.projectId);
  const warn = (...a) => console.warn('[BaldiniDB]', ...a);

  const loaded = new Set();
  function loadScript(src) {
    if (loaded.has(src)) return Promise.resolve();
    return new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = src; s.async = false;
      s.onload = () => { loaded.add(src); ok(); };
      s.onerror = () => { s.remove(); fail(new Error('Falha ao carregar ' + src)); };
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
  // Com o Firebase configurado, NUNCA cai para o modo local: tenta de novo até conseguir.
  // (Antes, internet lenta no celular fazia a gestão mostrar só os pedidos guardados no aparelho.)
  let fb = null;
  const statusListeners = new Set();
  const conn = { conectando: useFirebase, tentativas: 0 };
  const emitStatus = () => statusListeners.forEach(fn => { try { fn({ ...conn }); } catch (e) { warn(e); } });
  const ready = (async () => {
    if (!useFirebase) return 'local';
    for (let i = 0; ; i++) {
      try {
        await withTimeout(loadScript(SDK + 'firebase-app-compat.js'), 20000, 'Firebase');
        await withTimeout(Promise.all([
          loadScript(SDK + 'firebase-firestore-compat.js'),
          loadScript(SDK + 'firebase-auth-compat.js'),
          loadScript(SDK + 'firebase-functions-compat.js')
        ]), 20000, 'Firebase');
        break;
      } catch (e) {
        conn.tentativas = i + 1; emitStatus();
        warn('Firebase não carregou, tentando de novo...', e);
        await new Promise(r => setTimeout(r, Math.min(30000, 3000 * 2 ** i)));
      }
    }
    const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(cfg);
    fb = { app, db: app.firestore(), auth: app.auth(), fn: app.functions('southamerica-east1') };
    if (window.BALDINI_OFFLINE) fb.db.enablePersistence({ synchronizeTabs: true }).catch(e => warn('cache offline:', e.code));
    conn.conectando = false; emitStatus();
    flushOutbox();
    return 'firebase';
  })();
  const isFb = () => !!fb;
  const docs = snap => snap.docs.map(d => ({ ...d.data(), id: d.id }));

  // ---------- Fila de pedidos (site) ----------
  // O pedido fica guardado no aparelho até o banco confirmar. Se a internet cair, vai na próxima vez.
  const OKEY = 'baldini-fila';
  const outbox = {
    read() { try { return JSON.parse(localStorage.getItem(OKEY)) || {}; } catch { return {}; } },
    write(o) { try { localStorage.setItem(OKEY, JSON.stringify(o)); } catch { /* sem armazenamento */ } },
    add(order) { const o = this.read(); o[order.id] = { order, em: Date.now() }; this.write(o); },
    drop(id) { const o = this.read(); delete o[id]; this.write(o); }
  };
  // Erros que não adianta repetir (ex.: a loja já aceitou o pedido e o rascunho velho não pode mais mudar)
  const finalError = e => ['permission-denied', 'invalid-argument', 'not-found', 'failed-precondition'].includes(e?.code);
  async function sendOrder(order) {
    try { await fb.db.collection('pedidos').doc(order.id).set(order, { merge: true }); outbox.drop(order.id); }
    catch (e) { if (finalError(e)) outbox.drop(order.id); throw e; }
  }
  function flushOutbox() {
    const limite = Date.now() - 2 * 864e5;
    Object.entries(outbox.read()).forEach(([id, { order, em }]) => {
      if (!order || em < limite) return outbox.drop(id);
      sendOrder(order).catch(e => warn('Pedido da fila não enviado', id, e.code || e));
    });
  }

  const api = {
    ready,
    get mode() { return fb ? 'firebase' : 'local'; },

    // ----- Pedidos -----
    async saveOrder(order) {
      if (useFirebase) outbox.add(order);
      await ready;
      if (isFb()) return sendOrder(order);
      local.put('pedidos', order.id, order, true);
    },
    // Situação da conexão: { conectando, tentativas }
    onStatus(cb) { statusListeners.add(cb); cb({ ...conn }); return () => statusListeners.delete(cb); },
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
    // Reserva a emissão da nota de um pedido. Com a gestão aberta em vários aparelhos, só um emite.
    async claimNf(id, retry = false) {
      await ready;
      const free = nf => !nf?.status || (retry && nf.status === 'erro');
      const nf = { status: 'emitindo', em: Date.now() };
      if (isFb()) {
        const ref = fb.db.collection('pedidos').doc(id);
        return fb.db.runTransaction(async t => {
          const d = await t.get(ref);
          if (!d.exists || !free(d.data().nf)) return false;
          t.update(ref, { nf, atualizadoEm: Date.now() });
          return true;
        });
      }
      const cur = local.col('pedidos')[id];
      if (!cur || !free(cur.nf)) return false;
      local.put('pedidos', id, { ...cur, nf }, false);
      return true;
    },
    // Avança o status só se o pedido ainda estiver em "de". Com vários aparelhos abertos, só um avança.
    async advanceIf(id, de, para) {
      await ready;
      const apply = o => {
        if (!o || o.status !== de) return null;
        const em = Date.now();
        return { status: para, historico: [...(o.historico || []), { status: para, em, auto: true }].slice(-30), atualizadoEm: em };
      };
      if (isFb()) {
        const ref = fb.db.collection('pedidos').doc(id);
        return fb.db.runTransaction(async t => {
          const d = await t.get(ref);
          const patch = d.exists && apply(d.data());
          if (!patch) return false;
          t.update(ref, patch);
          return true;
        });
      }
      const cur = local.col('pedidos')[id];
      const patch = apply(cur);
      if (!patch) return false;
      local.put('pedidos', id, { ...cur, ...patch }, false);
      return true;
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
    // cb(lista, { aoVivo, em }): aoVivo=false quando a lista veio do cache do aparelho (sem conexão)
    watchOrders(since, cb, onError = warn) {
      let stop = () => {};
      let last = { aoVivo: false, em: 0 };
      // Escuta que já deu erro não pode ser desligada de novo (o Firebase quebra), por isso o try
      const safeStop = () => { const s = stop; stop = () => {}; try { s(); } catch (e) { warn('escuta', e); } };
      const subscribe = () => {
        safeStop();
        if (isFb()) {
          stop = fb.db.collection('pedidos').where('criadoEm', '>=', since).orderBy('criadoEm', 'desc').limit(1500)
            .onSnapshot({ includeMetadataChanges: true }, s => {
              last = { aoVivo: !s.metadata.fromCache, em: Date.now() };
              cb(docs(s), last);
            }, e => { stop = () => {}; last = { aoVivo: false, em: last.em }; onError(e); });
        } else {
          stop = localWatch(() => cb(Object.values(local.col('pedidos')).filter(o => o.criadoEm >= since).sort((a, b) => b.criadoEm - a.criadoEm), { aoVivo: true, em: Date.now() }));
        }
      };
      // Celular em segundo plano perde a conexão: ao voltar para a tela, busca tudo de novo no banco
      // Vários avisos juntos (voltou para a tela + internet voltou) viram uma busca só
      let resyncTimer;
      const resync = () => { clearTimeout(resyncTimer); resyncTimer = setTimeout(() => { if (isFb()) subscribe(); }, 800); };
      const onVisible = () => { if (document.visibilityState === 'visible') resync(); };
      const timer = setInterval(() => { if (!last.aoVivo) resync(); }, 30000);
      ready.then(() => {
        subscribe();
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('online', resync);
      });
      api.resync = resync;
      return () => { safeStop(); clearInterval(timer); clearTimeout(resyncTimer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('online', resync); };
    },
    // Pedidos de teste de qualquer data (nome do cliente começando com "TESTE")
    async findTestOrders() {
      await ready;
      if (isFb()) {
        const s = await fb.db.collection('pedidos').where('cliente.nome', '>=', 'TESTE').where('cliente.nome', '<', 'TESTF').limit(1000).get();
        return docs(s);
      }
      return Object.values(local.col('pedidos')).filter(o => /^TESTE/.test(o.cliente?.nome || ''));
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
    // Configuração ao vivo: mudou num aparelho, todos os outros recebem na hora
    watchConfig(name, cb) {
      let stop = () => {};
      ready.then(() => {
        if (isFb()) stop = fb.db.collection('config').doc(name).onSnapshot(d => cb(d.exists ? d.data() : {}), warn);
        else {
          let last;
          stop = localWatch(() => { const v = local.col('config')[name] || {}; const s = JSON.stringify(v); if (s !== last) { last = s; cb(v); } });
        }
      });
      return () => stop();
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
        if (isFb()) fb.auth.onAuthStateChanged(u => cb(u ? { email: u.email, nome: u.displayName || '', uid: u.uid } : null));
        else cb({ email: 'modo demonstração', demo: true, staff: true });
      });
    },
    // Só quem tem documento em /equipe/{uid} vê os pedidos
    async isStaff(uid) {
      await ready;
      if (!isFb()) return true;
      try { return (await fb.db.collection('equipe').doc(uid).get()).exists; } catch { return false; }
    },
    async signIn(email, pass) { await ready; if (isFb()) return fb.auth.signInWithEmailAndPassword(email, pass); },
    async signInGoogle() {
      await ready;
      if (!isFb()) return;
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      // Só janela (popup): o login por redirecionamento não funciona em site do GitHub Pages
      return fb.auth.signInWithPopup(provider);
    },
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
