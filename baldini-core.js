// ===== Regras de negócio da Baldini (usadas no site, na gestão e nos testes) =====
// Funções puras: não mexem na tela nem no banco, por isso dá para testar tudo.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BaldiniCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const brl = v => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const round2 = v => Math.round((Number(v) || 0) * 100) / 100;
  const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const clip = (s, n) => String(s ?? '').slice(0, n);

  // ---------- Status do pedido ----------
  const STATUS = [
    { id: 'montando', label: 'Montando agora', icon: '🛒' },
    { id: 'novo', label: 'Novo', icon: '🔔' },
    { id: 'preparo', label: 'Em preparo', icon: '🔥' },
    { id: 'pronto', label: 'Pronto', icon: '✅' },
    { id: 'entrega', label: 'Saiu p/ entrega', icon: '🛵' },
    { id: 'concluido', label: 'Concluído', icon: '🏁' },
    { id: 'cancelado', label: 'Cancelado', icon: '✖' }
  ];
  const STATUS_IDS = STATUS.map(s => s.id);
  const statusInfo = id => STATUS.find(s => s.id === id) || STATUS[1];
  // Próximo passo natural (retirada pula a entrega)
  function nextStatus(order) {
    const flow = isDelivery(order) ? ['novo', 'preparo', 'pronto', 'entrega', 'concluido'] : ['novo', 'preparo', 'pronto', 'concluido'];
    const i = flow.indexOf(order.status);
    return i >= 0 && i < flow.length - 1 ? flow[i + 1] : null;
  }
  const isDelivery = o => (o.entrega?.tipo || '') === 'Delivery';
  const countsAsSale = o => !['montando', 'cancelado'].includes(o.status);

  // ---------- Ids ----------
  const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function newOrderId(rand = Math.random) {
    let s = '';
    for (let i = 0; i < 20; i++) s += ALPHA[Math.floor(rand() * ALPHA.length)];
    return s;
  }
  const shortCode = id => '#' + String(id || '').slice(0, 4);

  // ---------- Preços ----------
  // sel = um Map/objeto por grupo: { indiceDaOpcao: quantidade }
  const selEntries = s => (s instanceof Map ? [...s] : Object.entries(s || {})).map(([k, q]) => [Number(k), Number(q) || 0]);
  function unitPrice(product, sel) {
    return round2((product.price || 0) + (product.groups || []).reduce((sum, g, gi) =>
      sum + selEntries(sel[gi]).reduce((t, [oi, q]) => t + (g.options[oi]?.price || 0) * q, 0), 0));
  }
  function missingGroup(product, sel) {
    return (product.groups || []).findIndex((g, gi) => selEntries(sel[gi]).reduce((s, [, q]) => s + q, 0) < g.min);
  }
  const subtotalOf = itens => round2((itens || []).reduce((s, l) => s + (Number(l.unit) || 0) * (Number(l.qty) || 0), 0));
  function totalsOf(order) {
    const subtotal = subtotalOf(order.itens);
    const taxa = isDelivery(order) ? round2(order.entrega?.taxa || 0) : 0;
    const desconto = round2(order.desconto || 0);
    return { subtotal, taxa, desconto, total: round2(Math.max(0, subtotal + taxa - desconto)) };
  }

  // ---------- Limpeza antes de salvar (um dado ruim não derruba a gestão) ----------
  function sanitizeOrder(o) {
    const itens = (Array.isArray(o.itens) ? o.itens : []).slice(0, 60).map(l => ({
      id: clip(l.id, 80), name: clip(l.name, 120), img: l.img ? clip(l.img, 200) : null,
      unit: round2(Math.max(0, Number(l.unit) || 0)), qty: Math.min(99, Math.max(1, Math.floor(Number(l.qty) || 1))),
      note: clip(l.note, 140),
      choices: (Array.isArray(l.choices) ? l.choices : []).slice(0, 10).map(c => ({
        group: clip(c.group, 40),
        items: (Array.isArray(c.items) ? c.items : []).slice(0, 20).map(i => ({ name: clip(i.name, 80), qty: Math.max(1, Math.floor(Number(i.qty) || 1)), price: round2(i.price) }))
      }))
    }));
    const clean = {
      id: clip(o.id, 40),
      origem: ['site', 'balcao', 'whatsapp', 'ifood'].includes(o.origem) ? o.origem : 'site',
      status: STATUS_IDS.includes(o.status) ? o.status : 'novo',
      cliente: { nome: clip(o.cliente?.nome, 80), telefone: clip(o.cliente?.telefone, 30), cpf: clip(String(o.cliente?.cpf || '').replace(/\D/g, ''), 11) },
      entrega: {
        tipo: clip(o.entrega?.tipo || 'Delivery', 80), endereco: clip(o.entrega?.endereco, 160),
        bairro: clip(o.entrega?.bairro, 80), referencia: clip(o.entrega?.referencia, 160),
        taxa: round2(Math.max(0, Number(o.entrega?.taxa) || 0))
      },
      itens,
      pagamento: {
        forma: clip(o.pagamento?.forma || 'Pix', 40), troco: clip(o.pagamento?.troco, 20), pago: !!o.pagamento?.pago,
        metodo: clip(o.pagamento?.metodo, 30), link: clip(o.pagamento?.link, 300), transacao: clip(o.pagamento?.transacao, 80)
      },
      desconto: round2(Math.max(0, Number(o.desconto) || 0)),
      recompensa: clip(o.recompensa, 60),
      obs: clip(o.obs, 300),
      criadoEm: Number(o.criadoEm) || Date.now(),
      atualizadoEm: Date.now(),
      historico: (Array.isArray(o.historico) ? o.historico : []).slice(-30)
    };
    if (o.externoId) clean.externoId = clip(o.externoId, 80);
    if (o.nf) clean.nf = o.nf;
    if (o.entregador) clean.entregador = o.entregador;
    Object.assign(clean, totalsOf(clean));
    return clean;
  }

  // ---------- Lucro ----------
  const DEFAULT_TAXAS = { Pix: 0, Dinheiro: 0, 'Débito': 1.37, 'Crédito': 3.15, Online: 4.2, iFood: 23 };
  function payKey(order) {
    if (order.origem === 'ifood') return 'iFood';
    const f = order.pagamento?.metodo || order.pagamento?.forma || '';
    if (/online|link|credit_card/i.test(f)) return 'Online';
    if (/d[eé]bito/i.test(f)) return 'Débito';
    if (/cart|cr[eé]dito/i.test(f)) return 'Crédito';
    if (/dinheiro/i.test(f)) return 'Dinheiro';
    return 'Pix';
  }
  const feeOf = (order, taxas = DEFAULT_TAXAS) => round2((order.total || 0) * (Number(taxas[payKey(order)]) || 0) / 100);
  // custos: { produtoId: custo, 'opt:Nome da opção': custo }
  function costOf(order, custos = {}) {
    return round2((order.itens || []).reduce((s, l) => {
      const opts = (l.choices || []).reduce((t, c) => t + c.items.reduce((u, i) => u + (Number(custos['opt:' + i.name]) || 0) * i.qty, 0), 0);
      return s + ((Number(custos[l.id]) || 0) + opts) * l.qty;
    }, 0));
  }
  function inRange(ms, from, to) { return ms >= from && ms < to; }
  function profitReport(orders, { custos = {}, taxas = DEFAULT_TAXAS, despesas = [], from = 0, to = Infinity, custoEntrega = 0 } = {}) {
    const sales = orders.filter(o => countsAsSale(o) && inRange(o.criadoEm, from, to));
    const r = { pedidos: sales.length, faturamento: 0, custoProdutos: 0, taxas: 0, entregas: 0, despesas: 0, lucro: 0, ticketMedio: 0, porDia: {}, porProduto: {}, porPagamento: {}, porOrigem: {} };
    sales.forEach(o => {
      const total = Number(o.total) || 0;
      r.faturamento += total;
      r.custoProdutos += costOf(o, custos);
      r.taxas += feeOf(o, taxas);
      if (isDelivery(o)) r.entregas += Number(custoEntrega) || 0;
      const day = new Date(o.criadoEm).toISOString().slice(0, 10);
      r.porDia[day] = round2((r.porDia[day] || 0) + total);
      const pk = payKey(o);
      r.porPagamento[pk] = round2((r.porPagamento[pk] || 0) + total);
      r.porOrigem[o.origem || 'site'] = (r.porOrigem[o.origem || 'site'] || 0) + 1;
      (o.itens || []).forEach(l => {
        const p = r.porProduto[l.id] || (r.porProduto[l.id] = { nome: l.name, qtd: 0, valor: 0 });
        p.qtd += l.qty; p.valor = round2(p.valor + l.unit * l.qty);
      });
    });
    r.despesas = despesas.filter(d => inRange(Number(d.data) || 0, from, to)).reduce((s, d) => s + (Number(d.valor) || 0), 0);
    ['faturamento', 'custoProdutos', 'taxas', 'entregas', 'despesas'].forEach(k => { r[k] = round2(r[k]); });
    r.lucro = round2(r.faturamento - r.custoProdutos - r.taxas - r.entregas - r.despesas);
    r.ticketMedio = r.pedidos ? round2(r.faturamento / r.pedidos) : 0;
    r.margem = r.faturamento ? round2(r.lucro / r.faturamento * 100) : 0;
    return r;
  }

  // ---------- Horário (Recife, 17h às 23h) ----------
  const hourIn = (date = new Date()) => Number(new Intl.DateTimeFormat('pt-BR', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/Recife' }).format(date));
  const isOpen = (h = hourIn()) => h >= 17 && h < 23;

  // ---------- Mensagens de WhatsApp para o cliente ----------
  const MSG = {
    novo: 'Oi {nome}! Recebemos seu pedido {codigo} na Baldini Burguer 🍔 Total: {total}.',
    preparo: 'Oi {nome}! Seu pedido {codigo} já está na chapa 🔥',
    pronto: 'Oi {nome}! Seu pedido {codigo} está pronto ✅ {retirada}',
    entrega: 'Oi {nome}! Seu pedido {codigo} saiu para entrega 🛵 Já já chega aí!',
    concluido: 'Valeu, {nome}! Esperamos que tenha curtido 😋 Seus pontos do Clube Baldini já foram creditados.',
    cancelado: 'Oi {nome}, seu pedido {codigo} foi cancelado. Qualquer dúvida é só chamar aqui.',
    pagamento: 'Oi {nome}! Aqui está o link para pagar seu pedido {codigo} ({total}): {link}'
  };
  function fillMsg(tpl, order, extra = {}) {
    const vars = {
      nome: (order.cliente?.nome || '').split(' ')[0] || 'cliente', codigo: shortCode(order.id), total: brl(order.total),
      retirada: isDelivery(order) ? '' : 'Pode vir buscar 😉', link: order.pagamento?.link || '', ...extra
    };
    return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)).replace(/\s+$/, '');
  }
  function whatsLink(phone, text) {
    let d = String(phone || '').replace(/\D/g, '');
    if (d.length >= 10 && d.length <= 11) d = '55' + d;
    return `https://api.whatsapp.com/send?phone=${d}&text=${encodeURIComponent(text)}`;
  }

  // ---------- Bot de pedidos (site) ----------
  // A ordem importa: a primeira regra que bater responde. Os radicais pegam plural e conjugação ("horas", "abrem").
  const BOT_RULES = [
    { id: 'status', re: /\b(meu pedido|status|cade|demora|chegando|acompanh)/ },
    { id: 'horario', re: /\b(horario|hora|abre|aberto|fecha|que horas)/ },
    { id: 'endereco', re: /\b(endereco|onde fica|onde voces|onde e|localiza|loja|trailer|unidade)/ },
    { id: 'entrega', re: /\b(taxa|frete|entreg|delivery|bairro|motoboy)/ },
    { id: 'pagamento', re: /\b(pagament|pagar|pix|cartao|dinheiro|troco|maquininha|credito|debito)/ },
    { id: 'pontos', re: /\b(ponto|clube|fidelidade|recompensa|resgat)/ },
    { id: 'recomenda', re: /\b(recomend|suger|sugest|mais pedido|melhor|indica|famos|campe)/ },
    { id: 'combo', re: /\bcombo/ },
    { id: 'bebida', re: /\b(bebida|refri|suco|coca|guarana|beber)/ },
    { id: 'doce', re: /\b(sobremesa|doce|brownie|nutella)/ },
    { id: 'sacola', re: /\b(sacola|carrinho|finaliz|fechar pedido)/ },
    { id: 'humano', re: /\b(atendente|humano|pessoa|falar com|whatsapp|zap)/ },
    { id: 'saudacao', re: /\b(oi|ola|bom dia|boa tarde|boa noite|eai|e ai|opa)\b/ }
  ];
  function findProducts(menu, text, limit = 3) {
    const q = norm(text);
    if (!q) return [];
    const words = q.split(' ').filter(w => w.length > 2 && !['quero', 'queria', 'uma', 'com', 'sem', 'por', 'favor', 'pedir', 'tem'].includes(w));
    const scored = [];
    (menu || []).forEach(c => c.items.forEach(p => {
      const name = norm(p.name);
      let score = q.includes(name) ? 10 : 0;
      words.forEach(w => { if (name.split(' ').includes(w)) score += 3; else if (name.includes(w)) score += 1; });
      if (score >= 3) scored.push({ p, score });
    }));
    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.p);
  }
  function botReply(text, { menu = [], hour = hourIn(), lastOrder = null } = {}) {
    const q = norm(text);
    const found = findProducts(menu, text);
    if (found.length) {
      return { intent: 'produto', text: found.length === 1 ? `Boa escolha! ${found[0].name} 🍔 Toque para montar do seu jeito:` : 'Achei estes no cardápio:', actions: found.map(p => ({ type: 'product', id: p.id, label: p.name })) };
    }
    const rule = BOT_RULES.find(r => r.re.test(q));
    const open = isOpen(hour);
    switch (rule?.id) {
      case 'saudacao': return { intent: 'saudacao', text: `Olá! Eu sou o assistente da Baldini 🍔 ${open ? 'Estamos abertos agora!' : 'Abrimos às 17h, mas você já pode montar o pedido.'} O que vai ser hoje?`, actions: [{ type: 'cat', id: 'brasa', label: 'Na Brasa 🔥' }, { type: 'cat', id: 'chapa', label: 'Na Chapa 🍔' }, { type: 'cat', id: 'combos', label: 'Combos' }] };
      case 'horario': return { intent: 'horario', text: `Funcionamos todos os dias das 17h às 23h. ${open ? '🟢 Estamos abertos agora!' : '🔴 Agora estamos fechados, mas o pedido pode ser enviado e respondemos a partir das 17h.'}` };
      case 'endereco': return { intent: 'endereco', text: 'Temos duas unidades em Carpina: 📍 Loja na Av. Rosita Freire, 460 (Cajá) e 🚚 Trailer na Av. Murilo Silva.' };
      case 'entrega': return { intent: 'entrega', text: 'Entregamos em Carpina 🛵 A taxa depende do bairro e a loja confirma no WhatsApp junto com o pedido.' };
      case 'pagamento': return { intent: 'pagamento', text: 'Aceitamos Pix, cartão na maquininha e dinheiro (com troco). Também dá para pagar online por link (Pix ou cartão em até 12x).' };
      case 'pontos': return { intent: 'pontos', text: 'No Clube Baldini cada R$ 1 vira 1 ponto ⭐ Cliente novo ganha 5 pontos. Dá para trocar por batata ou entrega grátis na hora de finalizar.' };
      case 'status':
        if (lastOrder) return { intent: 'status', text: `Seu pedido ${shortCode(lastOrder.id)} está: ${statusInfo(lastOrder.status).icon} ${statusInfo(lastOrder.status).label}.` };
        return { intent: 'status', text: 'Não encontrei um pedido feito neste aparelho. Se pediu pelo WhatsApp, chama a gente por lá!', actions: [{ type: 'whats', label: 'Abrir WhatsApp' }] };
      case 'recomenda': return { intent: 'recomenda', text: 'Os campeões da casa: Granada (3 carnes e 3 queijos), Costela com Geleia de Pimenta e Cupim ao Creme Cheese na brasa 🔥', actions: [{ type: 'product', id: 'granada', label: 'Granada' }, { type: 'product', id: 'brasa-costela-com-geleia-de-pimenta', label: 'Costela' }, { type: 'product', id: 'brasa-cupim-ao-creme-cheese-brasa', label: 'Cupim' }] };
      case 'combo': return { intent: 'combo', text: 'Os combos vêm com burger + fritas + refri. Escolha o seu:', actions: [{ type: 'product', id: 'combos-na-brasa', label: 'Combo na Brasa' }, { type: 'product', id: 'combos-na-chapa', label: 'Combo na Chapa' }] };
      case 'bebida': return { intent: 'bebida', text: 'Temos refri lata e 1 litro, H2O e sucos naturais de cajá e graviola 🥤', actions: [{ type: 'cat', id: 'bebidas', label: 'Ver bebidas' }] };
      case 'doce': return { intent: 'doce', text: 'Pra fechar: brownies tradicional, Nutella ou doce de leite 🍫', actions: [{ type: 'cat', id: 'sobremesas', label: 'Ver sobremesas' }] };
      case 'sacola': return { intent: 'sacola', text: 'Bora finalizar! Abrindo sua sacola 🛍️', actions: [{ type: 'cart', label: 'Ver sacola' }] };
      case 'humano': return { intent: 'humano', text: 'Claro! Fale com a nossa equipe pelo WhatsApp:', actions: [{ type: 'whats', label: 'Falar com atendente' }] };
      default: return { intent: 'nao-entendi', text: 'Não entendi muito bem 😅 Você pode digitar o nome de um lanche (ex.: "granada") ou escolher abaixo:', actions: [{ type: 'cat', id: 'brasa', label: 'Na Brasa' }, { type: 'cat', id: 'combos', label: 'Combos' }, { type: 'whats', label: 'Atendente' }] };
    }
  }

  // ---------- InfinitePay (link de pagamento) ----------
  function infinitepayPayload(order, { handle, redirectUrl, webhookUrl } = {}) {
    const items = (order.itens || []).map(l => ({ quantity: l.qty, price: Math.round(l.unit * 100), description: clip(l.name, 100) }));
    const t = totalsOf(order);
    if (t.taxa > 0) items.push({ quantity: 1, price: Math.round(t.taxa * 100), description: 'Taxa de entrega' });
    const payload = { handle: String(handle || '').replace(/^\$/, ''), order_nsu: order.id, items };
    if (redirectUrl) payload.redirect_url = redirectUrl;
    if (webhookUrl) payload.webhook_url = webhookUrl;
    const phone = String(order.cliente?.telefone || '').replace(/\D/g, '');
    if (order.cliente?.nome || phone) payload.customer = { name: order.cliente?.nome || undefined, phone_number: phone ? '+' + (phone.length <= 11 ? '55' + phone : phone) : undefined };
    return payload;
  }

  // ---------- Nota fiscal (NFC-e, formato Focus NFe) ----------
  const FORMA_NF = { Dinheiro: '01', 'Crédito': '03', 'Débito': '04', Pix: '17', Online: '17', iFood: '99' };
  const NF_STATUS_OK = ['autorizado', 'simulada'];
  // Código da forma de pagamento na NFC-e (online por cartão é crédito, online por Pix é Pix)
  function formaNf(order) {
    const k = payKey(order);
    if (k === 'Online') return /pix/i.test(order.pagamento?.metodo || '') ? '17' : '03';
    return FORMA_NF[k] || '99';
  }
  // CPF com dígitos verificadores corretos (o cliente digita no site, se quiser)
  function validCpf(v) {
    const d = String(v || '').replace(/\D/g, '');
    if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
    const dv = n => { let s = 0; for (let i = 0; i < n; i++) s += +d[i] * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
    return dv(9) === +d[9] && dv(10) === +d[10];
  }
  // "Rua A, 123" → { rua: 'Rua A', numero: '123' }
  function splitAddress(s) {
    const m = String(s || '').trim().match(/^(.*?)[,\s]+(n[ºo°.]?\s*)?(\d+[a-z]?|s\/?n)\b(.*)$/i);
    return m ? { rua: m[1].trim(), numero: m[3].toUpperCase(), complemento: m[4].replace(/^[\s,-]+/, '').trim() } : { rua: String(s || '').trim(), numero: 'S/N', complemento: '' };
  }
  const itemDesc = l => {
    const extras = (l.choices || []).flatMap(c => c.items.map(i => (i.qty > 1 ? i.qty + 'x ' : '') + i.name));
    return clip(extras.length ? `${l.name} (${extras.join(', ')})` : l.name, 120);
  };
  function nfcePayload(order, { cnpj, ncm = '21069090', cfop = '5102', csosn = '102', municipio = 'Carpina', uf = 'PE' } = {}) {
    const items = (order.itens || []).map((l, i) => ({
      numero_item: i + 1, codigo_produto: clip(l.id, 60), descricao: itemDesc(l), cfop, codigo_ncm: ncm,
      unidade_comercial: 'UN', quantidade_comercial: l.qty, valor_unitario_comercial: round2(l.unit), valor_bruto: round2(l.unit * l.qty),
      unidade_tributavel: 'UN', quantidade_tributavel: l.qty, valor_unitario_tributavel: round2(l.unit),
      icms_origem: 0, icms_situacao_tributaria: csosn
    }));
    const t = totalsOf(order);
    const forma = formaNf(order);
    const pagamento = { forma_pagamento: forma, valor_pagamento: t.total };
    if (['03', '04'].includes(forma)) pagamento.tipo_integracao = 2; // maquininha não integrada ao emissor
    if (forma === '01' && order.pagamento?.troco) {
      const troco = round2(Number(String(order.pagamento.troco).replace(',', '.')) - t.total);
      if (troco > 0) pagamento.valor_troco = troco;
    }
    const nf = {
      cnpj_emitente: String(cnpj || '').replace(/\D/g, ''), data_emissao: new Date().toISOString(),
      natureza_operacao: 'Venda ao consumidor', presenca_comprador: isDelivery(order) ? 4 : 1, modalidade_frete: 9, local_destino: 1,
      ...(t.taxa > 0 ? { valor_frete: t.taxa } : {}), ...(t.desconto > 0 ? { valor_desconto: t.desconto } : {}),
      items,
      formas_pagamento: [pagamento]
    };
    // Cliente na nota: só com CPF válido (é a regra da NFC-e)
    const cpf = String(order.cliente?.cpf || '').replace(/\D/g, '');
    if (validCpf(cpf)) {
      nf.cpf_destinatario = cpf;
      if (order.cliente?.nome) nf.nome_destinatario = clip(order.cliente.nome, 60);
      if (isDelivery(order) && order.entrega?.endereco) {
        const a = splitAddress(order.entrega.endereco);
        Object.assign(nf, {
          logradouro_destinatario: clip(a.rua, 60), numero_destinatario: clip(a.numero, 10),
          bairro_destinatario: clip(order.entrega.bairro, 60), municipio_destinatario: municipio, uf_destinatario: uf,
          ...(a.complemento ? { complemento_destinatario: clip(a.complemento, 60) } : {})
        });
      }
    }
    // Endereço da entrega sempre vai nas informações adicionais (aparece impresso na nota)
    const info = [`Pedido ${shortCode(order.id)}`, order.origem ? `via ${order.origem}` : ''];
    if (isDelivery(order)) info.push(`Entrega: ${[order.entrega?.endereco, order.entrega?.bairro, municipio + '-' + uf].filter(Boolean).join(', ')}`);
    else if (order.entrega?.tipo) info.push(order.entrega.tipo);
    nf.informacoes_adicionais_contribuinte = clip(info.filter(Boolean).join(' | '), 500);
    return nf;
  }
  // Quando a nota deve sair sozinha: 'pedido' (assim que o pedido chega), 'pago' ou 'concluido'
  function shouldAutoEmit(order, { nfAuto, nfQuando = 'pedido' } = {}) {
    if (!nfAuto || order.nf?.status || !(order.itens || []).length) return false;
    if (['montando', 'cancelado'].includes(order.status)) return false;
    if (nfQuando === 'pago') return !!order.pagamento?.pago;
    if (nfQuando === 'concluido') return order.status === 'concluido';
    return true;
  }

  return { brl, round2, norm, STATUS, STATUS_IDS, statusInfo, nextStatus, isDelivery, countsAsSale, newOrderId, shortCode, unitPrice, missingGroup, subtotalOf, totalsOf, sanitizeOrder, DEFAULT_TAXAS, payKey, feeOf, costOf, profitReport, hourIn, isOpen, MSG, fillMsg, whatsLink, findProducts, botReply, infinitepayPayload, nfcePayload, validCpf, splitAddress, shouldAutoEmit, formaNf, NF_STATUS_OK };
});
