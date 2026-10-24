// ===== Testes da Baldini =====
// Rodam no navegador (tests/index.html) e no GitHub Actions (node tests/run-node.js).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.BaldiniSpec = factory;
})(typeof self !== 'undefined' ? self : this, function (test, Core, MENU) {
  const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || 'esperado'}: ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`); };
  const ok = (v, msg) => { if (!v) throw new Error(msg || 'esperado verdadeiro'); };
  const products = new Map();
  MENU.forEach(c => c.items.forEach(p => products.set(p.id, p)));
  const order = (extra = {}) => Core.sanitizeOrder({ id: 'TESTE123', status: 'novo', itens: [{ id: 'granada', name: 'Granada', unit: 30.99, qty: 2, choices: [] }], criadoEm: Date.UTC(2026, 9, 20, 21), ...extra });

  // ---------- Cardápio ----------
  test('cardápio tem categorias e produtos', () => { ok(MENU.length >= 5); ok(products.size >= 30); });
  test('ids de produto são únicos', () => {
    const ids = MENU.flatMap(c => c.items.map(p => p.id));
    eq(new Set(ids).size, ids.length, 'ids repetidos');
  });
  test('preços e grupos do cardápio são válidos', () => {
    MENU.forEach(c => c.items.forEach(p => {
      ok(typeof p.price === 'number' && p.price >= 0, `preço inválido em ${p.id}`);
      (p.groups || []).forEach(g => {
        ok(g.min <= g.max, `min > max em ${p.id} / ${g.name}`);
        ok(['single', 'multi', 'qty'].includes(g.type), `tipo de grupo inválido em ${p.id}`);
        ok(g.options.length > 0, `grupo sem opções em ${p.id}`);
        g.options.forEach(o => ok(typeof o.price === 'number' && o.price >= 0, `opção com preço inválido em ${p.id}`));
      });
      ok(Core.unitPrice(p, (p.groups || []).map(() => ({}))) >= 0);
    }));
  });

  // ---------- Preços ----------
  test('preço do combo soma burger, batata e refri', () => {
    const p = products.get('combos-na-brasa');
    eq(Core.unitPrice(p, [{ 2: 1 }, {}, { 1: 1 }, { 0: 1 }]), 61.99);
  });
  test('adicionais por quantidade multiplicam o preço', () => {
    const p = products.get('brasa-bomba-burguer-brasa');
    eq(Core.unitPrice(p, [{ 2: 2 }, {}]), 33.99); // 23,99 + 2x bacon 5,00
  });
  test('grupo obrigatório sem escolha é detectado', () => {
    const p = products.get('combos-na-brasa');
    eq(Core.missingGroup(p, [{}, {}, {}, {}]), 0);
    eq(Core.missingGroup(p, [{ 0: 1 }, {}, { 0: 1 }, {}]), 3);
    eq(Core.missingGroup(p, [{ 0: 1 }, {}, { 0: 1 }, { 0: 1 }]), -1);
  });
  test('total com taxa de entrega e desconto', () => {
    const o = order({ entrega: { tipo: 'Delivery', taxa: 5 }, desconto: 2 });
    eq([o.subtotal, o.taxa, o.desconto, o.total], [61.98, 5, 2, 64.98]);
  });
  test('retirada não cobra taxa de entrega', () => {
    eq(order({ entrega: { tipo: 'Retirada na Loja', taxa: 5 } }).total, 61.98);
  });
  test('desconto maior que o pedido não deixa total negativo', () => {
    eq(order({ desconto: 999 }).total, 0);
  });

  // ---------- Pedidos ----------
  test('fluxo de status do delivery passa pela entrega', () => {
    const o = order({ entrega: { tipo: 'Delivery' } });
    const seq = [];
    let s = o.status;
    while (s) { seq.push(s); s = Core.nextStatus({ ...o, status: s }); }
    eq(seq, ['novo', 'preparo', 'pronto', 'entrega', 'concluido']);
  });
  test('fluxo de status da retirada pula a entrega', () => {
    eq(Core.nextStatus(order({ status: 'pronto', entrega: { tipo: 'Retirada no Trailer' } })), 'concluido');
  });
  test('pedido cancelado ou concluído não avança', () => {
    eq(Core.nextStatus(order({ status: 'cancelado' })), null);
    eq(Core.nextStatus(order({ status: 'concluido' })), null);
  });
  test('ids de pedido não se repetem', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => Core.newOrderId()));
    eq(ids.size, 2000);
  });

  // ---------- Avanço automático ----------
  const auto = { ativo: true, novo: 1, preparo: 15, pronto: 3, entrega: 25 };
  test('automação desligada não mexe em nada', () => {
    eq(Core.autoStep(order({ status: 'preparo' }), { ...auto, ativo: false }), null);
  });
  test('pedido avança depois do tempo de cada etapa', () => {
    const t = 1_000_000;
    const o = order({ status: 'preparo', entrega: { tipo: 'Delivery' }, historico: [{ status: 'novo', em: t - 60000 }, { status: 'preparo', em: t }] });
    eq(Core.autoStep(o, auto), { para: 'pronto', em: t + 15 * 60000 });
    eq(Core.autoStep({ ...o, status: 'pronto', historico: [...o.historico, { status: 'pronto', em: t + 5 }] }, auto), { para: 'entrega', em: t + 5 + 3 * 60000 });
  });
  test('retirada vai de pronto direto para concluído', () => {
    const o = order({ status: 'pronto', entrega: { tipo: 'Retirada na Loja' }, historico: [{ status: 'pronto', em: 500 }] });
    eq(Core.autoStep(o, auto).para, 'concluido');
  });
  test('o tempo conta a partir da última vez que entrou na etapa', () => {
    const o = order({ status: 'preparo', historico: [{ status: 'preparo', em: 100 }, { status: 'novo', em: 200 }, { status: 'preparo', em: 300 }] });
    eq(Core.enteredAt(o), 300);
  });
  test('concluído, cancelado, montando e iFood não avançam sozinhos', () => {
    ['concluido', 'cancelado', 'montando'].forEach(s => eq(Core.autoStep(order({ status: s }), auto), null));
    eq(Core.autoStep(order({ status: 'novo', origem: 'ifood' }), auto), null);
  });

  // ---------- Dados ruins não derrubam ----------
  test('pedido vazio ou estranho vira um pedido válido', () => {
    const o = Core.sanitizeOrder({});
    eq([o.status, o.origem, o.total, o.itens.length], ['novo', 'site', 0, 0]);
    const w = Core.sanitizeOrder({ status: 'hackeado', origem: 'x', itens: 'nada', cliente: null, pagamento: 5 });
    eq([w.status, w.origem, w.itens.length], ['novo', 'site', 0]);
  });
  test('quantidade e preço absurdos são corrigidos', () => {
    const o = Core.sanitizeOrder({ itens: [{ id: 'a', name: 'A', unit: -10, qty: 5000 }, { id: 'b', name: 'B', unit: 'abc', qty: -3 }] });
    eq(o.itens.map(l => [l.unit, l.qty]), [[0, 99], [0, 1]]);
  });
  test('textos gigantes são cortados', () => {
    const o = Core.sanitizeOrder({ cliente: { nome: 'x'.repeat(5000) }, obs: 'y'.repeat(5000), itens: Array.from({ length: 500 }, () => ({ id: 'a', name: 'A', unit: 1, qty: 1 })) });
    eq([o.cliente.nome.length, o.obs.length, o.itens.length], [80, 300, 60]);
  });
  test('relatório de lucro aguenta pedidos incompletos', () => {
    const r = Core.profitReport([{}, { status: 'novo', criadoEm: Date.now() }, { status: 'novo', criadoEm: Date.now(), total: 10, itens: [{ id: 'x', qty: 1, unit: 10 }] }]);
    eq([r.pedidos, r.faturamento], [2, 10]);
  });
  test('bot nunca quebra com mensagens estranhas', () => {
    [null, undefined, '', '🍔🍔🍔', 'a'.repeat(10000), '<script>alert(1)</script>', 123].forEach(t => {
      const r = Core.botReply(t, { menu: MENU });
      ok(r && typeof r.text === 'string' && r.text.length > 0, 'resposta vazia para ' + String(t).slice(0, 20));
    });
  });

  // ---------- Lucro ----------
  test('lucro desconta custo, taxa da maquininha e despesas', () => {
    const day = Date.UTC(2026, 9, 20, 21);
    const orders = [
      order({ criadoEm: day, itens: [{ id: 'granada', name: 'Granada', unit: 35.99, qty: 1 }], pagamento: { forma: 'Pix', metodo: 'Débito' } }),
      order({ id: 'B', criadoEm: day, itens: [{ id: 'combos-na-brasa', name: 'Combo', unit: 61.99, qty: 1 }], pagamento: { forma: 'Crédito' } }),
      order({ id: 'C', criadoEm: day, status: 'cancelado' }),
      order({ id: 'D', criadoEm: day, status: 'montando' })
    ];
    const r = Core.profitReport(orders, { custos: { granada: 12.5, 'combos-na-brasa': 25 }, despesas: [{ valor: 10, data: day }], from: day - 1, to: day + 1 });
    eq([r.pedidos, r.faturamento, r.custoProdutos, r.taxas, r.despesas, r.lucro], [2, 97.98, 37.5, 2.44, 10, 48.04]);
  });
  test('custo de adicionais entra no lucro', () => {
    const o = order({ itens: [{ id: 'granada', name: 'Granada', unit: 35.99, qty: 2, choices: [{ group: 'Adicionais', items: [{ name: 'Bacon', qty: 1, price: 5 }] }] }] });
    eq(Core.costOf(o, { granada: 10, 'opt:Bacon': 2 }), 24);
  });
  test('período filtra pedidos fora da data', () => {
    const r = Core.profitReport([order({ criadoEm: 1000 }), order({ criadoEm: 5000 })], { from: 2000, to: 9000 });
    eq(r.pedidos, 1);
  });
  test('forma de pagamento escolhe a taxa certa', () => {
    eq(Core.payKey({ pagamento: { forma: 'Cartão (maquininha)' } }), 'Crédito');
    eq(Core.payKey({ pagamento: { forma: 'Pix', metodo: 'Débito' } }), 'Débito');
    eq(Core.payKey({ pagamento: { forma: 'Online' } }), 'Online');
    eq(Core.payKey({ origem: 'ifood', pagamento: { forma: 'Pix' } }), 'iFood');
    eq(Core.payKey({ pagamento: { forma: 'Dinheiro' } }), 'Dinheiro');
  });

  // ---------- Bot ----------
  const intent = (t, ctx = {}) => Core.botReply(t, { menu: MENU, hour: 20, ...ctx }).intent;
  test('bot entende horário', () => { eq(intent('que horas vocês abrem?'), 'horario'); eq(intent('Tá aberto?'), 'horario'); });
  test('bot acha lanche pelo nome', () => {
    const r = Core.botReply('quero uma granada', { menu: MENU });
    eq([r.intent, r.actions[0].id], ['produto', 'granada']);
    eq(Core.botReply('tem cupim?', { menu: MENU }).actions[0].id, 'brasa-cupim-ao-creme-cheese-brasa');
  });
  test('bot responde pagamento, entrega, pontos e endereço', () => {
    eq(intent('aceita pix?'), 'pagamento');
    eq(intent('qual a taxa pro meu bairro'), 'entrega');
    eq(intent('como funcionam os pontos'), 'pontos');
    eq(intent('onde fica a loja'), 'endereco');
  });
  test('bot informa o status do último pedido', () => {
    const r = Core.botReply('cadê meu pedido?', { menu: MENU, lastOrder: { id: 'ABCD1234', status: 'entrega' } });
    eq(r.intent, 'status');
    ok(r.text.includes('#ABCD') && r.text.includes('Saiu p/ entrega'));
  });
  test('bot sabe quando está fechado', () => {
    ok(Core.botReply('horário', { hour: 10 }).text.includes('fechados'));
    ok(Core.botReply('horário', { hour: 20 }).text.includes('abertos'));
  });
  test('bot oferece atendente quando não entende', () => {
    const r = Core.botReply('xpto qwerty', { menu: MENU });
    eq(r.intent, 'nao-entendi');
    ok(r.actions.some(a => a.type === 'whats'));
  });

  // ---------- WhatsApp ----------
  test('link do WhatsApp coloca o 55 do Brasil', () => {
    ok(Core.whatsLink('(81) 99999-8888', 'oi').startsWith('https://api.whatsapp.com/send?phone=5581999998888&text=oi'));
    ok(Core.whatsLink('5581999998888', 'oi').includes('phone=5581999998888&'));
  });
  test('mensagem usa o primeiro nome, código e total', () => {
    const o = order({ cliente: { nome: 'Maria Souza' } });
    eq(Core.fillMsg(Core.MSG.novo, o), 'Oi Maria! Recebemos seu pedido #TEST na Baldini Burguer 🍔 Total: ' + Core.brl(61.98) + '.');
  });

  // ---------- InfinitePay ----------
  test('link InfinitePay manda valores em centavos e a taxa de entrega', () => {
    const p = Core.infinitepayPayload(order({ entrega: { tipo: 'Delivery', taxa: 4.5 }, cliente: { nome: 'Ana', telefone: '81 99999-8888' } }), { handle: '$baldini', redirectUrl: 'https://x/y' });
    eq(p.handle, 'baldini');
    eq(p.order_nsu, 'TESTE123');
    eq(p.items, [{ quantity: 2, price: 3099, description: 'Granada' }, { quantity: 1, price: 450, description: 'Taxa de entrega' }]);
    eq(p.customer.phone_number, '+5581999998888');
    eq(p.redirect_url, 'https://x/y');
  });

  // ---------- Nota fiscal ----------
  test('NFC-e tem itens, CNPJ limpo e forma de pagamento', () => {
    const n = Core.nfcePayload(order({ pagamento: { forma: 'Pix' } }), { cnpj: '46.723.226/0001-11' });
    eq(n.cnpj_emitente, '46723226000111');
    eq(n.items.length, 1);
    eq([n.items[0].quantidade_comercial, n.items[0].valor_bruto], [2, 61.98]);
    eq(n.formas_pagamento, [{ forma_pagamento: '17', valor_pagamento: 61.98 }]);
  });
  test('NFC-e de delivery leva o frete', () => {
    const n = Core.nfcePayload(order({ entrega: { tipo: 'Delivery', taxa: 5 }, pagamento: { forma: 'Dinheiro' } }), { cnpj: '1' });
    eq([n.valor_frete, n.presenca_comprador, n.formas_pagamento[0]], [5, 4, { forma_pagamento: '01', valor_pagamento: 66.98 }]);
  });
  test('CPF: aceita válido e recusa inválido', () => {
    ok(Core.validCpf('529.982.247-25'));
    ok(!Core.validCpf('529.982.247-24'));
    ok(!Core.validCpf('111.111.111-11'));
    ok(!Core.validCpf('123'));
  });
  test('NFC-e com CPF leva nome e endereço do cliente', () => {
    const n = Core.nfcePayload(order({ cliente: { nome: 'Ana', cpf: '529.982.247-25' }, entrega: { tipo: 'Delivery', endereco: 'Rua das Flores, 123 ap 2', bairro: 'Centro', taxa: 0 } }), { cnpj: '1' });
    eq([n.cpf_destinatario, n.nome_destinatario, n.logradouro_destinatario, n.numero_destinatario, n.complemento_destinatario, n.bairro_destinatario, n.municipio_destinatario, n.uf_destinatario],
      ['52998224725', 'Ana', 'Rua das Flores', '123', 'ap 2', 'Centro', 'Carpina', 'PE']);
  });
  test('NFC-e sem CPF não identifica o cliente, mas leva o endereço nas informações', () => {
    const n = Core.nfcePayload(order({ cliente: { nome: 'Ana', cpf: '123' }, entrega: { tipo: 'Delivery', endereco: 'Rua A, 10', bairro: 'Cajá' } }), { cnpj: '1' });
    ok(!('cpf_destinatario' in n) && !('logradouro_destinatario' in n));
    ok(n.informacoes_adicionais_contribuinte.includes('Rua A, 10, Cajá, Carpina-PE'));
    ok(n.informacoes_adicionais_contribuinte.includes('#TEST'));
  });
  test('NFC-e descreve os adicionais e trata cartão e troco', () => {
    const o = order({ itens: [{ id: 'granada', name: 'Granada', unit: 35.99, qty: 1, choices: [{ group: 'Adicionais', items: [{ name: 'Bacon', qty: 2, price: 5 }] }] }] });
    eq(Core.nfcePayload(o, { cnpj: '1' }).items[0].descricao, 'Granada (2x Bacon)');
    eq(Core.nfcePayload({ ...o, pagamento: { forma: 'Pix', metodo: 'Crédito' } }, { cnpj: '1' }).formas_pagamento[0], { forma_pagamento: '03', valor_pagamento: 35.99, tipo_integracao: 2 });
    eq(Core.nfcePayload({ ...o, pagamento: { forma: 'Dinheiro', troco: '50' } }, { cnpj: '1' }).formas_pagamento[0], { forma_pagamento: '01', valor_pagamento: 35.99, valor_troco: 14.01 });
    eq(Core.formaNf({ pagamento: { forma: 'Online', metodo: 'Pix (online)' } }), '17');
    eq(Core.formaNf({ pagamento: { forma: 'Online', metodo: 'Online' } }), '03');
  });
  test('endereço sem número vira S/N', () => {
    eq(Core.splitAddress('Rua Sem Número'), { rua: 'Rua Sem Número', numero: 'S/N', complemento: '' });
    eq(Core.splitAddress('Av. Rosita Freire, nº 460'), { rua: 'Av. Rosita Freire', numero: '460', complemento: '' });
  });
  test('nota automática: quando emitir', () => {
    const base = order();
    ok(Core.shouldAutoEmit(base, { nfAuto: true, nfQuando: 'pedido' }));
    ok(!Core.shouldAutoEmit(base, { nfAuto: false }));
    ok(!Core.shouldAutoEmit({ ...base, status: 'montando' }, { nfAuto: true }));
    ok(!Core.shouldAutoEmit({ ...base, status: 'cancelado' }, { nfAuto: true }));
    ok(!Core.shouldAutoEmit({ ...base, nf: { status: 'simulada' } }, { nfAuto: true }));
    ok(!Core.shouldAutoEmit(base, { nfAuto: true, nfQuando: 'pago' }));
    ok(Core.shouldAutoEmit({ ...base, pagamento: { pago: true } }, { nfAuto: true, nfQuando: 'pago' }));
    ok(!Core.shouldAutoEmit(base, { nfAuto: true, nfQuando: 'concluido' }));
    ok(Core.shouldAutoEmit({ ...base, status: 'concluido' }, { nfAuto: true, nfQuando: 'concluido' }));
  });
  test('pedido guarda só os números do CPF', () => {
    eq(Core.sanitizeOrder({ cliente: { cpf: '529.982.247-25' } }).cliente.cpf, '52998224725');
  });
});
