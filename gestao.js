// ===== Gestão Baldini =====
// Sem zoom de pinça no iPhone (o Safari ignora o user-scalable=no)
document.addEventListener('gesturestart', e => e.preventDefault());
(() => {
  const Core = window.BaldiniCore;
  const DB = window.BaldiniDB;
  // Cardápio do site + ajustes feitos na aba Cardápio (preços, produtos novos e escondidos)
  const BASE_MENU = window.MENU || [];
  const Cardapio = window.BaldiniCardapio;
  const MENU = [];
  let menuFull = [];
  // Site de pedidos: de lá vêm o cardápio e as fotos, e é para lá que o cliente volta depois de pagar
  const SITE = 'https://galdinoheitor15-star.github.io/baldini-burguer/';
  const siteImg = src => (src && !/^https?:/.test(src) ? SITE + src : src);
  const { brl, esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) } = Core;
  const $ = id => document.getElementById(id);
  // Usuário sem @ vira um e-mail interno da equipe (o Firebase só aceita login por e-mail)
  const DOMINIO_EQUIPE = '@equipe.baldiniburguer.com';
  const toLogin = u => { u = String(u || '').trim().toLowerCase(); return u.includes('@') ? u : u + DOMINIO_EQUIPE; };
  // Aceita "R$ 1.234,56", "3,15" ou "12"
  const num = v => Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.')) || 0;
  const money = v => (window.BaldiniMask ? BaldiniMask.format('money', Math.round((Number(v) || 0) * 100)) : (Number(v) || 0).toFixed(2).replace('.', ','));
  const products = new Map();
  function applyMenu(aj) {
    menuFull = Cardapio ? Cardapio.aplicar(BASE_MENU, aj, { manterOcultos: true }) : JSON.parse(JSON.stringify(BASE_MENU));
    MENU.splice(0, MENU.length, ...menuFull.map(c => ({ ...c, items: c.items.filter(p => !p.oculto) })).filter(c => c.items.length));
    products.clear();
    menuFull.forEach(c => c.items.forEach(p => products.set(p.id, { ...p, cat: c.id })));
  }
  applyMenu(Cardapio?.guardado() || {});

  const state = {
    orders: [], expenses: [], team: [], tab: 'pedidos', period: 'hoje', caixaPeriod: 'hoje',
    cfg: { loja: {}, custos: {}, mensagens: {}, nf: {}, estoque: {}, cardapio: Cardapio?.guardado() || {} },
    cargo: 'funcionario', cargoReal: 'funcionario', contaSeen: new Set(), firstContas: true,
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
  function show(screen) { ['connecting', 'login', 'pending', 'app'].forEach(id => { $(id).hidden = id !== screen; }); }
  // Enquanto o banco não carrega, mostra "Conectando" (nunca os pedidos guardados só no aparelho)
  DB.onStatus(s => {
    if (!s.conectando) return;
    $('connectingInfo').textContent = s.tentativas ? `Internet lenta. Tentando de novo (${s.tentativas}ª vez)...` : 'Carregando os pedidos...';
  });
  let current = null;
  async function checkAccess(user) {
    current = user;
    if (!user) return show('login');
    const member = await DB.getMember(user.uid);
    if (member) { show('app'); return start(user, member); }
    $('pendingEmail').textContent = user.email || user.nome;
    $('pendingUid').textContent = user.uid;
    show('pending');
  }
  DB.onAuth(checkAccess);
  function loginError(err) {
    console.warn(err);
    const msg = {
      'auth/unauthorized-domain': 'Este endereço ainda não foi autorizado no Firebase (Authentication > Configurações > Domínios autorizados).',
      'auth/operation-not-allowed': 'Este tipo de login ainda não foi ativado no Firebase (Authentication > Método de login).',
      'auth/popup-closed-by-user': 'A janela do Google foi fechada antes de terminar.',
      'auth/popup-blocked': 'O navegador bloqueou a janela do Google. Permita pop-ups para este site (ícone na barra de endereço) e toque de novo.',
      'auth/operation-not-supported-in-this-environment': 'Este navegador não abre o login do Google. Abra a gestão no Chrome ou no Safari.',
      'auth/invalid-credential': 'Usuário ou senha incorretos.',
      'auth/invalid-email': 'Usuário ou senha incorretos.',
      'auth/wrong-password': 'Usuário ou senha incorretos.',
      'auth/user-not-found': 'Usuário ou senha incorretos.'
    }[err.code] || 'Não foi possível entrar. Tente de novo.';
    $('loginError').textContent = msg;
    $('loginError').hidden = false;
  }
  $('googleBtn').addEventListener('click', async () => {
    $('loginError').hidden = true;
    try { await DB.signInGoogle(); } catch (err) { if (err.code !== 'auth/cancelled-popup-request') loginError(err); }
  });
  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target.elements;
    $('loginError').hidden = true;
    if (!f.email.value.trim() || !f.senha.value) return;
    try { await DB.signIn(toLogin(f.email.value), f.senha.value); } catch (err) { loginError(err); }
  });
  $('copyUid').addEventListener('click', () => {
    navigator.clipboard?.writeText($('pendingUid').textContent).then(() => toast('Código copiado ✅'), () => toast('Selecione e copie o código', true));
  });
  $('pendingRetry').addEventListener('click', () => checkAccess(current));
  $('pendingOut').addEventListener('click', () => DB.signOut());
  $('logoutBtn').addEventListener('click', () => DB.signOut().then(() => location.reload()));

  let started = false;
  function start(user, member) {
    if (started) return; started = true;
    state.user = { ...user, nome: member.nome || user.nome };
    // O dono pode ver a gestão como gerente ou funcionário (para conferir o que cada um enxerga)
    state.cargoReal = Core.cargoOf(member);
    const verComo = localGet('gestao-ver-como', 'dono');
    state.cargo = state.cargoReal === 'dono' && Core.CARGOS[verComo] ? verComo : state.cargoReal;
    applyRole();
    if (['dono', 'gerente'].includes(state.cargoReal)) DB.watchTeam(list => { state.team = list; if (state.tab === 'equipe') renderTeam(); }, e => console.warn('equipe', e));
    setBadge(DB.mode === 'firebase' ? null : { aoVivo: true, em: Date.now() });
    $('soundBtn').classList.toggle('is-off', !state.sound);
    watchConfigs();
    const now = new Date();
    const since = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
    DB.watchOrders(since, (list, meta) => { setBadge(meta); onOrders(list); }, e => toast('Sem conexão com os pedidos: ' + e.message, true));
    setInterval(() => setBadge(state.sync), 15000);
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

  // Configurações ao vivo: o que um aparelho salva aparece nos outros sem recarregar.
  // Um formulário com mudanças ainda não salvas nunca é sobrescrito: só avisa e atualiza depois de salvar.
  const FORM_RENDER = { configForm: () => renderConfig(), costList: () => renderCosts(), msgForm: () => renderMsgs() };
  const dirtyForms = new Set(), pendingForms = new Set();
  Object.keys(FORM_RENDER).forEach(id => $(id).addEventListener('input', () => dirtyForms.add(id)));
  function refreshForm(id) {
    if (!dirtyForms.has(id)) return FORM_RENDER[id]();
    if (!pendingForms.has(id)) toast('Outro aparelho mudou estas configurações. Salve as suas para ver as novas.');
    pendingForms.add(id);
  }
  // Depois de salvar, o formulário volta a acompanhar o que vem dos outros aparelhos
  function formSaved(id) {
    dirtyForms.delete(id);
    if (pendingForms.delete(id)) FORM_RENDER[id]();
  }
  function watchConfigs() {
    DB.watchConfig('loja', v => {
      state.cfg.loja = v || {};
      refreshForm('configForm');
      autoAdvance();
      scheduleRender();
    });
    DB.watchConfig('nf', v => {
      state.cfg.nf = v || {};
      refreshForm('configForm');
      autoNf(state.orders);
      scheduleRender();
    });
    DB.watchConfig('custos', v => { state.cfg.custos = v || {}; refreshForm('costList'); if (state.tab === 'lucro') renderProfit(); });
    DB.watchConfig('mensagens', v => { state.cfg.mensagens = v || {}; refreshForm('msgForm'); });
    DB.watchConfig('cardapio', v => {
      let aj = {};
      try { aj = JSON.parse(v?.dados || '{}'); } catch (e) { console.warn('cardápio', e); }
      state.cfg.cardapio = aj;
      Cardapio?.guardar(aj);
      applyMenu(aj);
      renderPos();
      if ($('cmdModal').open) renderCmdMenu();
      if (state.tab === 'estoque') renderStock();
      if (state.tab === 'cardapio') renderMenuEdit();
      if (!dirtyForms.has('costList')) renderCosts();
    });
    DB.watchConfig('estoque', v => {
      state.cfg.estoque = v || {};
      autoStock(state.orders);
      updateCounts();
      if (state.tab === 'estoque') renderStock();
      if (state.tab === 'novo') renderPos();
      if ($('cmdModal').open) renderCmdMenu();
    });
  }
  const taxas = () => ({ ...Core.DEFAULT_TAXAS, ...(state.cfg.loja.taxas || {}) });

  // ---------- Cargos e abas ----------
  const can = aba => Core.canAccess(state.cargo, aba);
  const canPay = () => Core.canDo(state.cargo, 'fecharConta');
  function applyRole() {
    const c = Core.CARGOS[state.cargo];
    const dono = state.cargoReal === 'dono';
    $('roleLabel').textContent = `${c.icon} ${c.label}`;
    $('roleLabel').hidden = dono;
    $('roleView').hidden = !dono;
    if (dono) $('roleView').innerHTML = Object.entries(Core.CARGOS).map(([k, v]) => `<option value="${k}"${k === state.cargo ? ' selected' : ''}>${v.icon} ${k === 'dono' ? 'Dono (vê tudo)' : 'Ver como ' + v.label}</option>`).join('');
    // Cada cargo vê só as suas abas, na ordem do dia a dia dele
    const tabs = $('tabs');
    tabs.querySelectorAll('[data-tab]').forEach(b => { b.hidden = !can(b.dataset.tab); });
    c.abas.forEach(a => { const b = tabs.querySelector(`[data-tab="${a}"]`); if (b) tabs.appendChild(b); });
    // Gerente só cria acesso de funcionário
    document.querySelectorAll('#accountForm [name=cargo], #teamForm [name=cargo]').forEach(sel => {
      [...sel.options].forEach(o => { o.hidden = o.disabled = state.cargo !== 'dono' && o.value !== 'funcionario'; });
      if (sel.selectedOptions[0]?.disabled) sel.value = 'funcionario';
    });
    goTab(c.abas[0]);
  }
  $('roleView').addEventListener('change', e => {
    state.cargo = e.target.value;
    localSet('gestao-ver-como', state.cargo);
    applyRole();
    toast(state.cargo === 'dono' ? 'Vendo tudo 👑' : `Vendo como ${Core.CARGOS[state.cargo].label}`);
  });
  function goTab(tab) {
    if (!can(tab)) return;
    state.tab = tab;
    document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('is-on', x.dataset.tab === tab));
    document.querySelectorAll('.view').forEach(v => { v.hidden = v.id !== 'view-' + tab; });
    renderTab();
  }
  $('tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]');
    if (b) goTab(b.dataset.tab);
  });
  function renderTab() {
    if (state.tab === 'pedidos') renderBoard();
    if (state.tab === 'comandas') renderTables();
    if (state.tab === 'caixa') renderCaixa();
    if (state.tab === 'estoque') renderStock();
    if (state.tab === 'equipe') renderTeam();
    if (state.tab === 'cardapio') renderMenuEdit();
    if (state.tab === 'entregas') renderDeliveries();
    if (state.tab === 'lucro') renderProfit();
    if (state.tab === 'nf') renderNf();
  }

  // ---------- Selo de sincronização (celular e computador veem a mesma lista) ----------
  function setBadge(meta) {
    state.sync = meta;
    const b = $('modeBadge');
    const quem = state.user?.nome || state.user?.email || '';
    if (DB.mode !== 'firebase') { b.textContent = '🟡 Modo demonstração (configure o Firebase)'; b.className = 'pill is-warn'; return; }
    if (!meta) { b.textContent = '⏳ Conectando...'; b.className = 'pill is-warn'; return; }
    const hora = new Date(meta.em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (meta.aoVivo) { b.textContent = `🟢 Ao vivo · ${quem}`; b.title = 'Atualizado ' + hora; b.className = 'pill'; }
    else { b.textContent = `🟠 Sem conexão · última ${hora}`; b.title = 'Mostrando os pedidos que já tinham chegado. Atualiza sozinho quando a internet voltar.'; b.className = 'pill is-warn'; }
  }
  $('syncBtn').addEventListener('click', () => {
    $('syncBtn').classList.add('is-spin');
    setTimeout(() => $('syncBtn').classList.remove('is-spin'), 800);
    if (DB.resync) DB.resync();
    toast('Buscando os pedidos no banco...');
  });

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
    // Mesa que pediu a conta avisa quem cuida do caixa
    const contas = [...Core.openComandas(list).values()].filter(c => c.contaPedida);
    const novas = contas.filter(c => !state.contaSeen.has(c.key));
    if (novas.length && can('caixa') && !state.firstContas) { beep(); toast(`🧾 ${Core.comandaLabel(novas[0])} pediu a conta`); }
    state.firstContas = false;
    state.contaSeen = new Set(contas.map(c => c.key));
    updateCounts();
    checkPayments(list);
    autoNf(list);
    autoStock(list);
    autoAdvance();
    scheduleRender();
  }

  // ---------- Avanço automático do status ----------
  const autoCfg = () => ({ ...Core.DEFAULT_AUTO, ...(state.cfg.loja.automacao || {}) });
  const advancing = new Set();
  async function autoAdvance() {
    const cfg = autoCfg();
    if (!cfg.ativo) return;
    const now = Date.now();
    for (const o of state.orders) {
      const step = Core.autoStep(o, cfg);
      if (!step || step.em > now || advancing.has(o.id)) continue;
      advancing.add(o.id);
      try {
        if (await DB.advanceIf(o.id, o.status, step.para)) toast(`${Core.statusInfo(step.para).icon} ${Core.shortCode(o.id)}: ${Core.statusInfo(step.para).label}`);
      } catch (e) { console.warn('Avanço automático', e); }
      finally { advancing.delete(o.id); }
    }
  }
  setInterval(autoAdvance, 15000);
  // Texto do cartão: quanto falta para o próximo passo automático
  function autoHint(o) {
    const step = Core.autoStep(o, autoCfg());
    if (!step) return '';
    const min = Math.ceil((step.em - Date.now()) / 60000);
    return `<p class="ocard__auto">⏱ ${Core.statusInfo(step.para).label} ${min > 0 ? `em ${min} min` : 'agora'}</p>`;
  }
  // Com muito movimento chegam várias mudanças por segundo: redesenha no máximo a cada 300 ms
  let renderTimer = null, lastRender = 0;
  function scheduleRender() {
    if (renderTimer) return;
    const wait = Math.max(0, 300 - (Date.now() - lastRender));
    renderTimer = setTimeout(() => {
      renderTimer = null;
      lastRender = Date.now();
      renderTab();
      if ($('orderModal').open && openId) renderOrderModal(openId);
      if ($('cmdModal').open) renderCmdSide();
      if ($('payModal').open && payCtx?.kind === 'bill' && !$('payBody').contains(document.activeElement)) renderBill();
    }, wait);
  }

  const COLS = ['montando', 'novo', 'preparo', 'pronto', 'entrega'];
  function isLiveDraft(o) { return o.status === 'montando' && (o.itens || []).length && Date.now() - (o.atualizadoEm || o.criadoEm) < 3 * 36e5; }
  function itemsSummary(o) { return (o.itens || []).map(l => `${l.qty}x ${l.name}`).join(', '); }
  function payBadge(o) {
    if (o.pagamento?.pago) return `<span class="tag tag--ok">Pago · ${esc(o.pagamento.metodo || o.pagamento.forma)}</span>`;
    return `<span class="tag">${esc(o.pagamento?.forma || 'Pix')}${o.pagamento?.troco ? ' · troco ' + esc(o.pagamento.troco) : ''}</span>`;
  }
  const origemTag = o => (o.comanda ? `${o.comanda.tipo === 'retirada' ? '🥡' : '🍽'} ${Core.comandaLabel(o.comanda)}${o.comanda.tipo === 'retirada' && o.origem === 'ifood' ? ' · iFood' : ''}` : { site: '🌐 Site', balcao: '🏪 Balcão', whatsapp: '💬 WhatsApp', ifood: '🛵 iFood', mesa: '🍽 Mesa' }[o.origem] || o.origem);

  function orderCard(o) {
    const next = Core.nextStatus(o);
    const live = o.status === 'montando';
    return `<article class="ocard${live ? ' ocard--live' : ''}" data-id="${esc(o.id)}">
      <header><b>${esc(Core.shortCode(o.id))}</b><span class="muted">${origemTag(o)} · ${ago(o.criadoEm)}</span></header>
      <p class="ocard__who">${o.comanda ? `<span class="tag tag--mesa">${o.comanda.tipo === 'retirada' ? '🥡' : '🍽'} ${esc(Core.comandaLabel(o.comanda))}</span> ` : ''}${esc(o.cliente?.nome || (live ? 'Cliente escolhendo...' : o.comanda ? '' : 'Sem nome'))}${o.entrega?.bairro ? ` · ${esc(o.entrega.bairro)}` : ''}</p>
      <p class="ocard__items">${esc(itemsSummary(o))}</p>
      <footer>
        <strong>${brl(o.total)}</strong>${live ? '<span class="tag tag--live">ao vivo</span>' : payBadge(o)}
      </footer>
      ${live ? '' : autoHint(o)}
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

  function setStatus(o, status, extra = {}) {
    const hist = [...(o.historico || []), { status, em: Date.now() }].slice(-30);
    return safe('Erro ao mudar status', async () => {
      await DB.updateOrder(o.id, { status, historico: hist, ...extra });
      if (status === 'cancelado' && Core.NF_STATUS_OK.includes(o.nf?.status)) cancelNf(o);
    });
  }
  function payOrder(o, metodo) {
    return safe('Erro ao marcar pagamento', () => DB.updateOrder(o.id, { 'pagamento.pago': true, 'pagamento.metodo': metodo, 'pagamento.em': Date.now() }));
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
      ${o.cancelMotivo ? `<p class="note">✖ Cancelado: ${esc(o.cancelMotivo)}</p>` : ''}
      ${canPay() ? `<div class="grid3">
        ${d ? `<label class="field">Taxa de entrega<input data-m="taxa" data-mask="money" value="${money(o.entrega?.taxa)}"></label>` : ''}
        <label class="field">Desconto<input data-m="desconto" data-mask="money" value="${money(o.desconto)}"></label>
        <div class="total"><span>Total</span><strong>${brl(o.total)}</strong></div>
      </div>` : `<div class="total"><span>Total</span><strong>${brl(o.total)}</strong></div>`}
      <h4>Pagamento ${payBadge(o)}</h4>
      ${!canPay() ? `<p class="muted small">${o.comanda?.aberta ? 'A conta é fechada no caixa.' : 'Pagamento é recebido pelo caixa.'}</p>` : o.comanda?.aberta && !o.pagamento?.pago ? `<div class="row"><button type="button" class="btn btn--sm btn--yellow" data-m="bill">💵 Fechar a conta da ${esc(Core.comandaLabel(o.comanda))}</button></div>` : `
      <div class="paybox">
        ${o.pagamento?.pago ? `<p class="muted small">Recebido${o.pagamento.transacao ? ' · transação ' + esc(o.pagamento.transacao) : ''}. <button type="button" class="link" data-m="unpay">desfazer</button></p>` : `
        <p class="muted small">Na maquininha: digite <b class="big">${brl(o.total)}</b> e depois marque como foi pago.</p>
        <div class="row">${['Pix', 'Débito', 'Crédito', 'Dinheiro'].map(m => `<button type="button" class="btn btn--sm btn--ghost" data-m="pay" data-p="${m}">✔ ${m}</button>`).join('')}</div>
        <div class="row"><button type="button" class="btn btn--sm btn--yellow" data-m="link">💳 Gerar link InfinitePay</button>
        ${o.pagamento?.link ? `<a class="btn btn--sm btn--ghost" href="${esc(o.pagamento.link)}" target="_blank" rel="noopener">Abrir link</a><button type="button" class="btn btn--sm btn--ghost" data-m="sendlink">💬 Enviar link</button>` : ''}
        ${o.retornoPagamento ? '<button type="button" class="btn btn--sm btn--ghost" data-m="check">🔎 Conferir pagamento</button>' : ''}</div>`}
      </div>`}
      ${can('nf') ? `<h4>Nota fiscal</h4>
      <div class="row"><span class="tag">${nfLabel(o.nf)}</span>
        ${o.nf?.url ? `<a class="btn btn--sm btn--ghost" href="${esc(o.nf.url)}" target="_blank" rel="noopener">🧾 Ver NFC-e</a>` : ''}
        ${o.nf?.payload ? '<button type="button" class="btn btn--sm btn--ghost" data-m="nfview">🧾 Ver nota</button>' : ''}
        ${!o.nf?.status || o.nf.status === 'erro' ? '<button type="button" class="btn btn--sm btn--ghost" data-m="nf">🧾 Emitir NFC-e</button>' : ''}
        ${o.nf?.erro ? `<small class="muted">${esc(o.nf.erro)}</small>` : ''}</div>` : ''}
      <footer class="modal__foot">
        <button type="button" class="btn btn--sm btn--ghost" data-m="print">🖨 Comanda</button>
        <button type="button" class="btn btn--sm btn--ghost" data-m="whats">💬 Avisar cliente</button>
        ${o.comanda?.aberta ? `<button type="button" class="btn btn--sm btn--ghost" data-m="opencmd">🍽 Abrir ${esc(Core.comandaLabel(o.comanda))}</button>` : ''}
        ${state.cargo === 'dono' ? '<button type="button" class="btn btn--sm btn--danger" data-m="delete">Apagar</button>' : ''}
      </footer>`;
  }
  $('orderBody').addEventListener('click', e => {
    const b = e.target.closest('[data-m]');
    if (!b || b.tagName === 'INPUT') return;
    const m = b.dataset.m;
    if (m === 'close') return $('orderModal').close();
    const o = state.orders.find(x => x.id === openId);
    if (!o) return;
    if (m === 'nfview') return showNf(o);
    if (m === 'status') {
      if (b.dataset.s === 'cancelado' && o.status !== 'cancelado') {
        const motivo = prompt(`Cancelar o pedido ${Core.shortCode(o.id)}? Escreva o motivo (opcional):`);
        if (motivo === null) return;
        return setStatus(o, 'cancelado', { cancelMotivo: motivo.trim().slice(0, 140), ...(o.comanda ? { 'comanda.aberta': false } : {}) });
      }
      setStatus(o, b.dataset.s);
    }
    if (m === 'bill') { $('orderModal').close(); return openBill(Core.comandaKey(o.comanda)); }
    if (m === 'opencmd') { $('orderModal').close(); return openCmd(o.comanda.tipo, o.comanda.numero); }
    if (m === 'pay') payOrder(o, b.dataset.p);
    if (m === 'unpay') safe('Erro', () => DB.updateOrder(o.id, { 'pagamento.pago': false, 'pagamento.metodo': '', 'pagamento.em': 0 }));
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
    if (!o || !['taxa', 'desconto'].includes(m) || !canPay()) return;
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
        await DB.updateOrder(o.id, { 'pagamento.pago': true, 'pagamento.metodo': data.capture_method === 'pix' ? 'Pix (online)' : 'Online', 'pagamento.transacao': r.transaction_nsu || '', 'pagamento.em': Date.now() });
        toast(`💰 Pagamento confirmado ${Core.shortCode(o.id)}`);
      } else if (loud) toast('Pagamento ainda não aparece como pago', true);
    } catch (e) { if (loud) toast('Não deu para conferir: ' + e.message, true); }
    finally { checking.delete(o.id); }
  }
  function checkPayments(list) { list.filter(o => o.retornoPagamento && !o.pagamento?.pago).forEach(o => checkPayment(o, false)); }

  // ---------- Nota fiscal ----------
  // Emissor "simulacao" monta a nota completa sem mandar para a SEFAZ (para testar antes de ter o emissor).
  // Emissor "focus" manda pela função emitirNfce do Firebase (Focus NFe).
  const CNPJ_LOJA = '46723226000111';
  const nfCfg = () => ({ emissor: 'simulacao', nfQuando: 'pedido', ...state.cfg.nf });
  const NF_LABEL = { emitindo: '⏳ Emitindo', autorizado: '✅ Autorizada', simulada: '🧪 Simulada', processando_autorizacao: '⏳ Na SEFAZ', erro: '❌ Erro', cancelado: '✖ Cancelada', cancelada: '✖ Cancelada' };
  const nfLabel = nf => (nf?.status ? NF_LABEL[nf.status] || nf.status : '—');

  async function emitNf(o, { auto = false } = {}) {
    const cfg = nfCfg();
    const cnpj = cfg.cnpj || (cfg.emissor === 'simulacao' ? CNPJ_LOJA : '');
    if (!cnpj) return auto ? null : toast('Preencha o CNPJ em Configurações > Nota fiscal', true);
    if (cfg.emissor === 'focus' && DB.mode !== 'firebase') return auto ? null : toast('O emissor Focus NFe precisa do Firebase', true);
    if (!(o.itens || []).length) return auto ? null : toast('Pedido sem itens', true);
    let claimed = false;
    try { claimed = await DB.claimNf(o.id, !auto); } catch (e) { console.warn('claimNf', e); }
    if (!claimed) return null; // outro aparelho já está emitindo esta nota
    const payload = Core.nfcePayload(o, { cnpj, ncm: cfg.ncm || undefined, csosn: cfg.csosn || undefined });
    try {
      let nf;
      if (cfg.emissor === 'focus') {
        const r = await DB.call('emitirNfce', { pedidoId: o.id, payload });
        nf = { status: r.status || 'processando_autorizacao', chave: r.chave || '', url: r.url || '', em: Date.now(), emissor: 'focus' };
      } else {
        nf = { status: 'simulada', chave: '', url: '', em: Date.now(), emissor: 'simulacao', payload };
      }
      await DB.updateOrder(o.id, { nf });
      if (!auto) toast('🧾 Nota: ' + nfLabel(nf));
      return nf;
    } catch (e) {
      console.error('NFC-e', e);
      await DB.updateOrder(o.id, { nf: { status: 'erro', erro: String(e.message || e).slice(0, 200), em: Date.now() } }).catch(() => {});
      toast(`🧾 Nota do pedido ${Core.shortCode(o.id)} falhou: ${e.message || e}`, true);
      return null;
    }
  }
  async function cancelNf(o) {
    await safe('Erro ao cancelar a nota', async () => {
      if (o.nf?.emissor === 'focus') await DB.call('cancelarNfce', { pedidoId: o.id, justificativa: 'Pedido cancelado pelo cliente antes da entrega' });
      await DB.updateOrder(o.id, { 'nf.status': 'cancelada', 'nf.canceladaEm': Date.now() });
      toast(`🧾 Nota do pedido ${Core.shortCode(o.id)} cancelada`);
    });
  }

  // Emite sozinho: uma nota por vez, só de pedidos das últimas 48 h (não reemite o histórico)
  const nfQueue = [];
  let nfBusy = false;
  function autoNf(list) {
    const cfg = nfCfg();
    if (!cfg.nfAuto) return;
    const since = Date.now() - 48 * 36e5;
    list.filter(o => o.criadoEm >= since && Core.shouldAutoEmit(o, cfg) && !nfQueue.some(q => q.id === o.id))
      .sort((a, b) => a.criadoEm - b.criadoEm).forEach(o => nfQueue.push(o));
    runNfQueue();
  }
  async function runNfQueue() {
    if (nfBusy) return;
    nfBusy = true;
    try {
      while (nfQueue.length) {
        const o = nfQueue.shift();
        const latest = state.orders.find(x => x.id === o.id) || o;
        if (Core.shouldAutoEmit(latest, nfCfg())) await emitNf(latest, { auto: true });
      }
    } finally { nfBusy = false; }
  }

  function renderNf() {
    const cfg = nfCfg();
    const quando = { pedido: 'assim que o pedido chega', pago: 'quando o pedido é marcado como pago', concluido: 'quando o pedido é concluído' }[cfg.nfQuando];
    const emissor = cfg.emissor === 'focus' ? 'Focus NFe (SEFAZ)' : 'Simulação (não vale como nota, serve para testar)';
    $('nfState').innerHTML = `${cfg.nfAuto ? `🤖 Emissão automática <b>ligada</b>: ${quando}.` : '✋ Emissão automática <b>desligada</b> (ligue em Configurações).'} Emissor: <b>${emissor}</b>.` +
      (cfg.emissor === 'focus' && DB.mode !== 'firebase' ? ' ⚠️ O Focus NFe precisa do Firebase.' : '') +
      (cfg.emissor === 'simulacao' ? ' <br><small class="muted">Para notas de verdade: crie a conta na Focus NFe, publique a função do Firebase e troque o emissor em Configurações.</small>' : '');
    const list = state.orders.filter(Core.countsAsSale).slice(0, 120);
    $('nfList').innerHTML = list.length ? '' : '<p class="muted small">Nenhum pedido ainda.</p>';
    if (!list.length) return;
    // No celular cada linha vira um cartão (rótulos em data-label, ver .table--cards no CSS)
    $('nfList').innerHTML = `<table class="table table--cards"><thead><tr><th>Pedido</th><th>Cliente</th><th>Pagamento</th><th>Total</th><th>Nota</th><th></th></tr></thead><tbody>
      ${list.map(o => `<tr><td class="tc-head"><b>${esc(Core.shortCode(o.id))}</b> <small class="muted">${hhmm(o.criadoEm)} · ${new Date(o.criadoEm).toLocaleDateString('pt-BR')}</small></td><td data-label="Cliente">${esc(o.cliente?.nome || '—')}</td><td data-label="Pagamento">${esc(o.pagamento?.metodo || o.pagamento?.forma || '—')}</td><td data-label="Total"><b>${brl(o.total)}</b></td>
        <td data-label="Nota">${o.nf?.url ? `<a href="${esc(o.nf.url)}" target="_blank" rel="noopener">${nfLabel(o.nf)}</a>` : `<span title="${esc(o.nf?.erro || '')}">${nfLabel(o.nf)}</span>`}${o.nf?.erro ? `<small class="tc-err">${esc(o.nf.erro)}</small>` : ''}</td>
        <td class="tc-acts">${o.nf?.payload ? `<button type="button" class="btn btn--sm btn--ghost" data-nfview="${esc(o.id)}">Ver</button>` : ''}${!o.nf?.status || o.nf.status === 'erro' ? `<button type="button" class="btn btn--sm btn--ghost" data-nf="${esc(o.id)}">Emitir</button>` : ''}</td></tr>`).join('')}
    </tbody></table>`;
  }
  $('nfList').addEventListener('click', e => {
    const view = e.target.closest('[data-nfview]')?.dataset.nfview;
    if (view) return showNf(state.orders.find(x => x.id === view));
    const id = e.target.closest('[data-nf]')?.dataset.nf;
    const o = id && state.orders.find(x => x.id === id);
    if (o) emitNf(o);
  });

  // Prévia da nota (DANFE simplificado) a partir do que foi enviado
  const FORMA_LABEL = { '01': 'Dinheiro', '03': 'Cartão de crédito', '04': 'Cartão de débito', '17': 'Pix', '99': 'Outros' };
  function showNf(o) {
    const n = o?.nf?.payload;
    if (!n) return;
    const p = n.formas_pagamento[0];
    $('orderBody').innerHTML = `<header class="modal__head"><h2>NFC-e ${o.nf.status === 'simulada' ? '<small>🧪 simulação, sem valor fiscal</small>' : ''}</h2><button type="button" class="icon-btn" data-m="close" aria-label="Fechar">✕</button></header>
      <div class="danfe">
        <p><b>BALDINI BURGUER</b><br>CNPJ ${esc(n.cnpj_emitente.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5'))}<br>${esc(n.natureza_operacao)} · ${new Date(n.data_emissao).toLocaleString('pt-BR')}</p>
        <table class="table"><thead><tr><th>Item</th><th>Qtd</th><th>Unit.</th><th>Total</th></tr></thead><tbody>
          ${n.items.map(i => `<tr><td>${esc(i.descricao)}<br><small class="muted">NCM ${esc(i.codigo_ncm)} · CFOP ${esc(i.cfop)} · CSOSN ${esc(i.icms_situacao_tributaria)}</small></td><td>${i.quantidade_comercial}</td><td>${brl(i.valor_unitario_comercial)}</td><td>${brl(i.valor_bruto)}</td></tr>`).join('')}
        </tbody></table>
        <p>${n.valor_frete ? `Frete: ${brl(n.valor_frete)}<br>` : ''}${n.valor_desconto ? `Desconto: ${brl(n.valor_desconto)}<br>` : ''}<b>Total: ${brl(p.valor_pagamento)}</b><br>Pagamento: ${FORMA_LABEL[p.forma_pagamento] || p.forma_pagamento}${p.valor_troco ? ` · troco ${brl(p.valor_troco)}` : ''}</p>
        <p>${n.cpf_destinatario ? `Consumidor: ${esc(n.nome_destinatario || '')} · CPF ${esc(n.cpf_destinatario.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4'))}${n.logradouro_destinatario ? `<br>${esc(n.logradouro_destinatario)}, ${esc(n.numero_destinatario)} - ${esc(n.bairro_destinatario)}, ${esc(n.municipio_destinatario)}-${esc(n.uf_destinatario)}` : ''}` : `Consumidor: ${esc((o.cliente?.nome || '').trim() || 'não identificado')}${o.cliente?.nome ? ' <small class="muted">(sem CPF)</small>' : ''}`}</p>
        <p class="muted small">${esc(n.informacoes_adicionais_contribuinte || '')}</p>
      </div>`;
    if (!$('orderModal').open) $('orderModal').showModal();
    openId = null;
  }

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
    if (!MENU.some(c => c.id === posCat)) posCat = MENU[0]?.id;
    const items = q ? [...products.values()].filter(p => !p.oculto && Core.norm(p.name).includes(q)) : (MENU.find(c => c.id === posCat)?.items || []);
    $('posGrid').innerHTML = productTiles(items);
    renderPosCart();
  }
  // Produtos do cardápio para tocar e adicionar, com o aviso do estoque
  function productTiles(items) {
    const est = state.cfg.estoque?.itens || {};
    return items.map(p => {
      const e = est[p.id], st = Core.stockStatus(e);
      const badge = st === 'falta' ? '<em class="pbadge pbadge--falta">❌ Em falta</em>' : st === 'baixo' ? `<em class="pbadge pbadge--baixo">⚠️ Restam ${e.qtd}</em>` : '';
      return `<button type="button" class="pitem${st === 'falta' ? ' is-out' : ''}" data-p="${p.id}">${p.img ? `<img src="${siteImg(p.img)}" alt="" loading="lazy">` : '<span>🍔</span>'}${badge}<b>${esc(p.name)}</b><small>${brl(p.price || Math.min(...(p.groups?.[0]?.options || [{ price: 0 }]).map(o => o.price)))}</small></button>`;
    }).join('');
  }
  $('posCats').addEventListener('click', e => { const b = e.target.closest('[data-cat]'); if (b) { posCat = b.dataset.cat; $('posSearch').value = ''; renderPos(); } });
  $('posSearch').addEventListener('input', renderPos);
  $('posGrid').addEventListener('click', e => { const b = e.target.closest('[data-p]'); if (b) pickProduct(products.get(b.dataset.p)); });

  let pick = null;
  // Escolhe as opções do produto e entrega a linha pronta para quem chamou (lançar pedido ou comanda)
  function pickProduct(p, onAdd = addPosLine) {
    const st = Core.stockStatus(state.cfg.estoque?.itens?.[p.id]);
    if (st === 'falta' && !confirm(`${p.name} está em falta no estoque. Adicionar mesmo assim?`)) return;
    if (!p.groups?.length) return onAdd({ id: p.id, name: p.name, img: p.img, unit: p.price, qty: 1, choices: [], note: '' });
    pick = { p, onAdd, sel: p.groups.map(g => (g.type === 'single' && g.options.length === 1 ? { 0: 1 } : {})), qty: 1 };
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
      pick.onAdd({ id: pick.p.id, name: pick.p.name, img: pick.p.img, unit: Core.unitPrice(pick.p, pick.sel), qty: pick.qty, choices, note: (pick.note || '').trim() });
      $('pickModal').close();
    }
  });
  function addPosLine(l) { posCart.push(l); renderPosCart(); toast(`${l.qty}x ${l.name} adicionado`); }
  function posOrder() {
    const f = $('posForm').elements;
    return Core.sanitizeOrder({
      id: Core.newOrderId(), origem: f.origem.value, status: 'novo', itens: posCart,
      cliente: { nome: f.nome.value.trim(), telefone: f.telefone.value.trim(), cpf: f.cpf.value.trim() },
      entrega: { tipo: f.entrega.value, endereco: f.endereco.value.trim(), bairro: f.bairro.value.trim(), referencia: f.referencia.value.trim(), taxa: num(f.taxa.value) },
      pagamento: { forma: f.pagamento.value, pago: f.pago.checked, metodo: f.pago.checked ? f.pagamento.value : '', em: f.pago.checked ? Date.now() : 0 },
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
    const err = !posCart.length ? 'Adicione pelo menos um item.'
      : (f.entrega.value === 'Delivery' && (!f.endereco.value.trim() || !f.bairro.value.trim())) ? 'Para delivery, preencha endereço e bairro.'
      : (f.telefone.value && !BaldiniMask.validPhone(f.telefone.value)) ? 'WhatsApp inválido: use DDD + número, ex.: (81) 98790-8900.'
      : (f.cpf.value && !Core.validCpf(f.cpf.value)) ? 'CPF inválido: confira os números ou deixe em branco.' : '';
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

  // ---------- Contadores das abas ----------
  function updateCounts() {
    const open = [...Core.openComandas(state.orders).values()];
    $('tabCmdCount').textContent = open.filter(c => c.pronto).length || '';
    $('tabCmdCount').title = 'Mesas com pedido pronto para servir';
    $('tabCaixaCount').textContent = open.filter(c => c.contaPedida).length || '';
    const est = state.cfg.estoque?.itens || {};
    $('tabStockCount').textContent = [...products.keys()].filter(id => Core.stockStatus(est[id]) === 'falta').length || '';
  }

  // ---------- Estoque: baixa automática ----------
  // Pedido que vira venda tira do estoque; pedido cancelado devolve. Só vale para pedidos feitos
  // depois que o estoque começou a ser usado (não desconta o histórico antigo).
  const stocking = new Set();
  async function autoStock(list) {
    const est = state.cfg.estoque || {};
    const itens = est.itens || {};
    if (!est.desde || !Object.keys(itens).length) return;
    for (const o of list) {
      if (stocking.has(o.id) || o.criadoEm < est.desde) continue;
      const baixar = Core.countsAsSale(o);
      if (!!o.estoqueBaixado === baixar) continue;
      const need = Core.stockNeeds(o, itens);
      if (!Object.keys(need).length) continue;
      stocking.add(o.id);
      try {
        if (await DB.claimStock(o.id, baixar)) {
          const deltas = {};
          Object.entries(need).forEach(([id, q]) => { deltas[id] = baixar ? -q : q; });
          await DB.addStock(deltas);
        }
      } catch (e) { console.warn('Estoque', e); }
      finally { stocking.delete(o.id); }
    }
  }

  // ---------- Mesas e comandas ----------
  const mesasCount = () => Math.max(1, Math.min(200, Number(state.cfg.loja.mesas) || 12));
  let cmdFilter = 'todas';
  function renderTables() {
    const open = Core.openComandas(state.orders);
    const tiles = [];
    for (let n = 1; n <= mesasCount(); n++) tiles.push(open.get(`mesa-${n}`) || { key: `mesa-${n}`, tipo: 'mesa', numero: n, livre: true });
    [...open.values()].filter(c => !tiles.some(t => t.key === c.key)).sort((a, b) => a.tipo.localeCompare(b.tipo) || a.numero - b.numero).forEach(c => tiles.push(c));
    const ocupadas = tiles.filter(t => !t.livre);
    const mesasOcup = ocupadas.filter(t => t.tipo === 'mesa').length;
    const avulsas = ocupadas.filter(t => t.tipo === 'comanda').length;
    const retiradas = ocupadas.filter(t => t.tipo === 'retirada').length;
    $('cmdSum').innerHTML = `<b>${mesasOcup}</b> de ${mesasCount()} mesas ocupadas${avulsas ? ` · <b>${avulsas}</b> comanda${avulsas > 1 ? 's' : ''} avulsa${avulsas > 1 ? 's' : ''}` : ''}${retiradas ? ` · <b>${retiradas}</b> retirada${retiradas > 1 ? 's' : ''}` : ''} · <b>${brl(ocupadas.reduce((s, c) => s + c.total, 0))}</b> em aberto`;
    const show = tiles.filter(t => cmdFilter === 'todas' || (cmdFilter === 'livres' ? t.livre : cmdFilter === 'retiradas' ? t.tipo === 'retirada' : !t.livre));
    $('tables').innerHTML = show.map(t => {
      const tipo = Core.TIPO_LABEL[t.tipo];
      if (t.livre) return `<button type="button" class="tbl" data-cmd="${t.key}"><small>${tipo}</small><b>${t.numero}</b><span class="muted">Livre</span></button>`;
      const cls = (t.contaPedida ? ' tbl--conta' : t.pronto ? ' tbl--pronto' : ' tbl--ocupada') + (t.tipo === 'retirada' ? ' tbl--retirada' : '');
      const flag = t.contaPedida ? '<em>🧾 Pediu a conta</em>' : t.pronto ? `<em>🔔 Pronto p/ ${t.tipo === 'retirada' ? 'retirar' : 'servir'}</em>` : t.cozinha ? '<em class="is-soft">🔥 Na cozinha</em>' : '';
      return `<button type="button" class="tbl${cls}" data-cmd="${t.key}"><small>${t.tipo === 'retirada' ? `🥡 ${tipo} · ${ORIGEM_LABEL[t.origem] || 'Balcão'}` : tipo}</small><b>${t.numero}</b>
        ${t.nome ? `<span class="tbl__name">${esc(t.nome)}</span>` : ''}<strong>${brl(t.total)}</strong><span class="muted">${t.itens} ${t.itens === 1 ? 'item' : 'itens'} · ${ago(t.abertaEm)}</span>${flag}</button>`;
    }).join('') || '<p class="muted small">Nada aqui.</p>';
    renderClosed();
  }
  // Contas fechadas hoje: dá para reabrir para corrigir ou acrescentar
  function renderClosed() {
    const list = Core.closedComandas(state.orders, startOfDay());
    $('closedCount').textContent = list.length ? `(${list.length})` : '';
    $('closedList').innerHTML = list.length ? list.map(c => `<div class="drow"><span><b>${esc(Core.comandaLabel(c))}</b>${c.nome ? ` · ${esc(c.nome)}` : ''} <small class="muted">fechada às ${hhmm(c.fechadaEm)} · ${esc(c.metodo)}</small></span>
      <span><b>${brl(c.total)}</b> <button type="button" class="btn btn--sm btn--ghost" data-reopen="${esc(c.key)}">🔓 Reabrir</button></span></div>`).join('') : '<p class="muted small">Nenhuma conta fechada hoje.</p>';
  }
  $('closedList').addEventListener('click', e => {
    const key = e.target.closest('[data-reopen]')?.dataset.reopen;
    const c = key && Core.closedComandas(state.orders, startOfDay()).find(x => x.key === key);
    if (c) reopenBill(c);
  });
  async function reopenBill(c) {
    const label = Core.comandaLabel(c);
    const ocupada = Core.openComandas(state.orders).get(Core.comandaKey(c));
    const nf = c.pedidos.some(o => Core.NF_STATUS_OK.includes(o.nf?.status));
    if (!confirm(`Reabrir a ${label} (${brl(c.total)}, paga no ${c.metodo})?\n\nO pagamento é desfeito e a conta volta a ficar aberta para editar.` +
      (ocupada ? `\n\n⚠️ A ${label} já tem outra conta aberta: as duas vão ficar juntas.` : '') +
      (nf ? '\n\n⚠️ A nota fiscal desta conta já foi emitida.' : ''))) return;
    await safe('Erro ao reabrir', () => Promise.all(c.pedidos.map(o => DB.updateOrder(o.id, {
      'comanda.aberta': true, 'comanda.contaPedida': false, 'pagamento.pago': false, 'pagamento.metodo': '', 'pagamento.forma': 'A definir', 'pagamento.em': 0, 'pagamento.troco': ''
    }))));
    toast(`🔓 ${label} reaberta`);
    openCmd(c.tipo, c.numero);
  }
  $('cmdFilter').addEventListener('click', e => {
    const b = e.target.closest('[data-f]');
    if (!b) return;
    cmdFilter = b.dataset.f;
    $('cmdFilter').querySelectorAll('button').forEach(x => x.classList.toggle('is-on', x === b));
    renderTables();
  });
  $('tables').addEventListener('click', e => {
    const b = e.target.closest('[data-cmd]');
    if (!b) return;
    const [tipo, n] = b.dataset.cmd.split('-');
    openCmd(tipo, Number(n));
  });
  $('newComanda').addEventListener('click', () => openCmd('comanda', Core.nextComanda(state.orders)));
  $('newRetirada').addEventListener('click', () => openCmd('retirada', Core.nextComanda(state.orders, 'retirada')));
  const ORIGEM_LABEL = { balcao: 'Balcão', ifood: 'iFood', whatsapp: 'WhatsApp/telefone', site: 'Site', mesa: 'Mesa' };

  // Tela da mesa: cardápio de um lado, conta do outro. Lança, troca, cancela e pede a conta sem sair dali.
  let cmd = null;
  let cmdCat = MENU[0]?.id;
  const cmdLabel = () => Core.comandaLabel(cmd);
  const currentCmd = () => (cmd ? Core.openComandas(state.orders).get(Core.comandaKey(cmd)) : null);
  function openCmd(tipo, numero) {
    cmd = { tipo, numero, draft: [], obs: '' };
    const c = currentCmd();
    cmd.nome = c?.nome || '';
    cmd.origem = c?.origem && c.origem !== 'mesa' ? c.origem : 'balcao';
    cmd.telefone = c?.pedidos.find(o => o.cliente?.telefone)?.cliente.telefone || '';
    $('cmdSearch').value = '';
    renderCmdMenu();
    renderCmdSide(true);
    if (!$('cmdModal').open) $('cmdModal').showModal();
  }
  function closeCmd() {
    if (cmd?.draft.length && !confirm('Os itens que ainda não foram enviados para a cozinha serão descartados. Fechar mesmo assim?')) return;
    cmd = null;
    $('cmdModal').close();
    if (state.tab === 'comandas') renderTables();
  }
  $('cmdModal').addEventListener('cancel', e => { e.preventDefault(); closeCmd(); });
  function renderCmdMenu() {
    if (!cmd) return;
    $('cmdCats').innerHTML = MENU.map(c => `<button type="button" data-cat="${c.id}" class="${c.id === cmdCat ? 'is-on' : ''}">${esc(c.name)}</button>`).join('');
    const q = Core.norm($('cmdSearch').value);
    if (!MENU.some(c => c.id === cmdCat)) cmdCat = MENU[0]?.id;
    const items = q ? [...products.values()].filter(p => !p.oculto && Core.norm(p.name).includes(q)) : (MENU.find(c => c.id === cmdCat)?.items || []);
    $('cmdGrid').innerHTML = productTiles(items) || '<p class="muted small">Nenhum produto encontrado.</p>';
  }
  $('cmdSearch').addEventListener('input', renderCmdMenu);
  $('cmdCats').addEventListener('click', e => { const b = e.target.closest('[data-cat]'); if (b) { cmdCat = b.dataset.cat; $('cmdSearch').value = ''; renderCmdMenu(); } });
  $('cmdGrid').addEventListener('click', e => { const b = e.target.closest('[data-p]'); if (b) pickProduct(products.get(b.dataset.p), addCmdLine); });
  function addCmdLine(l) {
    // Mesmo produto sem opções nem observação só aumenta a quantidade
    const same = !l.choices.length && !l.note && cmd.draft.find(x => x.id === l.id && !x.choices.length && !x.note);
    if (same) same.qty = Math.min(99, same.qty + l.qty); else cmd.draft.push(l);
    renderCmdDraft();
    toast(`${l.qty}x ${l.name} ✓`);
  }
  const lineChoices = l => (l.choices || []).map(c => `<small>${esc(c.group)}: ${esc(c.items.map(i => (i.qty > 1 ? i.qty + 'x ' : '') + i.name).join(', '))}</small>`).join('') + (l.note ? `<small><i>Obs: ${esc(l.note)}</i></small>` : '');
  // full=true monta tudo; senão só atualiza a conta (os campos que a pessoa está digitando ficam intactos)
  function renderCmdSide(full) {
    if (!cmd) return;
    if (full || !$('cmdBill')) {
      $('cmdSide').innerHTML = `<div id="cmdActs"></div>
        <section class="cmd__new">
          <h3>Novo pedido</h3>
          ${cmd.tipo === 'retirada' ? `<p class="muted small">🥡 Cliente vai buscar na loja (não é mesa).</p>
          <div class="grid2">
            <label class="field">Pediu por
              <select id="cmdOrigem"${currentCmd() ? ' disabled' : ''}>${['balcao', 'ifood', 'whatsapp'].map(k => `<option value="${k}"${cmd.origem === k ? ' selected' : ''}>${ORIGEM_LABEL[k]}</option>`).join('')}</select></label>
            <label class="field">WhatsApp (opcional, para avisar que está pronto)<input id="cmdTel" data-mask="phone" value="${esc(cmd.telefone)}" placeholder="(81) 98790-8900"></label>
          </div>` : ''}
          <div class="grid2">
            <label class="field">Nome do cliente${cmd.tipo === 'retirada' ? '' : ' (opcional)'}<input id="cmdNome" maxlength="60" value="${esc(cmd.nome)}" placeholder="Ex.: Ana"></label>
            <label class="field">Observação para a cozinha<input id="cmdObs" maxlength="300" value="${esc(cmd.obs)}" placeholder="Ex.: sem cebola na 1ª"></label>
          </div>
          <div id="cmdDraft"></div>
        </section>
        <section id="cmdBill"></section>`;
      renderCmdDraft();
    }
    const c = currentCmd();
    $('cmdTitle').innerHTML = `${{ mesa: '🍽', comanda: '🧾', retirada: '🥡' }[cmd.tipo] || '🍽'} ${esc(cmdLabel())}${cmd.tipo === 'retirada' ? ` · ${esc(ORIGEM_LABEL[cmd.origem])}` : ''} ${c ? `<small>Aberta há ${ago(c.abertaEm)} · ${c.pedidos.length} envio${c.pedidos.length > 1 ? 's' : ''} para a cozinha</small>` : '<small>Livre: adicione os itens e envie para a cozinha</small>'}`;
    $('cmdActs').innerHTML = c ? `<div class="cmd__acts">
        <button type="button" class="btn btn--sm btn--ghost" data-c="move">🔁 Trocar / juntar</button>
        <button type="button" class="btn btn--sm ${c.contaPedida ? 'btn--yellow' : 'btn--ghost'}" data-c="ask">🧾 ${c.contaPedida ? 'Conta pedida ✓' : 'Pedir a conta'}</button>
        <button type="button" class="btn btn--sm btn--ghost" data-c="print">🖨 Imprimir conta</button>
        <button type="button" class="btn btn--sm btn--danger" data-c="cancel">✖ Cancelar ${cmd.tipo}</button>
      </div>` : '';
    $('cmdBill').innerHTML = c ? `<h3>Já na conta</h3>
      ${c.pedidos.map(o => `<div class="round round--${o.status}">
        <header><b>${esc(Core.shortCode(o.id))}</b><span class="muted">${hhmm(o.criadoEm)}</span><span class="tag">${Core.statusInfo(o.status).icon} ${Core.statusInfo(o.status).label}</span>
          <span class="round__acts">${o.status === 'pronto' ? `<button type="button" class="btn btn--sm btn--yellow" data-c="served" data-o="${esc(o.id)}">✔ ${cmd.tipo === 'retirada' ? 'Entregue' : 'Servido'}</button>` : ''}${o.status === 'pronto' && o.cliente?.telefone ? `<button type="button" class="btn btn--sm btn--ghost" data-c="whats" data-o="${esc(o.id)}" title="Avisar no WhatsApp que está pronto">💬</button>` : ''}<button type="button" class="link" data-c="cancelone" data-o="${esc(o.id)}" title="Cancelar só este envio">Cancelar</button></span></header>
        <ul class="lines">${(o.itens || []).map((l, i) => `<li><b>${l.qty}x ${esc(l.name)}</b><span>${brl(l.unit * l.qty)} <button type="button" class="link" data-c="rmline" data-o="${esc(o.id)}" data-i="${i}" title="Tirar este item da conta" aria-label="Tirar ${esc(l.name)}">✕</button></span>${lineChoices(l)}</li>`).join('')}</ul>
        ${o.obs ? `<p class="muted small">📝 ${esc(o.obs)}</p>` : ''}
      </div>`).join('')}
      <div class="total"><span>Total da conta</span><strong>${brl(c.total)}</strong></div>
      ${canPay() ? '<button type="button" class="btn btn--yellow btn--block" data-c="bill">💵 Fechar a conta</button>' : c.contaPedida ? '<p class="muted small">O caixa já foi avisado para fechar a conta.</p>' : ''}` : '';
  }
  function renderCmdDraft() {
    if (!cmd || !$('cmdDraft')) return;
    const total = Core.subtotalOf(cmd.draft);
    const qty = cmd.draft.reduce((s, l) => s + l.qty, 0);
    $('cmdDraft').innerHTML = cmd.draft.length ? `<ul class="lines">${cmd.draft.map((l, i) => `<li><b>${esc(l.name)}</b>
        <span class="qty"><button type="button" data-c="dq" data-i="${i}" data-d="-1" aria-label="Menos">−</button><b>${l.qty}</b><button type="button" data-c="dq" data-i="${i}" data-d="1" aria-label="Mais">+</button></span>
        ${lineChoices(l)}<small>${brl(l.unit * l.qty)}</small></li>`).join('')}</ul>
      <button type="button" class="btn btn--yellow btn--block" data-c="send">🔥 Enviar para a cozinha · ${brl(total)}</button>`
      : '<p class="muted small">Toque nos produtos do cardápio para adicionar.</p>';
    $('cmdBar').hidden = !cmd.draft.length;
    $('cmdBarCount').textContent = qty;
    $('cmdBarLabel').textContent = qty === 1 ? 'item' : 'itens';
    $('cmdBarTotal').textContent = brl(total);
  }
  $('cmdBar').addEventListener('click', () => $('cmdDraft').scrollIntoView({ block: 'center', behavior: 'smooth' }));
  $('cmdSide').addEventListener('input', e => {
    if (e.target.id === 'cmdNome') cmd.nome = e.target.value;
    if (e.target.id === 'cmdObs') cmd.obs = e.target.value;
    if (e.target.id === 'cmdTel') cmd.telefone = e.target.value;
    if (e.target.id === 'cmdOrigem') { cmd.origem = e.target.value; $('cmdTitle').innerHTML = `🥡 ${esc(cmdLabel())} · ${esc(ORIGEM_LABEL[cmd.origem])}`; }
  });
  // Nome mudou numa mesa já aberta: vale para a conta toda
  $('cmdSide').addEventListener('change', e => {
    const c = currentCmd();
    if (e.target.id !== 'cmdNome' || !c) return;
    const nome = cmd.nome.trim().slice(0, 60);
    safe('Erro ao salvar o nome', () => Promise.all(c.pedidos.map(o => DB.updateOrder(o.id, { 'comanda.nome': nome, 'cliente.nome': nome }))));
  });
  $('cmdModal').addEventListener('click', e => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    const a = b.dataset.c;
    const c = currentCmd();
    if (a === 'close') return closeCmd();
    if (a === 'dq') {
      const l = cmd.draft[+b.dataset.i];
      l.qty += +b.dataset.d;
      if (l.qty <= 0) cmd.draft.splice(+b.dataset.i, 1);
      return renderCmdDraft();
    }
    if (a === 'send') return sendCmd();
    if (!c) return;
    if (a === 'ask') return safe('Erro', () => Promise.all(c.pedidos.map(o => DB.updateOrder(o.id, { 'comanda.contaPedida': !c.contaPedida })))).then(() => toast(c.contaPedida ? 'Pedido de conta desfeito' : `🧾 Caixa avisado: ${cmdLabel()} quer a conta`));
    if (a === 'print') return printBill(c);
    if (a === 'move') return openMove(c);
    if (a === 'bill') return openBill(c.key);
    if (a === 'served') { const o = c.pedidos.find(x => x.id === b.dataset.o); if (o) setStatus(o, 'concluido'); return; }
    if (a === 'whats') { const o = c.pedidos.find(x => x.id === b.dataset.o); if (o) notify(o, 'pronto'); return; }
    if (a === 'rmline') return removeLine(c.pedidos.find(x => x.id === b.dataset.o), +b.dataset.i);
    if (a === 'cancelone') {
      const o = c.pedidos.find(x => x.id === b.dataset.o);
      if (!o) return;
      const motivo = prompt(`Cancelar o envio ${Core.shortCode(o.id)} (${itemsSummary(o)} · ${brl(o.total)})? Escreva o motivo:`);
      if (motivo === null) return;
      return setStatus(o, 'cancelado', { cancelMotivo: motivo.trim().slice(0, 140), 'comanda.aberta': false }).then(() => toast(`Envio ${Core.shortCode(o.id)} cancelado`));
    }
    if (a === 'cancel') {
      const motivo = prompt(`Cancelar a ${cmdLabel()} inteira (${c.itens} itens · ${brl(c.total)})? Isso cancela todos os pedidos dela.\n\nEscreva o motivo:`);
      if (motivo === null) return;
      const extra = { cancelMotivo: motivo.trim().slice(0, 140), 'comanda.aberta': false, 'comanda.contaPedida': false };
      return Promise.all(c.pedidos.map(o => setStatus(o, 'cancelado', extra))).then(() => { toast(`${cmdLabel()} cancelada`); cmd.draft = []; closeCmd(); });
    }
  });
  // Tira um item de um envio que já foi para a cozinha (o estoque volta). Último item = cancela o envio.
  async function removeLine(o, i) {
    const l = o?.itens?.[i];
    if (!l) return;
    if (o.itens.length === 1) {
      const motivo = prompt(`${l.qty}x ${l.name} é o único item do envio ${Core.shortCode(o.id)}. Cancelar o envio? Escreva o motivo:`);
      if (motivo === null) return;
      return setStatus(o, 'cancelado', { cancelMotivo: motivo.trim().slice(0, 140), 'comanda.aberta': false });
    }
    if (!confirm(`Tirar ${l.qty}x ${l.name} (${brl(l.unit * l.qty)}) da conta?`)) return;
    const itens = o.itens.filter((_, k) => k !== i);
    await safe('Erro ao tirar o item', async () => {
      await DB.updateOrder(o.id, { itens, ...Core.totalsOf({ ...o, itens }) });
      const est = state.cfg.estoque?.itens || {};
      if (o.estoqueBaixado && typeof est[l.id]?.qtd === 'number') await DB.addStock({ [l.id]: l.qty });
      toast(`${l.qty}x ${l.name} tirado da conta`);
    });
  }
  async function sendCmd() {
    if (!cmd.draft.length) return toast('Adicione itens do cardápio', true);
    const nome = cmd.nome.trim();
    const ret = cmd.tipo === 'retirada';
    if (ret && !nome) { $('cmdNome')?.focus(); return toast('Coloque o nome do cliente da retirada', true); }
    if (ret && cmd.telefone && !BaldiniMask.validPhone(cmd.telefone)) return toast('WhatsApp inválido: use DDD + número', true);
    const em = Date.now();
    const o = Core.sanitizeOrder({
      id: Core.newOrderId(), origem: ret ? cmd.origem : 'mesa', status: 'novo', itens: cmd.draft,
      cliente: { nome, telefone: ret ? cmd.telefone.trim() : '' }, entrega: { tipo: ret ? 'Retirada na Loja (Av. Rosita Freire, 460)' : 'Comer no local' }, pagamento: { forma: 'A definir', pago: false },
      obs: cmd.obs.trim(), comanda: { tipo: cmd.tipo, numero: cmd.numero, aberta: true, nome, contaPedida: !!currentCmd()?.contaPedida },
      criadoEm: em, historico: [{ status: 'novo', em }]
    });
    await safe('Erro ao enviar', async () => {
      await DB.saveOrder(o);
      state.seen.add(o.id);
      cmd.draft = []; cmd.obs = '';
      if ($('cmdObs')) $('cmdObs').value = '';
      renderCmdDraft();
      renderCmdSide();
      toast(`🔥 ${cmdLabel()}: pedido ${Core.shortCode(o.id)} enviado para a cozinha`);
    });
  }
  function printBill(c) {
    const linhas = c.pedidos.flatMap(o => o.itens || []);
    $('printArea').innerHTML = `<h1>BALDINI BURGUER</h1><h2>${esc(Core.comandaLabel(c))}${c.nome ? ' · ' + esc(c.nome) : ''}</h2><p>${new Date().toLocaleString('pt-BR')}</p><hr>
      ${linhas.map(l => `<p>${l.qty}x ${esc(l.name)} <b>${brl(l.unit * l.qty)}</b>${(l.choices || []).map(ch => `<br>&nbsp;- ${esc(ch.items.map(i => (i.qty > 1 ? i.qty + 'x ' : '') + i.name).join(', '))}`).join('')}</p>`).join('')}
      <hr><h2>TOTAL ${brl(c.total)}</h2><p>Conferência de conta. Não é documento fiscal.</p>`;
    window.print();
  }

  // Trocar de mesa ou juntar com outra (se a escolhida estiver ocupada, as contas viram uma só)
  function openMove(c) {
    const open = Core.openComandas(state.orders);
    const opts = [];
    for (let n = 1; n <= mesasCount(); n++) opts.push({ tipo: 'mesa', numero: n });
    open.forEach(x => { if (!opts.some(o => Core.comandaKey(o) === x.key)) opts.push({ tipo: x.tipo, numero: x.numero }); });
    opts.push({ tipo: 'comanda', numero: Core.nextComanda(state.orders), nova: true });
    $('payBody').innerHTML = `<header class="modal__head"><h2>Trocar ${esc(Core.comandaLabel(c))} <small>Escolha para onde vai. Se estiver ocupada, as duas contas viram uma só.</small></h2><button type="button" class="icon-btn" data-x="close" aria-label="Fechar">✕</button></header>
      <div class="tables tables--sm">${opts.filter(o => Core.comandaKey(o) !== c.key).map(o => {
        const busy = open.get(Core.comandaKey(o));
        return `<button type="button" class="tbl${busy ? ' tbl--ocupada' : ''}" data-x="to" data-t="${o.tipo}" data-n="${o.numero}"><small>${o.nova ? 'Nova comanda' : o.tipo === 'mesa' ? 'Mesa' : 'Comanda'}</small><b>${o.numero}</b><span class="muted">${busy ? `Juntar · ${brl(busy.total)}` : 'Livre'}</span></button>`;
      }).join('')}</div>`;
    payCtx = { kind: 'move', key: c.key };
    if (!$('payModal').open) $('payModal').showModal();
  }
  async function moveTo(fromKey, to) {
    const c = Core.openComandas(state.orders).get(fromKey);
    if (!c) return;
    const dest = Core.openComandas(state.orders).get(Core.comandaKey(to));
    if (dest && !confirm(`Juntar ${Core.comandaLabel(c)} com ${Core.comandaLabel(to)}? Os itens das duas ficam numa conta só.`)) return;
    await safe('Erro ao trocar', () => Promise.all(c.pedidos.map(o => DB.updateOrder(o.id, { 'comanda.tipo': to.tipo, 'comanda.numero': to.numero }))));
    $('payModal').close();
    toast(`🔁 ${Core.comandaLabel(c)} → ${Core.comandaLabel(to)}`);
    if (cmd && Core.comandaKey(cmd) === fromKey) { cmd.tipo = to.tipo; cmd.numero = to.numero; renderCmdSide(); }
  }

  // ---------- Caixa: fechar conta ----------
  let payCtx = null;
  function openBill(key) {
    const c = Core.openComandas(state.orders).get(key);
    if (!c) return toast('Essa conta já foi fechada', true);
    payCtx = { kind: 'bill', key, metodo: '', desconto: 0, recebido: 0 };
    renderBill();
    if (!$('payModal').open) $('payModal').showModal();
  }
  function renderBill() {
    const c = Core.openComandas(state.orders).get(payCtx.key);
    if (!c) { $('payModal').close(); return; }
    const total = Core.round2(Math.max(0, c.total - payCtx.desconto));
    const troco = payCtx.metodo === 'Dinheiro' && payCtx.recebido > total ? Core.round2(payCtx.recebido - total) : 0;
    $('payBody').innerHTML = `<header class="modal__head"><h2>Fechar conta · ${esc(Core.comandaLabel(c))}${c.nome ? ` <small>${esc(c.nome)}</small>` : ''}</h2><button type="button" class="icon-btn" data-x="close" aria-label="Fechar">✕</button></header>
      <ul class="lines">${c.pedidos.flatMap(o => o.itens || []).map(l => `<li><b>${l.qty}x ${esc(l.name)}</b><span>${brl(l.unit * l.qty)}</span></li>`).join('')}</ul>
      <div class="grid2">
        <label class="field">Desconto<input data-x="desconto" data-mask="money" value="${payCtx.desconto ? money(payCtx.desconto) : ''}" placeholder="R$ 0,00"></label>
        <div class="total"><span>Total a receber</span><strong id="billTotal">${brl(total)}</strong></div>
      </div>
      <h4>Como pagou?</h4>
      <div class="paygrid">${['Pix', 'Débito', 'Crédito', 'Dinheiro', ...(c.origem === 'ifood' ? ['iFood'] : [])].map(m => `<button type="button" class="paybtn${payCtx.metodo === m ? ' is-on' : ''}" data-x="metodo" data-p="${m}">${{ Pix: '⚡', 'Débito': '💳', 'Crédito': '💳', Dinheiro: '💵', iFood: '🛵' }[m]} ${m === 'iFood' ? 'Pago no iFood' : m}</button>`).join('')}</div>
      ${payCtx.metodo === 'Dinheiro' ? `<div class="grid2"><label class="field">Valor recebido<input data-x="recebido" data-mask="money" value="${payCtx.recebido ? money(payCtx.recebido) : ''}" placeholder="R$ 0,00"></label>
        <div class="total"><span>Troco</span><strong id="billTroco">${brl(troco)}</strong></div></div>` : ''}
      ${payCtx.metodo && !['Dinheiro', 'iFood'].includes(payCtx.metodo) ? `<p class="muted small">Na maquininha: digite <b class="big">${brl(total)}</b></p>` : ''}
      <footer class="modal__foot"><button type="button" class="btn btn--ghost" data-x="close">Voltar</button>
        <button type="button" class="btn btn--yellow" data-x="confirm"${payCtx.metodo ? '' : ' disabled'}>✔ Receber ${brl(total)}</button></footer>`;
  }
  $('payBody').addEventListener('click', e => {
    const b = e.target.closest('[data-x]');
    if (!b || b.tagName === 'INPUT') return;
    const x = b.dataset.x;
    if (x === 'close') return $('payModal').close();
    if (x === 'to') return moveTo(payCtx.key, { tipo: b.dataset.t, numero: Number(b.dataset.n) });
    if (x === 'metodo') { payCtx.metodo = b.dataset.p; return renderBill(); }
    if (x === 'confirm') return closeBill();
  });
  // Desconto e troco recalculam sem redesenhar o campo que está sendo digitado
  $('payBody').addEventListener('input', e => {
    if (payCtx?.kind !== 'bill') return;
    const c = Core.openComandas(state.orders).get(payCtx.key);
    if (!c) return;
    if (e.target.dataset.x === 'desconto') payCtx.desconto = Math.min(c.total, num(e.target.value));
    if (e.target.dataset.x === 'recebido') payCtx.recebido = num(e.target.value);
    const total = Core.round2(Math.max(0, c.total - payCtx.desconto));
    $('billTotal').textContent = brl(total);
    if ($('billTroco')) $('billTroco').textContent = brl(payCtx.recebido > total ? payCtx.recebido - total : 0);
    const ok = $('payBody').querySelector('[data-x="confirm"]');
    if (ok) ok.textContent = `✔ Receber ${brl(total)}`;
  });
  $('payModal').addEventListener('close', () => { payCtx = null; });
  async function closeBill() {
    const c = Core.openComandas(state.orders).get(payCtx.key);
    if (!c || !payCtx.metodo) return;
    const { metodo, recebido } = payCtx;
    let desconto = payCtx.desconto;
    const em = Date.now();
    // O desconto sai dos últimos pedidos da conta
    const patches = [...c.pedidos].reverse().map(o => {
      const tira = Math.min(desconto, Number(o.total) || 0);
      desconto = Core.round2(desconto - tira);
      const patch = { 'pagamento.pago': true, 'pagamento.metodo': metodo, 'pagamento.forma': metodo, 'pagamento.em': em, 'comanda.aberta': false, 'comanda.contaPedida': false };
      if (tira > 0) Object.assign(patch, { desconto: Core.round2((o.desconto || 0) + tira) }, Core.totalsOf({ ...o, desconto: (o.desconto || 0) + tira }));
      // Já foi servido: sai do quadro da cozinha
      if (o.status === 'pronto') Object.assign(patch, { status: 'concluido', historico: [...(o.historico || []), { status: 'concluido', em }].slice(-30) });
      return [o.id, patch];
    });
    if (metodo === 'Dinheiro' && recebido) patches[0][1]['pagamento.troco'] = money(recebido);
    await safe('Erro ao fechar a conta', async () => {
      await Promise.all(patches.map(([id, p]) => DB.updateOrder(id, p)));
      $('payModal').close();
      toast(`💵 ${Core.comandaLabel(c)} recebida no ${metodo}`);
      if (cmd && Core.comandaKey(cmd) === c.key) { cmd.draft = []; closeCmd(); }
    });
  }

  // ---------- Caixa e desempenho ----------
  const PAY_LABEL = { Pix: 'Pix', 'Crédito': 'Cartão de crédito', 'Débito': 'Cartão de débito', Dinheiro: 'Dinheiro', Online: 'Online (link)', iFood: 'iFood' };
  const PAY_VAR = { Pix: 'pix', 'Crédito': 'credito', 'Débito': 'debito', Dinheiro: 'dinheiro', Online: 'online', iFood: 'ifood' };
  $('caixaSeg').addEventListener('click', e => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    state.caixaPeriod = b.dataset.p;
    $('caixaSeg').querySelectorAll('button').forEach(x => x.classList.toggle('is-on', x === b));
    renderCaixa();
  });
  // Pizza (rosca) com o valor de cada forma de pagamento
  function pieChart(r) {
    const parts = Core.PAY_ORDER.filter(k => r.porForma[k] > 0 || ['Pix', 'Crédito', 'Débito', 'Dinheiro'].includes(k)).map(k => ({ k, v: r.porForma[k], n: r.qtdForma[k] }));
    const total = r.recebido;
    const R = 92, ri = 58, cx = 100, cy = 100;
    const pt = (rad, a) => `${(cx + rad * Math.cos(a)).toFixed(2)} ${(cy + rad * Math.sin(a)).toFixed(2)}`;
    let a = -Math.PI / 2;
    const slices = total ? parts.filter(p => p.v > 0).map(p => {
      const ang = p.v / total * 2 * Math.PI;
      const color = `var(--pay-${PAY_VAR[p.k]})`;
      const pct = (p.v / total * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
      const tip = `data-tip="${esc(PAY_LABEL[p.k])}: ${brl(p.v)} · ${pct}% · ${p.n} pagamento${p.n > 1 ? 's' : ''}"`;
      let el;
      if (ang >= 2 * Math.PI - 1e-6) el = `<circle cx="${cx}" cy="${cy}" r="${(R + ri) / 2}" fill="none" stroke="${color}" stroke-width="${R - ri}" ${tip}/>`;
      else {
        const big = ang > Math.PI ? 1 : 0;
        el = `<path d="M ${pt(R, a)} A ${R} ${R} 0 ${big} 1 ${pt(R, a + ang)} L ${pt(ri, a + ang)} A ${ri} ${ri} 0 ${big} 0 ${pt(ri, a)} Z" fill="${color}" ${tip}/>`;
      }
      a += ang;
      return el;
    }).join('') : `<circle cx="${cx}" cy="${cy}" r="${(R + ri) / 2}" fill="none" stroke="var(--line)" stroke-width="${R - ri}"/>`;
    return `<div class="pie__chart"><svg viewBox="0 0 200 200" role="img" aria-label="Faturamento por forma de pagamento">${slices}
        <text x="100" y="96" text-anchor="middle" class="pie__total">${brl(total)}</text><text x="100" y="116" text-anchor="middle" class="pie__sub">recebido</text></svg>
        <div class="pie__tip" id="pieTip" hidden></div></div>
      <ul class="pie__legend">${parts.map(p => `<li><i style="background:var(--pay-${PAY_VAR[p.k]})"></i><span>${PAY_LABEL[p.k]}<small>${p.n} pagamento${p.n === 1 ? '' : 's'}</small></span>
        <b>${brl(p.v)}</b><em>${total ? (p.v / total * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : 0}%</em></li>`).join('')}</ul>`;
  }
  $('pie').addEventListener('mousemove', e => {
    const tip = $('pieTip');
    const s = e.target.closest('[data-tip]');
    if (!tip) return;
    if (!s) { tip.hidden = true; return; }
    const box = $('pie').querySelector('.pie__chart').getBoundingClientRect();
    tip.textContent = s.dataset.tip;
    tip.hidden = false;
    tip.style.left = `${e.clientX - box.left}px`;
    tip.style.top = `${e.clientY - box.top}px`;
  });
  $('pie').addEventListener('mouseleave', () => { if ($('pieTip')) $('pieTip').hidden = true; });
  function renderCaixa() {
    const [from, to] = periodRange(state.caixaPeriod);
    const r = Core.cashReport(state.orders, { from, to });
    const open = [...Core.openComandas(state.orders).values()].sort((a, b) => b.contaPedida - a.contaPedida || a.abertaEm - b.abertaEm);
    const unpaid = state.orders.filter(o => !o.comanda?.aberta && Core.countsAsSale(o) && !o.pagamento?.pago && o.criadoEm >= startOfDay());
    const aReceber = open.reduce((s, c) => s + c.total, 0) + unpaid.reduce((s, o) => s + (o.total || 0), 0);
    const k = (label, v, cls = '') => `<div class="kpi ${cls}"><span>${label}</span><strong>${v}</strong></div>`;
    $('caixaKpis').innerHTML = k('Recebido', brl(r.recebido), 'pos') + k('A receber agora', brl(aReceber)) + k('Pagamentos', r.pagos.length) + k('Dinheiro na gaveta', brl(r.porForma.Dinheiro));
    $('pie').innerHTML = pieChart(r);
    $('caixaOpen').innerHTML = (open.length ? `<h4>Mesas e comandas abertas</h4>${open.map(c => `<div class="drow drow--cmd${c.contaPedida ? ' is-conta' : ''}">
        <span><b>${esc(Core.comandaLabel(c))}</b>${c.nome ? ` · ${esc(c.nome)}` : ''} <small class="muted">${c.itens} itens · ${ago(c.abertaEm)}</small>${c.contaPedida ? ' <span class="tag tag--conta">🧾 pediu a conta</span>' : ''}</span>
        <span><b>${brl(c.total)}</b> <button type="button" class="btn btn--sm btn--yellow" data-bill="${c.key}">Fechar conta</button></span></div>`).join('')}` : '') +
      (unpaid.length ? `<h4>Pedidos sem pagamento (hoje)</h4>${unpaid.map(o => `<div class="drow">
        <span><b>${esc(Core.shortCode(o.id))}</b> ${esc(o.cliente?.nome || '')} <small class="muted">${origemTag(o)} · ${esc(o.pagamento?.forma || '')}${o.pagamento?.troco ? ' · troco ' + esc(o.pagamento.troco) : ''}</small></span>
        <span><b>${brl(o.total)}</b> ${['Pix', 'Débito', 'Crédito', 'Dinheiro'].map(m => `<button type="button" class="btn btn--sm btn--ghost" data-pay="${esc(o.id)}" data-p="${m}">${m}</button>`).join('')}</span></div>`).join('')}` : '') ||
      '<p class="muted small">Nenhuma conta aberta. 👌</p>';
    $('caixaList').innerHTML = r.pagos.length ? `<table class="table table--cards"><thead><tr><th>Hora</th><th>Pedido</th><th>Forma</th><th>Valor</th></tr></thead><tbody>
      ${r.pagos.slice(0, 60).map(o => `<tr><td class="tc-head"><b>${hhmm(Core.paidAt(o))}</b> <small class="muted">${new Date(Core.paidAt(o)).toLocaleDateString('pt-BR')}</small></td>
        <td data-label="Pedido">${esc(Core.shortCode(o.id))} · ${origemTag(o)}${o.cliente?.nome ? ' · ' + esc(o.cliente.nome) : ''}</td>
        <td data-label="Forma"><i class="dot" style="background:var(--pay-${PAY_VAR[Core.payKey(o)]})"></i>${esc(o.pagamento?.metodo || o.pagamento?.forma || '')}</td><td data-label="Valor"><b>${brl(o.total)}</b></td></tr>`).join('')}
      </tbody></table>` : '<p class="muted small">Nenhum pagamento recebido no período.</p>';
  }
  $('caixaOpen').addEventListener('click', e => {
    const bill = e.target.closest('[data-bill]')?.dataset.bill;
    if (bill) return openBill(bill);
    const b = e.target.closest('[data-pay]');
    const o = b && state.orders.find(x => x.id === b.dataset.pay);
    if (o && confirm(`Receber ${brl(o.total)} do pedido ${Core.shortCode(o.id)} no ${b.dataset.p}?`)) payOrder(o, b.dataset.p).then(() => toast(`💵 ${Core.shortCode(o.id)} recebido`));
  });

  // ---------- Estoque ----------
  let stockFilter = 'todos', stockDirty = false;
  const STOCK_TAG = { falta: '❌ Em falta', baixo: '⚠️ Acabando', ok: '✅ Disponível', livre: '— Sem controle' };
  function renderStock() {
    // Não redesenha enquanto alguém digita uma quantidade (redesenha quando sair do campo)
    if ($('stockList').contains(document.activeElement) && document.activeElement.tagName === 'INPUT') { stockDirty = true; return; }
    stockDirty = false;
    const itens = state.cfg.estoque?.itens || {};
    const q = Core.norm($('stockSearch').value);
    const count = { falta: 0, baixo: 0, ok: 0, livre: 0 };
    products.forEach(p => { count[Core.stockStatus(itens[p.id])]++; });
    const k = (label, v, cls, f) => `<button type="button" class="kpi ${cls}" data-f="${f}"><span>${label}</span><strong>${v}</strong></button>`;
    $('stockKpis').innerHTML = k('❌ Em falta', count.falta, 'neg', 'falta') + k('⚠️ Acabando', count.baixo, 'warn', 'baixo') + k('✅ Disponíveis', count.ok, 'pos', 'ok') + k('Sem controle', count.livre, '', 'livre');
    const html = MENU.map(cat => {
      const rows = cat.items.filter(p => (!q || Core.norm(p.name).includes(q)) && (stockFilter === 'todos' || Core.stockStatus(itens[p.id]) === stockFilter));
      if (!rows.length) return '';
      return `<div class="card stock-cat"><h3>${esc(cat.name)}</h3>${rows.map(p => {
        const e = itens[p.id], st = Core.stockStatus(e), on = st !== 'livre';
        return `<div class="srow srow--${st}" data-sid="${p.id}">
          <span class="srow__name">${esc(p.name)}<small class="stag stag--${st}">${STOCK_TAG[st]}</small></span>
          <span class="qty"><button type="button" data-s="dec" aria-label="Menos um">−</button><input data-s="qtd" inputmode="numeric" maxlength="5" value="${on ? e.qtd : ''}" placeholder="—" aria-label="Quantidade de ${esc(p.name)}"><button type="button" data-s="inc" aria-label="Mais um">+</button></span>
          <label class="srow__min">mín.<input data-s="min" inputmode="numeric" maxlength="4" value="${on ? (e.min || 0) : ''}"${on ? '' : ' disabled'} aria-label="Mínimo de ${esc(p.name)}"></label>
          ${on ? '<button type="button" class="link" data-s="off" title="Parar de controlar o estoque deste produto" aria-label="Parar de controlar">✕</button>' : '<span></span>'}
        </div>`;
      }).join('')}</div>`;
    }).join('');
    $('stockList').innerHTML = html || '<p class="muted small">Nenhum produto aqui.</p>';
  }
  function setStockFilter(f) {
    stockFilter = f;
    $('stockFilter').querySelectorAll('button').forEach(x => x.classList.toggle('is-on', x.dataset.f === f));
    renderStock();
  }
  $('stockFilter').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (b) setStockFilter(b.dataset.f); });
  $('stockKpis').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (b) setStockFilter(stockFilter === b.dataset.f ? 'todos' : b.dataset.f); });
  $('stockSearch').addEventListener('input', renderStock);
  $('stockList').addEventListener('focusout', () => setTimeout(() => { if (stockDirty) renderStock(); }, 0));
  $('stockList').addEventListener('click', e => {
    const b = e.target.closest('button[data-s]');
    const id = e.target.closest('[data-sid]')?.dataset.sid;
    if (!b || !id) return;
    const cur = state.cfg.estoque?.itens?.[id];
    const on = typeof cur?.qtd === 'number';
    const s = b.dataset.s;
    if (s === 'inc') return safe('Erro no estoque', () => (on ? DB.addStock({ [id]: 1 }) : DB.setStockItem(id, { qtd: 1, min: 0 })));
    if (s === 'dec' && on) return safe('Erro no estoque', () => DB.addStock({ [id]: -1 }));
    if (s === 'off' && confirm(`Parar de controlar o estoque de ${products.get(id)?.name}?`)) return safe('Erro no estoque', () => DB.setStockItem(id, null));
  });
  $('stockList').addEventListener('change', e => {
    const s = e.target.dataset.s;
    const id = e.target.closest('[data-sid]')?.dataset.sid;
    if (!id || !['qtd', 'min'].includes(s)) return;
    const cur = state.cfg.estoque?.itens?.[id] || {};
    const raw = e.target.value.replace(/\D/g, '');
    if (raw === '') { stockDirty = true; return; }
    const n = Math.min(99999, Number(raw));
    const data = s === 'qtd' ? { qtd: n, min: Number(cur.min) || 0 } : { qtd: Number(cur.qtd) || 0, min: n };
    safe('Erro no estoque', () => DB.setStockItem(id, data));
  });

  // ---------- Cardápio: preços, produtos novos e escondidos ----------
  let menuDirty = false;
  const baseProduct = id => { for (const c of BASE_MENU) for (const p of c.items) if (p.id === id) return p; return null; };
  // Opções que definem o preço (tamanho, sabor, burger do combo): grupos de escolha obrigatória
  const priceGroups = p => (p.groups || []).filter(g => g.min > 0);
  function saveMenu(mudar, aviso) {
    const aj = JSON.parse(JSON.stringify(state.cfg.cardapio || {}));
    aj.precos = aj.precos || {}; aj.opcoes = aj.opcoes || {}; aj.ocultos = aj.ocultos || []; aj.novos = aj.novos || [];
    mudar(aj);
    // Guarda já: duas mudanças seguidas não se atropelam enquanto o banco responde
    state.cfg.cardapio = aj;
    return safe('Erro ao salvar o cardápio', async () => {
      await DB.setConfig('cardapio', { dados: JSON.stringify(aj), atualizadoEm: Date.now(), por: state.user?.nome || state.user?.email || '' });
      if (aviso) toast(aviso);
    });
  }
  function renderMenuEdit() {
    if (!Cardapio) { $('menuEdit').innerHTML = '<p class="error">O site de pedidos não respondeu: não dá para editar o cardápio agora. Recarregue a página.</p>'; return; }
    if ($('menuEdit').contains(document.activeElement) && document.activeElement.tagName === 'INPUT') { menuDirty = true; return; }
    menuDirty = false;
    $('newProdCat').innerHTML = menuFull.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    const q = Core.norm($('menuSearch').value);
    $('menuEdit').innerHTML = menuFull.map(cat => {
      const rows = cat.items.filter(p => !q || Core.norm(p.name).includes(q));
      if (!rows.length) return '';
      return `<div class="card stock-cat"><h3>${esc(cat.name)}</h3>${rows.map(p => {
        const base = baseProduct(p.id);
        const opts = priceGroups(p);
        const usaOpcoes = !p.price && opts.length;
        const mudou = base && base.price !== p.price;
        return `<div class="mrow${p.oculto ? ' is-off' : ''}" data-mid="${esc(p.id)}">
          <span class="mrow__name">${p.novo ? `<input data-k="nome" value="${esc(p.name)}" maxlength="80" aria-label="Nome do produto">` : esc(p.name)}
            <small>${p.novo ? '<span class="tag tag--ok">novo</span> ' : ''}${p.oculto ? '<span class="tag">escondido</span> ' : ''}${mudou ? `<span class="muted">antes ${brl(base.price)}</span>` : ''}</small></span>
          ${usaOpcoes ? '<span class="muted small">preço nas opções ↓</span>' : `<label class="mrow__price">R$<input data-k="preco" data-mask="money" value="${money(p.price)}" aria-label="Preço de ${esc(p.name)}"></label>`}
          <label class="check mrow__on"><input type="checkbox" data-k="on"${p.oculto ? '' : ' checked'}> No cardápio</label>
          ${p.novo ? '<button type="button" class="link" data-k="del" title="Apagar produto novo">Apagar</button>' : '<span></span>'}
          ${opts.length ? `<details class="mrow__opts"${usaOpcoes ? '' : ''}><summary>Preços das opções</summary>${opts.map((g, gi) => `<p class="muted small">${esc(g.name)}</p>${g.options.map(o => `<label class="crow"><span>${esc(o.name)}</span><input data-k="opt" data-opt="${esc(o.name)}" data-mask="money" value="${money(o.price)}"></label>`).join('')}`).join('')}</details>` : ''}
        </div>`;
      }).join('')}</div>`;
    }).join('') || '<p class="muted small">Nenhum produto encontrado.</p>';
  }
  $('menuSearch').addEventListener('input', renderMenuEdit);
  $('menuEdit').addEventListener('focusout', () => setTimeout(() => { if (menuDirty) renderMenuEdit(); }, 0));
  $('menuEdit').addEventListener('change', e => {
    const id = e.target.closest('[data-mid]')?.dataset.mid;
    const k = e.target.dataset.k;
    const p = id && products.get(id);
    if (!p) return;
    const base = baseProduct(id);
    if (k === 'preco') {
      const v = Core.round2(num(e.target.value));
      return saveMenu(aj => {
        if (p.novo) { const n = aj.novos.find(x => x.id === id); if (n) n.price = v; }
        else if (base && base.price === v) delete aj.precos[id]; else aj.precos[id] = v;
      }, `💲 ${p.name}: ${brl(v)}`);
    }
    if (k === 'opt') {
      const v = Core.round2(num(e.target.value)), nome = e.target.dataset.opt, key = id + '::' + nome;
      const orig = (base?.groups || []).flatMap(g => g.options).find(o => o.name === nome);
      return saveMenu(aj => { if (orig && orig.price === v) delete aj.opcoes[key]; else aj.opcoes[key] = v; }, `💲 ${p.name} · ${nome}: ${brl(v)}`);
    }
    if (k === 'on') {
      const on = e.target.checked;
      return saveMenu(aj => { aj.ocultos = aj.ocultos.filter(x => x !== id); if (!on) aj.ocultos.push(id); }, on ? `✅ ${p.name} voltou ao cardápio` : `🙈 ${p.name} escondido do cardápio`);
    }
    if (k === 'nome') {
      const nome = e.target.value.trim().slice(0, 80);
      if (!nome) return toast('O nome não pode ficar vazio', true);
      return saveMenu(aj => { const n = aj.novos.find(x => x.id === id); if (n) n.name = nome; }, 'Nome salvo ✅');
    }
  });
  $('menuEdit').addEventListener('click', e => {
    if (e.target.dataset.k !== 'del') return;
    const id = e.target.closest('[data-mid]')?.dataset.mid;
    const p = products.get(id);
    if (p && confirm(`Apagar ${p.name} do cardápio?`)) saveMenu(aj => { aj.novos = aj.novos.filter(x => x.id !== id); aj.ocultos = aj.ocultos.filter(x => x !== id); }, `${p.name} apagado`);
  });
  $('newProdForm').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target.elements;
    const nome = f.nome.value.trim(), preco = Core.round2(num(f.preco.value));
    if (!nome || !(preco > 0)) return toast('Preencha o nome e o preço', true);
    const id = 'novo-' + Core.norm(nome).replace(/ /g, '-').slice(0, 40) + '-' + Date.now().toString(36);
    saveMenu(aj => { aj.novos.push({ id, cat: f.cat.value, name: nome, desc: f.desc.value.trim().slice(0, 300), price: preco }); }, `✅ ${nome} adicionado ao cardápio`)
      .then(() => { const cat = f.cat.value; e.target.reset(); f.cat.value = cat; });
  });

  // ---------- Equipe (dono) ----------
  function renderTeam() {
    const me = state.user?.uid;
    const dono = state.cargo === 'dono';
    const ordem = { dono: 0, gerente: 1, funcionario: 2 };
    const list = [...state.team].sort((a, b) => ordem[Core.cargoOf(a)] - ordem[Core.cargoOf(b)] || String(a.nome || '').localeCompare(b.nome || ''));
    $('teamList').innerHTML = list.length ? list.map(m => {
      const c = Core.cargoOf(m), self = m.uid === me;
      return `<div class="drow team-row" data-uid="${esc(m.uid)}"><span><b>${esc(m.nome || 'Sem nome')}</b>${self ? ' <span class="tag">você</span>' : ''}<small class="muted">${m.usuario ? 'usuário: ' + esc(m.usuario) : esc(m.email || m.uid)}</small></span>
        <span class="team-row__acts">${dono ? `<select data-t="cargo" aria-label="Cargo de ${esc(m.nome || '')}"${self ? ' disabled title="Você não pode mudar o próprio cargo"' : ''}>${Object.entries(Core.CARGOS).map(([k, v]) => `<option value="${k}"${k === c ? ' selected' : ''}>${v.icon} ${v.label}</option>`).join('')}</select>` : `<span class="tag">${Core.CARGOS[c].icon} ${Core.CARGOS[c].label}</span>`}
        ${self || !(dono || c === 'funcionario') ? '' : '<button type="button" class="btn btn--sm btn--danger" data-t="rm">Tirar acesso</button>'}</span></div>`;
    }).join('') : '<p class="muted small">Ninguém cadastrado ainda.</p>';
  }
  $('teamList').addEventListener('change', e => {
    const uid = e.target.closest('[data-uid]')?.dataset.uid;
    if (uid && e.target.dataset.t === 'cargo') safe('Erro ao mudar cargo', () => DB.setMember(uid, { cargo: e.target.value })).then(() => toast('Cargo atualizado ✅'));
  });
  $('teamList').addEventListener('click', e => {
    const uid = e.target.closest('[data-uid]')?.dataset.uid;
    if (!uid || e.target.dataset.t !== 'rm') return;
    const m = state.team.find(x => x.uid === uid);
    if (confirm(`Tirar o acesso de ${m?.nome || 'esta pessoa'} à gestão?`)) safe('Erro', () => DB.removeMember(uid)).then(() => toast('Acesso removido'));
  });
  $('accountForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target.elements;
    const nome = f.nome.value.trim(), usuario = f.usuario.value.trim().toLowerCase(), senha = f.senha.value, cargo = f.cargo.value;
    if (!nome || !usuario) return toast('Preencha nome e usuário', true);
    if (!usuario.includes('@') && !/^[a-z0-9._-]{2,40}$/.test(usuario)) return toast('Usuário: só letras sem acento, números, ponto ou traço (ex.: maria.silva)', true);
    if (senha.length < 6) return toast('A senha precisa ter pelo menos 6 caracteres', true);
    if (state.cargo !== 'dono' && cargo !== 'funcionario') return toast('Gerente só cria acesso de funcionário', true);
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await DB.createAccount(toLogin(usuario), senha, { nome, cargo, usuario, liberadoEm: Date.now() });
      e.target.reset();
      $('accountInfo').hidden = false;
      $('accountInfo').innerHTML = `✅ <b>${esc(nome)}</b> (${esc(Core.CARGOS[cargo].label)}) já pode entrar com o usuário <b>${esc(usuario)}</b> e a senha <b>${esc(senha)}</b>. Anote e passe para a pessoa.`;
      toast(`✅ Acesso de ${nome} criado`);
    } catch (err) {
      console.error(err);
      toast({
        'auth/email-already-in-use': 'Esse usuário já existe. Escolha outro.',
        'auth/weak-password': 'Senha fraca: use pelo menos 6 caracteres.',
        'auth/invalid-email': 'Usuário inválido.',
        'auth/operation-not-allowed': 'Ative o login por "E-mail/senha" no Firebase (Authentication > Método de login).',
        'permission-denied': 'Sem permissão: publique as regras novas (firestore.rules) no Firebase.'
      }[err.code] || 'Não deu para criar: ' + (err.message || err), true);
    } finally { btn.disabled = false; }
  });
  $('teamForm').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target.elements;
    const uid = f.uid.value.trim(), nome = f.nome.value.trim();
    if (!uid || !nome) return toast('Preencha o código e o nome', true);
    if (/[/\s]/.test(uid)) return toast('Código inválido: copie exatamente o que aparece na tela da pessoa', true);
    if (state.cargo !== 'dono' && f.cargo.value !== 'funcionario') return toast('Gerente só libera funcionário', true);
    safe('Erro ao liberar', async () => {
      await DB.setMember(uid, { nome, cargo: f.cargo.value, liberadoEm: Date.now() });
      e.target.reset();
      toast(`✅ ${nome} liberado como ${Core.CARGOS[f.cargo.value]?.label || ''}`);
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
    if (!item.desc || item.valor <= 0 || !y) return toast('Preencha descrição, valor e data', true);
    safe('Erro ao salvar despesa', async () => { await DB.addExpense(item); f.desc.value = ''; f.valor.value = ''; toast('Despesa salva'); });
  });
  $('expenseList').addEventListener('click', e => { const id = e.target.closest('[data-rmx]')?.dataset.rmx; if (id && confirm('Remover despesa?')) safe('Erro', () => DB.deleteExpense(id)); });

  function renderCosts() {
    const c = state.cfg.custos;
    const extras = new Set();
    MENU.forEach(cat => cat.items.forEach(p => (p.groups || []).forEach(g => { if (/adicional/i.test(g.name)) g.options.forEach(o => extras.add(o.name.replace(/\s*\(extra\)/i, ''))); })));
    $('costList').innerHTML = MENU.map(cat => `<h4>${esc(cat.name)}</h4>${cat.items.map(p => `<label class="crow"><span>${esc(p.name)} <small class="muted">${p.price ? brl(p.price) : ''}</small></span><input data-cost="${p.id}" data-mask="money" placeholder="R$ 0,00" value="${c[p.id] ? money(c[p.id]) : ''}"></label>`).join('')}`).join('') +
      `<h4>Adicionais</h4>${[...extras].map(n => `<label class="crow"><span>${esc(n)}</span><input data-cost="opt:${esc(n)}" data-mask="money" placeholder="R$ 0,00" value="${c['opt:' + n] ? money(c['opt:' + n]) : ''}"></label>`).join('')}`;
  }
  $('saveCosts').addEventListener('click', () => {
    const custos = {};
    $('costList').querySelectorAll('[data-cost]').forEach(i => { const v = num(i.value); if (v > 0) custos[i.dataset.cost] = v; });
    safe('Erro ao salvar custos', async () => { await DB.setConfig('custos', custos); state.cfg.custos = custos; toast('Custos salvos ✅'); formSaved('costList'); renderProfit(); });
  });

  // ---------- Bot e mensagens ----------
  const MSG_LABELS = { novo: 'Pedido recebido', preparo: 'Em preparo', pronto: 'Pronto', entrega: 'Saiu para entrega', concluido: 'Concluído', cancelado: 'Cancelado', pagamento: 'Link de pagamento' };
  function renderMsgs() {
    $('msgForm').innerHTML = Object.entries(MSG_LABELS).map(([k, label]) => `<label class="field">${label}<textarea name="${k}" rows="2" maxlength="400">${esc(state.cfg.mensagens[k] || Core.MSG[k])}</textarea></label>`).join('');
  }
  $('saveMsgs').addEventListener('click', () => {
    const data = {};
    [...$('msgForm').elements].forEach(t => { if (t.name) data[t.name] = t.value.trim(); });
    safe('Erro ao salvar mensagens', async () => { await DB.setConfig('mensagens', data); state.cfg.mensagens = data; toast('Mensagens salvas ✅'); formSaved('msgForm'); });
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
    $('feeFields').innerHTML = Object.entries(taxas()).map(([k, v]) => `<label class="field">${k}<input data-fee="${k}" data-mask="percent" value="${String(v).replace('.', ',')}"></label>`).join('');
    f.mesas.value = l.mesas || '';
    f.infinitepayHandle.value = l.infinitepayHandle || '';
    f.pagamentoOnline.checked = !!l.pagamentoOnline;
    f.webhookUrl.value = l.webhookUrl || '';
    f.custoEntrega.value = l.custoEntrega ? money(l.custoEntrega) : '';
    f.ifoodAtivo.checked = !!l.ifoodAtivo;
    const a = autoCfg();
    f.autoAtivo.checked = !!a.ativo;
    f.autoNovo.value = a.novo; f.autoPreparo.value = a.preparo; f.autoPronto.value = a.pronto; f.autoEntrega.value = a.entrega;
    f.cnpj.value = nf.cnpj || ''; f.ncm.value = nf.ncm || ''; f.csosn.value = nf.csosn || '102'; BaldiniMask.apply($('configForm')); f.nfAuto.checked = !!nf.nfAuto;
    f.nfQuando.value = nf.nfQuando || 'pedido'; f.emissor.value = nf.emissor || 'simulacao';
  }
  $('configForm').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target.elements;
    const fees = {};
    $('feeFields').querySelectorAll('[data-fee]').forEach(i => { fees[i.dataset.fee] = num(i.value); });
    const loja = { mesas: Math.min(200, Math.round(num(f.mesas.value))) || 0, infinitepayHandle: f.infinitepayHandle.value.trim().replace(/^\$/, ''), pagamentoOnline: f.pagamentoOnline.checked, webhookUrl: f.webhookUrl.value.trim(), custoEntrega: num(f.custoEntrega.value), ifoodAtivo: f.ifoodAtivo.checked, taxas: fees };
    const mins = (v, d) => { const n = num(v); return v === '' || n < 0 ? d : Math.min(600, n); };
    loja.automacao = { ativo: f.autoAtivo.checked, novo: mins(f.autoNovo.value, Core.DEFAULT_AUTO.novo), preparo: mins(f.autoPreparo.value, Core.DEFAULT_AUTO.preparo), pronto: mins(f.autoPronto.value, Core.DEFAULT_AUTO.pronto), entrega: mins(f.autoEntrega.value, Core.DEFAULT_AUTO.entrega) };
    const nf = { cnpj: BaldiniMask.onlyDigits(f.cnpj.value), ncm: BaldiniMask.onlyDigits(f.ncm.value), csosn: f.csosn.value, nfAuto: f.nfAuto.checked, nfQuando: f.nfQuando.value, emissor: f.emissor.value };
    if (nf.cnpj && !BaldiniMask.validCnpj(nf.cnpj)) return toast('CNPJ inválido: confira os números', true);
    if (nf.ncm && nf.ncm.length !== 8) return toast('O NCM tem 8 números (ex.: 2106.90.90)', true);
    if (loja.pagamentoOnline && !loja.infinitepayHandle) return toast('Para pagar online, preencha a InfiniteTag', true);
    if (nf.nfAuto && nf.emissor === 'focus' && !nf.cnpj) return toast('Para nota de verdade, preencha o CNPJ', true);
    safe('Erro ao salvar', async () => {
      await Promise.all([DB.setConfig('loja', loja), DB.setConfig('nf', nf)]);
      state.cfg.loja = loja; state.cfg.nf = nf;
      toast('Configurações salvas ✅'); formSaved('configForm');
      autoNf(state.orders);
      autoAdvance();
      renderBoard();
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
  $('cleanTests').addEventListener('click', async () => {
    let tests;
    try { tests = await DB.findTestOrders(); } catch (e) { return toast('Não deu para buscar os pedidos de teste: ' + e.message, true); }
    const ids = new Set(tests.map(o => o.id));
    state.orders.filter(o => /^TESTE/i.test(o.cliente?.nome || '') && !ids.has(o.id)).forEach(o => tests.push(o));
    if (!tests.length) return toast('Nenhum pedido de teste encontrado');
    if (!confirm(`Apagar ${tests.length} pedido(s) de teste? Isso não tem volta.`)) return;
    let ok = 0;
    for (let i = 0; i < tests.length; i += 20) {
      const res = await Promise.allSettled(tests.slice(i, i + 20).map(o => DB.deleteOrder(o.id)));
      ok += res.filter(r => r.status === 'fulfilled').length;
    }
    toast(`${ok} pedido(s) de teste apagado(s) ✅`, ok < tests.length);
  });
  window.addEventListener('online', () => toast('Conexão de volta ✅'));
  window.addEventListener('offline', () => toast('Sem internet: continue, os dados sincronizam depois', true));
})();
