// ===== Gestão Baldini =====
(() => {
  const Core = window.BaldiniCore;
  const DB = window.BaldiniDB;
  const MENU = window.MENU || [];
  // Site de pedidos: de lá vêm o cardápio e as fotos, e é para lá que o cliente volta depois de pagar
  const SITE = 'https://galdinoheitor15-star.github.io/baldini-burguer/';
  const siteImg = src => (src && !/^https?:/.test(src) ? SITE + src : src);
  const { brl, esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) } = Core;
  const $ = id => document.getElementById(id);
  const num = v => Number(String(v ?? '').replace(/\./g, '').replace(',', '.')) || 0;
  const money = v => (Number(v) || 0).toFixed(2).replace('.', ',');
  const products = new Map();
  MENU.forEach(c => c.items.forEach(p => products.set(p.id, { ...p, cat: c.id })));

  const state = {
    orders: [], expenses: [], tab: 'pedidos', period: 'hoje',
    cfg: { loja: {}, custos: {}, mensagens: {}, nf: {} },
    seen: new Set(), firstLoad: true, sound: localGet('gestao-som', true)
  };
  function localGet(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } }
  function localSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem armazenamento */ } }

  // ---------- Avisos ----------
  let toastTimer;
  function toast(text, bad) {
    const t = $('toast');
    t.textContent = text; t.classList.toggle('is-bad', !!bad); t.classList.add('is-on');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('is-on'), 2600);
  }
  // Toda ação no banco passa por aqui: erro vira aviso, a tela nunca trava
  async function safe(label, fn) {
    try { return await fn(); } catch (e) { console.error(label, e); toast(`${label}: ${e.message || e}`, true); }
  }
  function beep() {
    if (!state.sound) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.25].forEach(t => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.25, ctx.currentTime + t); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.2);
        o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.22);
      });
    } catch { /* sem áudio */ }
  }

  // ---------- Datas ----------
  const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const ago = ms => {
    const m = Math.round((Date.now() - ms) / 60000);
    return m < 1 ? 'agora' : m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
  };
  const hhmm = ms => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  function periodRange(p) {
    const now = new Date();
    if (p === '7d') return [startOfDay() - 6 * 864e5, Infinity];
    if (p === 'mes') return [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), Infinity];
    if (p === 'mesPassado') return [new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(), new Date(now.getFullYear(), now.getMonth(), 1).getTime()];
    return [startOfDay(), Infinity];
  }

  // ---------- Login ----------
  DB.onAuth(user => {
    $('login').hidden = !!user;
    $('app').hidden = !user;
    if (user) start(user);
  });
  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target.elements;
    $('loginError').hidden = true;
    try { await DB.signIn(f.email.value.trim(), f.senha.value); }
    catch (err) { $('loginError').textContent = 'Não foi possível entrar: confira e-mail e senha.'; $('loginError').hidden = false; console.warn(err); }
  });
  $('logoutBtn').addEventListener('click', () => DB.signOut().then(() => location.reload()));

  let started = false;
  function start(user) {
    if (started) return; started = true;
    $('modeBadge').textContent = DB.mode === 'firebase' ? `🟢 Online · ${user.email}` : '🟡 Modo demonstração (configure o Firebase)';
    $('modeBadge').classList.toggle('is-warn', DB.mode !== 'firebase');
    $('soundBtn').classList.toggle('is-off', !state.sound);
    loadConfig().then(() => { renderConfig(); renderCosts(); renderMsgs(); });
    const now = new Date();
    const since = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
    DB.watchOrders(since, list => { onOrders(list); }, e => toast('Sem conexão com os pedidos: ' + e.message, true));
    DB.watchExpenses(list => { state.expenses = list; if (state.tab === 'lucro') renderProfit(); });
    renderPos();
    setInterval(() => { if (state.tab === 'pedidos') renderBoard(); }, 30000);
    runHealth();
  }
  $('soundBtn').addEventListener('click', () => {
    state.sound = !state.sound; localSet('gestao-som', state.sound);
    $('soundBtn').classList.toggle('is-off', !state.sound);
    if (state.sound) beep();
  });

  async function loadConfig() {
    const [loja, custos, mensagens, nf] = await Promise.all(['loja', 'custos', 'mensagens', 'nf'].map(n => DB.getConfig(n).catch(() => ({}))));
    state.cfg = { loja: loja || {}, custos: custos || {}, mensagens: mensagens || {}, nf: nf || {} };
  }
  const taxas = () => ({ ...Core.DEFAULT_TAXAS, ...(state.cfg.loja.taxas || {}) });

  // ---------- Abas ----------
  $('tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    state.tab = b.dataset.tab;
    document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('is-on', x === b));
    document.querySelectorAll('.view').forEach(v => { v.hidden = v.id !== 'view-' + state.tab; });
    renderTab();
  });
  function renderTab() {
    if (state.tab === 'pedidos') renderBoard();
    if (state.tab === 'entregas') renderDeliveries();
    if (state.tab === 'lucro') renderProfit();
    if (state.tab === 'nf') renderNf();
  }

  // ---------- Pedidos ao vivo ----------
  function onOrders(list) {
    const fresh = list.filter(o => o.status === 'novo' && !state.seen.has(o.id));
    if (!state.firstLoad && fresh.length) { beep(); toast(`🔔 ${fresh.length > 1 ? fresh.length + ' novos pedidos' : 'Novo pedido ' + Core.shortCode(fresh[0].id)}`); }
    list.forEach(o => { if (o.status !== 'montando') state.seen.add(o.id); });
    state.firstLoad = false;
    state.orders = list;
    const active = list.filter(o => ['novo', 'preparo', 'pronto', 'entrega'].includes(o.status)).length;
    $('tabCount').textContent = active || '';
    document.title = active ? `(${active}) Gestão Baldini` : 'Gestão Baldini';
    checkPayments(list);
    renderTab();
    if ($('orderModal').open && openId) renderOrderModal(openId);
  }

  const COLS = ['montando', 'novo', 'preparo', 'pronto', 'entrega'];
  function isLiveDraft(o) { return o.status === 'montando' && (o.itens || []).length && Date.now() - (o.atualizadoEm || o.criadoEm) < 3 * 36e5; }
  function itemsSummary(o) { return (o.itens || []).map(l => `${l.qty}x ${l.name}`).join(', '); }
  function payBadge(o) {
    if (o.pagamento?.pago) return `<span class="tag tag--ok">Pago · ${esc(o.pagamento.metodo || o.pagamento.forma)}</span>`;
    return `<span class="tag">${esc(o.pagamento?.forma || 'Pix')}${o.pagamento?.troco ? ' · troco ' + esc(o.pagamento.troco) : ''}</span>`;
  }
  const origemTag = o => ({ site: '🌐 Site', balcao: '🏪 Balcão', whatsapp: '💬 WhatsApp', ifood: '🛵 iFood' }[o.origem] || o.origem);

  function orderCard(o) {
    const next = Core.nextStatus(o);
    const live = o.status === 'montando';
    return `<article class="ocard${live ? ' ocard--live' : ''}" data-id="${esc(o.id)}">
      <header><b>${esc(Core.shortCode(o.id))}</b><span class="muted">${origemTag(o)} · ${ago(o.criadoEm)}</span></header>
      <p class="ocard__who">${esc(o.cliente?.nome || (live ? 'Cliente escolhendo...' : 'Sem nome'))}${o.entrega?.bairro ? ` · ${esc(o.entrega.bairro)}` : ''}</p>
      <p class="ocard__items">${esc(itemsSummary(o))}</p>
      <footer>
        <strong>${brl(o.total)}</strong>${live ? '<span class="tag tag--live">ao vivo</span>' : payBadge(o)}
      </footer>
      ${live ? '' : `<div class="ocard__acts">
        ${next ? `<button type="button" class="btn btn--sm btn--yellow" data-act="next">${Core.statusInfo(next).icon} ${Core.statusInfo(next).label}</button>` : ''}
        <button type="button" class="btn btn--sm btn--ghost" data-act="whats" title="Avisar cliente no WhatsApp">💬</button>
        <button type="button" class="btn btn--sm btn--ghost" data-act="print" title="Imprimir comanda">🖨</button>
      </div>`}
    </article>`;
  }
  function renderBoard() {
    const byCol = Object.fromEntries(COLS.map(c => [c, []]));
    state.orders.forEach(o => {
      if (o.status === 'montando' && !isLiveDraft(o)) return;
      if (byCol[o.status]) byCol[o.status].push(o);
    });
    COLS.forEach(c => byCol[c].sort((a, b) => a.criadoEm - b.criadoEm));
    $('board').innerHTML = COLS.map(c => {
      const s = Core.statusInfo(c);
      return `<section class="col col--${c}"><h3>${s.icon} ${s.label} <em>${byCol[c].length}</em></h3>
        ${byCol[c].map(orderCard).join('') || `<p class="muted small">${c === 'montando' ? 'Ninguém montando sacola agora.' : 'Nada aqui.'}</p>`}</section>`;
    }).join('');
    const today = startOfDay();
    const done = state.orders.filter(o => ['concluido', 'cancelado'].includes(o.status) && o.criadoEm >= today);
    $('doneCount').textContent = `(${done.length})`;
    $('doneList').innerHTML = done.map(orderCard).join('') || '<p class="muted small">Nenhum ainda.</p>';
  }
  document.addEventListener('click', e => {
    const card = e.target.closest('.ocard');
    if (!card) return;
    const o = state.orders.find(x => x.id === card.dataset.id);
    if (!o) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'next') return advance(o);
    if (act === 'whats') return notify(o, o.status);
    if (act === 'print') return printOrder(o);
    openOrder(o.id);
  });

  function setStatus(o, status) {
    const hist = [...(o.historico || []), { status, em: Date.now() }].slice(-30);
    return safe('Erro ao mudar status', async () => {
      await DB.updateOrder(o.id, { status, historico: hist });
      if (status === 'concluido' && state.cfg.nf.nfAuto && !o.nf?.chave) emitNf({ ...o, status });
    });
  }
  function advance(o) {
    const next = Core.nextStatus(o);
    if (next) setStatus(o, next);
  }
  function notify(o, status) {
    if (!o.cliente?.telefone) return toast('Pedido sem telefone do cliente', true);
    const tpl = state.cfg.mensagens[status] || Core.MSG[status] || Core.MSG.novo;
    window.open(Core.whatsLink(o.cliente.telefone, Core.fillMsg(tpl, o)), '_blank', 'noopener');
  }

  // ---------- Detalhe do pedido ----------
  let openId = null;
  function openOrder(id) { openId = id; renderOrderModal(id); if (!$('orderModal').open) $('orderModal').showModal(); }
  $('orderModal').addEventListener('close', () => { openId = null; });
  function renderOrderModal(id) {
    const o = state.orders.find(x => x.id === id);
    if (!o) { $('orderModal').close(); return; }
    const d = Core.isDelivery(o);
    $('orderBody').innerHTML = `
      <header class="modal__head"><h2>Pedido ${esc(Core.shortCode(o.id))} <small>${origemTag(o)} · ${hhmm(o.criadoEm)}</small></h2><button type="button" class="icon-btn" data-m="close" aria-label="Fechar">✕</button></header>
      <div class="statusbar">${Core.STATUS.filter(s => s.id !== 'montando').map(s => `<button type="button" class="${o.status === s.id ? 'is-on' : ''}" data-m="status" data-s="${s.id}">${s.icon} ${s.label}</button>`).join('')}</div>
      <div class="grid2">
        <div><h4>Cliente</h4><p>${esc(o.cliente?.nome || '—')}<br>${esc(o.cliente?.telefone || '')}</p></div>
        <div><h4>${d ? 'Entrega' : 'Retirada'}</h4><p>${d ? `${esc(o.entrega.endereco)} - ${esc(o.entrega.bairro)}${o.entrega.referencia ? `<br><i>${esc(o.entrega.referencia)}</i>` : ''}` : esc(o.entrega?.tipo || '')}</p></div>
      </div>
      <ul class="lines">${(o.itens || []).map(l => `<li><b>${l.qty}x ${esc(l.name)}</b><span>${brl(l.unit * l.qty)}</span>
        ${(l.choices || []).map(c => `<small>${esc(c.group)}: ${esc(c.items.map(i => (i.qty > 1 ? i.qty + 'x ' : '') + i.name).join(', '))}</small>`).join('')}
        ${l.note ? `<small><i>Obs: ${esc(l.note)}</i></small>` : ''}</li>`).join('')}</ul>
      ${o.obs ? `<p class="note">📝 ${esc(o.obs)}</p>` : ''}
      ${o.recompensa ? `<p class="note">🎁 Quer trocar pontos por: ${esc(o.recompensa)}</p>` : ''}
      <div class="grid3">
        ${d ? `<label class="field">Taxa de entrega<input data-m="taxa" inputmode="decimal" value="${money(o.entrega?.taxa)}"></label>` : ''}
        <label class="field">Desconto<input data-m="desconto" inputmode="decimal" value="${money(o.desconto)}"></label>
        <div class="total"><span>Total</span><strong>${brl(o.total)}</strong></div>
      </div>
      <h4>Pagamento ${payBadge(o)}</h4>
      <div class="paybox">
        ${o.pagamento?.pago ? `<p class="muted small">Recebido${o.pagamento.transacao ? ' · transação ' + esc(o.pagamento.transacao) : ''}. <button type="button" class="link" data-m="unpay">desfazer</button></p>` : `
        <p class="muted small">Na maquininha: digite <b class="big">${brl(o.total)}</b> e depois marque como foi pago.</p>
        <div class="row">${['Pix', 'Débito', 'Crédito', 'Dinheiro'].map(m => `<button type="button" class="btn btn--sm btn--ghost" data-m="pay" data-p="${m}">✔ ${m}</button>`).join('')}</div>
        <div class="row"><button type="button" class="btn btn--sm btn--yellow" data-m="link">💳 Gerar link InfinitePay</button>
        ${o.pagamento?.link ? `<a class="btn btn--sm btn--ghost" href="${esc(o.pagamento.link)}" target="_blank" rel="noopener">Abrir link</a><button type="button" class="btn btn--sm btn--ghost" data-m="sendlink">💬 Enviar link</button>` : ''}
        ${o.retornoPagamento ? '<button type="button" class="btn btn--sm btn--ghost" data-m="check">🔎 Conferir pagamento</button>' : ''}</div>`}
      </div>
      <h4>Nota fiscal</h4>
      <div class="row">${o.nf?.url ? `<a class="btn btn--sm btn--ghost" href="${esc(o.nf.url)}" target="_blank" rel="noopener">🧾 Ver NFC-e</a>` : `<button type="button" class="btn btn--sm btn--ghost" data-m="nf">🧾 Emitir NFC-e</button>`}<span class="muted small">${esc(o.nf?.status || '')}</span></div>
      <footer class="modal__foot">
        <button type="button" class="btn btn--sm btn--ghost" data-m="print">🖨 Comanda</button>
        <button type="button" class="btn btn--sm btn--ghost" data-m="whats">💬 Avisar cliente</button>
        <button type="button" class="btn btn--sm btn--danger" data-m="delete">Apagar</button>
      </footer>`;
  }
  $('orderBody').addEventListener('click', e => {
    const b = e.target.closest('[data-m]');
    if (!b || b.tagName === 'INPUT') return;
    const o = state.orders.find(x => x.id === openId);
    if (!o) return;
    const m = b.dataset.m;
    if (m === 'close') $('orderModal').close();
    if (m === 'status') setStatus(o, b.dataset.s);
    if (m === 'pay') safe('Erro ao marcar pagamento', () => DB.updateOrder(o.id, { 'pagamento.pago': true, 'pagamento.metodo': b.dataset.p }));
    if (m === 'unpay') safe('Erro', () => DB.updateOrder(o.id, { 'pagamento.pago': false, 'pagamento.metodo': '' }));
    if (m === 'link') makeLink(o);
    if (m === 'sendlink') notify(o, 'pagamento');
    if (m === 'check') checkPayment(o, true);
    if (m === 'nf') emitNf(o);
    if (m === 'print') printOrder(o);
    if (m === 'whats') notify(o, o.status);
    if (m === 'delete' && confirm(`Apagar o pedido ${Core.shortCode(o.id)}? Isso não tem volta.`)) safe('Erro ao apagar', async () => { await DB.deleteOrder(o.id); $('orderModal').close(); });
  });
  $('orderBody').addEventListener('change', e => {
    const m = e.target.dataset.m;
    const o = state.orders.find(x => x.id === openId);
    if (!o || !['taxa', 'desconto'].includes(m)) return;
    const next = { ...o, entrega: { ...o.entrega }, desconto: o.desconto };
    if (m === 'taxa') next.entrega.taxa = num(e.target.value); else next.desconto = num(e.target.value);
    const t = Core.totalsOf(next);
    safe('Erro ao salvar valor', () => DB.updateOrder(o.id, { 'entrega.taxa': next.entrega.taxa, desconto: next.desconto, ...t }));
  });

  // ---------- InfinitePay ----------
  async function makeLink(o) {
    const handle = state.cfg.loja.infinitepayHandle;
    if (!handle) return toast('Cadastre sua InfiniteTag em Configurações', true);
    await safe('Erro ao gerar link', async () => {
      const payload = Core.infinitepayPayload(o, { handle, redirectUrl: SITE + '?pagamento=retorno', webhookUrl: state.cfg.loja.webhookUrl || undefined });
      const res = await fetch('https://api.checkout.infinitepay.io/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error('InfinitePay respondeu ' + res.status);
      const data = await res.json();
      const url = data.url || data.link || data.checkout_url;
      if (!url) throw new Error('resposta sem link');
      await DB.updateOrder(o.id, { 'pagamento.link': url });
      toast('Link criado ✅');
    });
  }
  const checking = new Set();
  async function checkPayment(o, loud) {
    const r = o.retornoPagamento;
    const handle = state.cfg.loja.infinitepayHandle;
    if (!r || !handle || checking.has(o.id)) return;
    checking.add(o.id);
    try {
      const res = await fetch('https://api.checkout.infinitepay.io/payment_check', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle, order_nsu: o.id, transaction_nsu: r.transaction_nsu, slug: r.slug })
      });
      const data = await res.json();
      if (data.paid) {
        await DB.updateOrder(o.id, { 'pagamento.pago': true, 'pagamento.metodo': data.capture_method === 'pix' ? 'Pix (online)' : 'Online', 'pagamento.transacao': r.transaction_nsu || '' });
        toast(`💰 Pagamento confirmado ${Core.shortCode(o.id)}`);
      } else if (loud) toast('Pagamento ainda não aparece como pago', true);
    } catch (e) { if (loud) toast('Não deu para conferir: ' + e.message, true); }
    finally { checking.delete(o.id); }
  }
  function checkPayments(list) { list.filter(o => o.retornoPagamento && !o.pagamento?.pago).forEach(o => checkPayment(o, false)); }

  // ---------- Nota fiscal ----------
  async function emitNf(o) {
    const cnpj = state.cfg.nf.cnpj;
    if (!cnpj) return toast('Preencha o CNPJ em Configurações > Nota fiscal', true);
    if (DB.mode !== 'firebase') return toast('A emissão de NFC-e precisa do Firebase e da função "emitirNfce"', true);
    await safe('Erro na NFC-e', async () => {
      await DB.updateOrder(o.id, { nf: { status: 'enviando...' } });
      const payload = Core.nfcePayload(o, { cnpj, ncm: state.cfg.nf.ncm || undefined, csosn: state.cfg.nf.csosn || undefined });
      const r = await DB.call('emitirNfce', { pedidoId: o.id, payload });
      await DB.updateOrder(o.id, { nf: { status: r.status || 'enviada', chave: r.chave || '', url: r.url || '' } });
      toast('🧾 NFC-e: ' + (r.status || 'enviada'));
    });
  }
  function renderNf() {
    const ready = DB.mode === 'firebase' && state.cfg.nf.cnpj;
    $('nfState').innerHTML = ready ? 'Emissão pela função <b>emitirNfce</b> do Firebase (Focus NFe).' : '⚠️ Ainda não configurado. Falta: ' + [DB.mode !== 'firebase' && 'Firebase', !state.cfg.nf.cnpj && 'CNPJ em Configurações', 'conta num emissor (Focus NFe) com o token na função do Firebase'].filter(Boolean).join(', ') + '.';
    const list = state.orders.filter(Core.countsAsSale).slice(0, 80);
    $('nfList').innerHTML = `<table class="table"><thead><tr><th>Pedido</th><th>Cliente</th><th>Total</th><th>Status NF</th><th></th></tr></thead><tbody>
      ${list.map(o => `<tr><td>${esc(Core.shortCode(o.id))} <small class="muted">${new Date(o.criadoEm).toLocaleDateString('pt-BR')}</small></td><td>${esc(o.cliente?.nome || '—')}</td><td>${brl(o.total)}</td>
        <td>${o.nf?.url ? `<a href="${esc(o.nf.url)}" target="_blank" rel="noopener">${esc(o.nf.status || 'emitida')}</a>` : esc(o.nf?.status || '—')}</td>
        <td>${o.nf?.chave ? '' : `<button type="button" class="btn btn--sm btn--ghost" data-nf="${esc(o.id)}">Emitir</button>`}</td></tr>`).join('')}
    </tbody></table>`;
  }
  $('nfList').addEventListener('click', e => {
    const id = e.target.closest('[data-nf]')?.dataset.nf;
    const o = id && state.orders.find(x => x.id === id);
    if (o) emitNf(o);
  });

  // ---------- Comanda ----------
  function printOrder(o) {
    $('printArea').innerHTML = `<h1>BALDINI BURGUER</h1><h2>${esc(Core.shortCode(o.id))} · ${hhmm(o.criadoEm)}</h2>
      <p>${esc(o.cliente?.nome || '')} ${esc(o.cliente?.telefone || '')}</p>
      <p>${Core.isDelivery(o) ? `ENTREGA: ${esc(o.entrega.endereco)} - ${esc(o.entrega.bairro)} ${esc(o.entrega.referencia || '')}` : esc(o.entrega?.tipo || '')}</p><hr>
      ${(o.itens || []).map(l => `<p><b>${l.qty}x ${esc(l.name)}</b> ${brl(l.unit * l.qty)}<br>${(l.choices || []).map(c => `&nbsp;- ${esc(c.group)}: ${esc(c.items.map(i => (i.qty > 1 ? i.qty + 'x ' : '') + i.name).join(', '))}`).join('<br>')}${l.note ? `<br>&nbsp;OBS: ${esc(l.note)}` : ''}</p>`).join('')}
      <hr>${o.obs ? `<p>OBS: ${esc(o.obs)}</p>` : ''}<p>Subtotal ${brl(o.subtotal)}${o.taxa ? ` · Entrega ${brl(o.taxa)}` : ''}${o.desconto ? ` · Desc. ${brl(o.desconto)}` : ''}</p>
      <h2>TOTAL ${brl(o.total)}</h2><p>${esc(o.pagamento?.forma || '')}${o.pagamento?.troco ? ' · troco p/ ' + esc(o.pagamento.troco) : ''}${o.pagamento?.pago ? ' · PAGO' : ''}</p>`;
    window.print();
  }

  // ---------- Lançar pedido (balcão / telefone) ----------
  let posCart = [];
  let posCat = MENU[0]?.id;
  function renderPos() {
    $('posCats').innerHTML = MENU.map(c => `<button type="button" data-cat="${c.id}" class="${c.id === posCat ? 'is-on' : ''}">${esc(c.name)}</button>`).join('');
    const q = Core.norm($('posSearch').value);
    const items = q ? [...products.values()].filter(p => Core.norm(p.name).includes(q)) : (MENU.find(c => c.id === posCat)?.items || []);
    $('posGrid').innerHTML = items.map(p => `<button type="button" class="pitem" data-p="${p.id}">${p.img ? `<img src="${siteImg(p.img)}" alt="" loading="lazy">` : '<span>🍔</span>'}<b>${esc(p.name)}</b><small>${brl(p.price || Math.min(...(p.groups?.[0]?.options || [{ price: 0 }]).map(o => o.price)))}</small></button>`).join('');
    renderPosCart();
  }
  $('posCats').addEventListener('click', e => { const b = e.target.closest('[data-cat]'); if (b) { posCat = b.dataset.cat; $('posSearch').value = ''; renderPos(); } });
  $('posSearch').addEventListener('input', renderPos);
  $('posGrid').addEventListener('click', e => { const b = e.target.closest('[data-p]'); if (b) pickProduct(products.get(b.dataset.p)); });

  let pick = null;
  function pickProduct(p) {
    if (!p.groups?.length) return addPosLine({ id: p.id, name: p.name, img: p.img, unit: p.price, qty: 1, choices: [], note: '' });
    pick = { p, sel: p.groups.map(g => (g.type === 'single' && g.options.length === 1 ? { 0: 1 } : {})), qty: 1 };
    renderPick();
    $('pickModal').showModal();
  }
  function renderPick() {
    const { p, sel } = pick;
    const unit = Core.unitPrice(p, sel);
    $('pickBody').innerHTML = `<header class="modal__head"><h2>${esc(p.name)}</h2><button type="button" class="icon-btn" data-k="close" aria-label="Fechar">✕</button></header>
      ${p.groups.map((g, gi) => `<fieldset class="pg"><legend>${esc(g.name)} <small>${g.min ? 'obrigatório' : 'opcional'} · até ${g.max}</small></legend>
        ${g.options.map((o, oi) => { const q = sel[gi][oi] || 0; return `<div class="po${q ? ' is-on' : ''}"><span>${esc(o.name.replace(/\s*\(extra\)/i, ''))}${o.price ? ` <small>+${brl(o.price)}</small>` : ''}</span>
          <span class="qty"><button type="button" data-k="opt" data-g="${gi}" data-o="${oi}" data-d="-1">−</button><b>${q}</b><button type="button" data-k="opt" data-g="${gi}" data-o="${oi}" data-d="1">+</button></span></div>`; }).join('')}</fieldset>`).join('')}
      <label class="field">Observação<input id="pickNote" maxlength="140" value="${esc(pick.note || '')}"></label>
      <footer class="modal__foot"><span class="qty"><button type="button" data-k="qty" data-d="-1">−</button><b>${pick.qty}</b><button type="button" data-k="qty" data-d="1">+</button></span>
        <button type="button" class="btn btn--yellow" data-k="add">Adicionar ${brl(unit * pick.qty)}</button></footer>`;
  }
  $('pickBody').addEventListener('input', e => { if (e.target.id === 'pickNote') pick.note = e.target.value; });
  $('pickBody').addEventListener('click', e => {
    const b = e.target.closest('[data-k]');
    if (!b) return;
    const k = b.dataset.k;
    if (k === 'close') return $('pickModal').close();
    if (k === 'qty') { pick.qty = Math.max(1, Math.min(20, pick.qty + +b.dataset.d)); return renderPick(); }
    if (k === 'opt') {
      const g = pick.p.groups[+b.dataset.g], s = pick.sel[+b.dataset.g], oi = +b.dataset.o, d = +b.dataset.d;
      const count = Object.values(s).reduce((a, q) => a + q, 0);
      if (g.type === 'single') { Object.keys(s).forEach(x => delete s[x]); if (d > 0) s[oi] = 1; }
      else if (d > 0 && count >= g.max) return toast(`Máximo de ${g.max}`, true);
      else { const q = (s[oi] || 0) + d; if (q <= 0) delete s[oi]; else s[oi] = g.type === 'multi' ? 1 : q; }
      return renderPick();
    }
    if (k === 'add') {
      const miss = Core.missingGroup(pick.p, pick.sel);
      if (miss >= 0) return toast('Escolha: ' + pick.p.groups[miss].name, true);
      const choices = pick.p.groups.map((g, gi) => ({ group: g.name.replace(/\s+\?/, '?'), items: Object.entries(pick.sel[gi]).map(([oi, q]) => ({ name: g.options[oi].name.replace(/\s*\(extra\)/i, ''), qty: q, price: g.options[oi].price })) })).filter(c => c.items.length);
      addPosLine({ id: pick.p.id, name: pick.p.name, img: pick.p.img, unit: Core.unitPrice(pick.p, pick.sel), qty: pick.qty, choices, note: (pick.note || '').trim() });
      $('pickModal').close();
    }
  });
  function addPosLine(l) { posCart.push(l); renderPosCart(); toast(`${l.qty}x ${l.name} adicionado`); }
  function posOrder() {
    const f = $('posForm').elements;
    return Core.sanitizeOrder({
      id: Core.newOrderId(), origem: f.origem.value, status: 'novo', itens: posCart,
      cliente: { nome: f.nome.value.trim(), telefone: f.telefone.value.trim() },
      entrega: { tipo: f.entrega.value, endereco: f.endereco.value.trim(), bairro: f.bairro.value.trim(), referencia: f.referencia.value.trim(), taxa: num(f.taxa.value) },
      pagamento: { forma: f.pagamento.value, pago: f.pago.checked, metodo: f.pago.checked ? f.pagamento.value : '' },
      desconto: num(f.desconto.value), obs: f.obs.value.trim(), criadoEm: Date.now(), historico: [{ status: 'novo', em: Date.now() }]
    });
  }
  function renderPosCart() {
    $('posEmpty').hidden = posCart.length > 0;
    $('posLines').innerHTML = posCart.map((l, i) => `<li><b>${l.qty}x ${esc(l.name)}</b><span>${brl(l.unit * l.qty)} <button type="button" class="link" data-rm="${i}" aria-label="Remover">✕</button></span>
      ${l.choices.map(c => `<small>${esc(c.group)}: ${esc(c.items.map(i2 => (i2.qty > 1 ? i2.qty + 'x ' : '') + i2.name).join(', '))}</small>`).join('')}${l.note ? `<small><i>${esc(l.note)}</i></small>` : ''}</li>`).join('');
    const total = brl(posOrder().total);
    $('posTotal').textContent = total;
    $('posBar').hidden = !posCart.length;
    const qty = posCart.reduce((s, l) => s + l.qty, 0);
    $('posBarCount').textContent = qty;
    $('posBarLabel').textContent = qty === 1 ? 'item' : 'itens';
    $('posBarTotal').textContent = total;
    $('posAddr').hidden = $('posForm').elements.entrega.value !== 'Delivery';
  }
  $('posBar').addEventListener('click', () => $('posForm').scrollIntoView({ block: 'start' }));
  $('posLines').addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) { posCart.splice(+b.dataset.rm, 1); renderPosCart(); } });
  $('posForm').addEventListener('input', renderPosCart);
  $('posForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target.elements;
    const err = !posCart.length ? 'Adicione pelo menos um item.' : (f.entrega.value === 'Delivery' && (!f.endereco.value.trim() || !f.bairro.value.trim())) ? 'Para delivery, preencha endereço e bairro.' : '';
    $('posError').textContent = err; $('posError').hidden = !err;
    if (err) return;
    const o = posOrder();
    await safe('Erro ao lançar', async () => {
      await DB.saveOrder(o);
      state.seen.add(o.id);
      posCart = []; e.target.reset(); renderPosCart();
      toast(`Pedido ${Core.shortCode(o.id)} lançado ✅`);
    });
  });

  // ---------- Entregadores (iFood) ----------
  let map, markers = [];
  function renderDeliveries() {
    const out = state.orders.filter(o => o.status === 'entrega');
    $('deliveryList').innerHTML = out.map(o => `<div class="drow"><b>${esc(Core.shortCode(o.id))}</b> ${esc(o.cliente?.nome || '')} · ${esc(o.entrega?.bairro || '')}
      <small class="muted">${o.entregador?.lat ? `📍 atualizado ${ago(o.entregador.em)}${o.entregador.nome ? ' · ' + esc(o.entregador.nome) : ''}` : o.origem === 'ifood' ? 'aguardando posição do iFood' : 'entregador próprio (sem rastreio)'}</small></div>`).join('') || '<p class="muted small">Nenhum pedido em entrega.</p>';
    $('ifoodState').textContent = state.cfg.loja.ifoodAtivo ? 'iFood ligado: pedidos e posições chegam pela função "ifoodSync" do Firebase, a cada minuto.' : 'iFood desligado. Ligue em Configurações depois de cadastrar as credenciais do Portal do Parceiro na função do Firebase.';
    if (!window.L) return;
    if (!map) {
      map = L.map('map').setView([-7.8506, -35.2546], 14);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
      L.marker([-7.8506, -35.2546]).addTo(map).bindPopup('Baldini Burguer');
    }
    setTimeout(() => map.invalidateSize(), 50);
    markers.forEach(m => m.remove());
    markers = out.filter(o => o.entregador?.lat).map(o => L.marker([o.entregador.lat, o.entregador.lng]).addTo(map).bindPopup(`🛵 ${esc(Core.shortCode(o.id))} ${esc(o.cliente?.nome || '')}`));
    if (markers.length) map.fitBounds(L.featureGroup(markers).getBounds().pad(0.3));
  }

  // ---------- Lucro ----------
  $('periodSeg').addEventListener('click', e => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    state.period = b.dataset.p;
    $('periodSeg').querySelectorAll('button').forEach(x => x.classList.toggle('is-on', x === b));
    renderProfit();
  });
  function renderProfit() {
    const [from, to] = periodRange(state.period);
    const r = Core.profitReport(state.orders, { custos: state.cfg.custos, taxas: taxas(), despesas: state.expenses, from, to, custoEntrega: num(state.cfg.loja.custoEntrega) });
    const k = (label, v, cls = '') => `<div class="kpi ${cls}"><span>${label}</span><strong>${v}</strong></div>`;
    $('kpis').innerHTML = k('Faturamento', brl(r.faturamento)) + k('Pedidos', r.pedidos) + k('Ticket médio', brl(r.ticketMedio)) +
      k('Custo dos produtos', brl(r.custoProdutos), 'neg') + k('Taxas (maquininha/iFood)', brl(r.taxas), 'neg') + k('Entregas', brl(r.entregas), 'neg') +
      k('Despesas', brl(r.despesas), 'neg') + k(`Lucro · ${r.margem.toLocaleString('pt-BR')}%`, brl(r.lucro), r.lucro >= 0 ? 'pos' : 'neg');
    // Barras por dia
    const days = [];
    const start = from, end = Math.min(to, startOfDay() + 864e5);
    for (let t = start; t < end; t += 864e5) days.push(new Date(t).toISOString().slice(0, 10));
    const max = Math.max(1, ...days.map(d => r.porDia[d] || 0));
    $('chart').innerHTML = days.length <= 1 ? `<p class="big">${brl(r.faturamento)}</p><p class="muted small">${Object.entries(r.porPagamento).map(([p, v]) => `${p}: ${brl(v)}`).join(' · ') || 'Sem vendas no período.'}</p>` :
      `<div class="bars">${days.map(d => `<div class="bar" title="${d.split('-').reverse().join('/')}: ${brl(r.porDia[d] || 0)}"><i style="height:${((r.porDia[d] || 0) / max * 100).toFixed(1)}%"></i><small>${d.slice(8)}</small></div>`).join('')}</div>
       <p class="muted small">${Object.entries(r.porPagamento).map(([p, v]) => `${p}: ${brl(v)}`).join(' · ')}</p>`;
    const top = Object.values(r.porProduto).sort((a, b) => b.qtd - a.qtd).slice(0, 10);
    $('topProducts').innerHTML = top.length ? `<table class="table"><tbody>${top.map(p => `<tr><td>${esc(p.nome)}</td><td>${p.qtd}x</td><td>${brl(p.valor)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted small">Sem vendas no período.</p>';
    $('expenseList').innerHTML = state.expenses.filter(d => d.data >= from && d.data < to).map(d => `<div class="drow"><span>${new Date(d.data).toLocaleDateString('pt-BR')} · ${esc(d.desc)}</span><span>${brl(d.valor)} <button type="button" class="link" data-rmx="${esc(d.id)}" aria-label="Remover">✕</button></span></div>`).join('') || '<p class="muted small">Nenhuma despesa no período.</p>';
  }
  $('expenseForm').elements.data.valueAsDate = new Date();
  $('expenseForm').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target.elements;
    const [y, m, d] = f.data.value.split('-').map(Number);
    const item = { desc: f.desc.value.trim(), valor: num(f.valor.value), data: new Date(y, m - 1, d, 12).getTime() };
    if (!item.desc || item.valor <= 0) return toast('Preencha descrição e valor', true);
    safe('Erro ao salvar despesa', async () => { await DB.addExpense(item); f.desc.value = ''; f.valor.value = ''; toast('Despesa salva'); });
  });
  $('expenseList').addEventListener('click', e => { const id = e.target.closest('[data-rmx]')?.dataset.rmx; if (id && confirm('Remover despesa?')) safe('Erro', () => DB.deleteExpense(id)); });

  function renderCosts() {
    const c = state.cfg.custos;
    const extras = new Set();
    MENU.forEach(cat => cat.items.forEach(p => (p.groups || []).forEach(g => { if (/adicional/i.test(g.name)) g.options.forEach(o => extras.add(o.name.replace(/\s*\(extra\)/i, ''))); })));
    $('costList').innerHTML = MENU.map(cat => `<h4>${esc(cat.name)}</h4>${cat.items.map(p => `<label class="crow"><span>${esc(p.name)} <small class="muted">${p.price ? brl(p.price) : ''}</small></span><input data-cost="${p.id}" inputmode="decimal" placeholder="0,00" value="${c[p.id] ? money(c[p.id]) : ''}"></label>`).join('')}`).join('') +
      `<h4>Adicionais</h4>${[...extras].map(n => `<label class="crow"><span>${esc(n)}</span><input data-cost="opt:${esc(n)}" inputmode="decimal" placeholder="0,00" value="${c['opt:' + n] ? money(c['opt:' + n]) : ''}"></label>`).join('')}`;
  }
  $('saveCosts').addEventListener('click', () => {
    const custos = {};
    $('costList').querySelectorAll('[data-cost]').forEach(i => { const v = num(i.value); if (v > 0) custos[i.dataset.cost] = v; });
    safe('Erro ao salvar custos', async () => { await DB.setConfig('custos', custos); state.cfg.custos = custos; toast('Custos salvos ✅'); renderProfit(); });
  });

  // ---------- Bot e mensagens ----------
  const MSG_LABELS = { novo: 'Pedido recebido', preparo: 'Em preparo', pronto: 'Pronto', entrega: 'Saiu para entrega', concluido: 'Concluído', cancelado: 'Cancelado', pagamento: 'Link de pagamento' };
  function renderMsgs() {
    $('msgForm').innerHTML = Object.entries(MSG_LABELS).map(([k, label]) => `<label class="field">${label}<textarea name="${k}" rows="2" maxlength="400">${esc(state.cfg.mensagens[k] || Core.MSG[k])}</textarea></label>`).join('');
  }
  $('saveMsgs').addEventListener('click', () => {
    const data = {};
    [...$('msgForm').elements].forEach(t => { if (t.name) data[t.name] = t.value.trim(); });
    safe('Erro ao salvar mensagens', async () => { await DB.setConfig('mensagens', data); state.cfg.mensagens = data; toast('Mensagens salvas ✅'); });
  });
  $('botTest').addEventListener('submit', e => {
    e.preventDefault();
    const q = e.target.elements.q.value.trim();
    if (!q) return;
    const r = Core.botReply(q, { menu: MENU });
    $('botPreview').insertAdjacentHTML('afterbegin', `<div class="bot-turn"><p class="me">${esc(q)}</p><p class="bot">${esc(r.text)}</p>${(r.actions || []).length ? `<p class="muted small">Botões: ${r.actions.map(a => esc(a.label)).join(' · ')}</p>` : ''}</div>`);
    e.target.reset();
  });

  // ---------- Configurações ----------
  function renderConfig() {
    const f = $('configForm').elements, l = state.cfg.loja, nf = state.cfg.nf;
    $('feeFields').innerHTML = Object.entries(taxas()).map(([k, v]) => `<label class="field">${k}<input data-fee="${k}" inputmode="decimal" value="${String(v).replace('.', ',')}"></label>`).join('');
    f.infinitepayHandle.value = l.infinitepayHandle || '';
    f.pagamentoOnline.checked = !!l.pagamentoOnline;
    f.webhookUrl.value = l.webhookUrl || '';
    f.custoEntrega.value = l.custoEntrega ? money(l.custoEntrega) : '';
    f.ifoodAtivo.checked = !!l.ifoodAtivo;
    f.cnpj.value = nf.cnpj || ''; f.ncm.value = nf.ncm || ''; f.csosn.value = nf.csosn || ''; f.nfAuto.checked = !!nf.nfAuto;
  }
  $('configForm').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target.elements;
    const fees = {};
    $('feeFields').querySelectorAll('[data-fee]').forEach(i => { fees[i.dataset.fee] = num(i.value); });
    const loja = { infinitepayHandle: f.infinitepayHandle.value.trim().replace(/^\$/, ''), pagamentoOnline: f.pagamentoOnline.checked, webhookUrl: f.webhookUrl.value.trim(), custoEntrega: num(f.custoEntrega.value), ifoodAtivo: f.ifoodAtivo.checked, taxas: fees };
    const nf = { cnpj: f.cnpj.value.trim(), ncm: f.ncm.value.trim(), csosn: f.csosn.value.trim(), nfAuto: f.nfAuto.checked };
    if (loja.pagamentoOnline && !loja.infinitepayHandle) return toast('Para pagar online, preencha a InfiniteTag', true);
    safe('Erro ao salvar', async () => {
      await Promise.all([DB.setConfig('loja', loja), DB.setConfig('nf', nf)]);
      state.cfg.loja = loja; state.cfg.nf = nf;
      toast('Configurações salvas ✅');
    });
  });

  // ---------- Saúde do sistema ----------
  async function runHealth() {
    const items = [];
    const add = (ok, text) => items.push(`<li class="${ok === true ? 'ok' : ok === false ? 'bad' : 'warn'}">${ok === true ? '✅' : ok === false ? '❌' : '⚠️'} ${text}</li>`);
    add(DB.mode === 'firebase' ? true : null, DB.mode === 'firebase' ? 'Banco de dados Firebase conectado' : 'Modo demonstração: pedidos só ficam neste navegador. Configure o Firebase.');
    add(navigator.onLine, navigator.onLine ? 'Internet ok' : 'Sem internet: os pedidos aparecem quando a conexão voltar');
    add(MENU.length > 0, MENU.length ? `Cardápio do site carregado (${products.size} produtos)` : 'Cardápio do site não carregou: confira se o site de pedidos está no ar');
    try {
      const t0 = performance.now();
      const res = await fetch(SITE, { cache: 'no-store' });
      add(res.ok, `Site de pedidos no ar (${Math.round(performance.now() - t0)} ms)`);
    } catch { add(false, 'Site de pedidos não respondeu'); }
    const last = state.orders.find(o => o.status !== 'montando');
    add(last ? true : null, last ? `Último pedido ${Core.shortCode(last.id)} há ${ago(last.criadoEm)}` : 'Nenhum pedido registrado ainda');
    add(state.cfg.loja.infinitepayHandle ? true : null, state.cfg.loja.infinitepayHandle ? `InfinitePay: $${esc(state.cfg.loja.infinitepayHandle)}` : 'InfinitePay sem InfiniteTag');
    add(state.cfg.nf.cnpj && DB.mode === 'firebase' ? true : null, state.cfg.nf.cnpj ? 'Nota fiscal: CNPJ cadastrado' : 'Nota fiscal ainda não configurada');
    $('health').innerHTML = items.join('');
  }
  $('runHealth').addEventListener('click', runHealth);
  window.addEventListener('online', () => toast('Conexão de volta ✅'));
  window.addEventListener('offline', () => toast('Sem internet: continue, os dados sincronizam depois', true));
})();
