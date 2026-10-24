// ===== Funções no servidor da Baldini (Firebase Cloud Functions) =====
// Aqui ficam as partes que usam senhas/tokens e por isso NÃO podem ficar no site:
//   emitirNfce         → emite NFC-e pela Focus NFe
//   infinitepayWebhook → a InfinitePay avisa quando um pagamento online é aprovado
//   ifoodSync          → traz pedidos do iFood e a posição dos entregadores, a cada minuto
// Os tokens ficam em "secrets": firebase functions:secrets:set FOCUS_TOKEN (etc.)
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret, defineString } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
setGlobalOptions({ region: 'southamerica-east1', maxInstances: 5 });

const FOCUS_TOKEN = defineSecret('FOCUS_TOKEN');
const FOCUS_AMBIENTE = defineString('FOCUS_AMBIENTE', { default: 'homologacao' }); // troque para "producao" quando estiver tudo certo
const IFOOD_CLIENT_ID = defineSecret('IFOOD_CLIENT_ID');
const IFOOD_CLIENT_SECRET = defineSecret('IFOOD_CLIENT_SECRET');

async function requireStaff(auth) {
  if (!auth) throw new HttpsError('unauthenticated', 'Faça login.');
  const doc = await db.collection('equipe').doc(auth.uid).get();
  if (!doc.exists) throw new HttpsError('permission-denied', 'Usuário não é da equipe.');
}

// ---------- Nota fiscal (NFC-e) ----------
exports.emitirNfce = onCall({ secrets: [FOCUS_TOKEN] }, async req => {
  await requireStaff(req.auth);
  const { pedidoId, payload } = req.data || {};
  if (!pedidoId || !payload?.items?.length) throw new HttpsError('invalid-argument', 'Pedido sem itens.');
  const base = FOCUS_AMBIENTE.value() === 'producao' ? 'https://api.focusnfe.com.br' : 'https://homologacao.focusnfe.com.br';
  const res = await fetch(`${base}/v2/nfce?ref=${encodeURIComponent(pedidoId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(FOCUS_TOKEN.value() + ':').toString('base64') },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && data.status !== 'autorizado') throw new HttpsError('failed-precondition', data.mensagem || data.mensagem_sefaz || `Focus NFe respondeu ${res.status}`);
  const nf = { status: data.status || 'processando', chave: data.chave_nfe || '', url: data.caminho_danfe ? base + data.caminho_danfe : '' };
  await db.collection('pedidos').doc(pedidoId).update({ nf });
  return nf;
});

// ---------- InfinitePay: pagamento aprovado ----------
exports.infinitepayWebhook = onRequest(async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.order_nsu) return res.status(400).send('sem order_nsu');
    const ref = db.collection('pedidos').doc(String(b.order_nsu));
    const [pedido, loja] = await Promise.all([ref.get(), db.collection('config').doc('loja').get()]);
    if (!pedido.exists) return res.status(200).send('pedido desconhecido');
    // Não confia só no aviso: confere direto na InfinitePay
    const check = await fetch('https://api.checkout.infinitepay.io/payment_check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: loja.data()?.infinitepayHandle, order_nsu: b.order_nsu, transaction_nsu: b.transaction_nsu, slug: b.invoice_slug })
    }).then(r => r.json());
    if (!check.paid) return res.status(400).send('não pago ainda');
    await ref.update({
      'pagamento.pago': true,
      'pagamento.metodo': b.capture_method === 'pix' ? 'Pix (online)' : 'Online',
      'pagamento.transacao': String(b.transaction_nsu || ''),
      atualizadoEm: Date.now()
    });
    res.status(200).send('ok');
  } catch (e) {
    console.error(e);
    res.status(400).send('erro'); // a InfinitePay tenta de novo
  }
});

// ---------- iFood: pedidos e posição do entregador ----------
// Confira os caminhos no portal https://developer.ifood.com.br antes de ligar.
const IFOOD = 'https://merchant-api.ifood.com.br';
const IFOOD_STATUS = { PLC: 'novo', CFM: 'preparo', RTP: 'pronto', DSP: 'entrega', CON: 'concluido', CAN: 'cancelado' };

async function ifoodToken() {
  const res = await fetch(`${IFOOD}/authentication/v1.0/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grantType: 'client_credentials', clientId: IFOOD_CLIENT_ID.value(), clientSecret: IFOOD_CLIENT_SECRET.value() })
  });
  if (!res.ok) throw new Error('iFood login ' + res.status);
  return (await res.json()).accessToken;
}
function fromIfood(o) {
  const addr = o.delivery?.deliveryAddress || {};
  const method = o.payments?.methods?.[0];
  return {
    id: 'IF' + String(o.displayId || o.id).replace(/\W/g, '').slice(0, 18), externoId: o.id, origem: 'ifood', status: 'novo',
    cliente: { nome: o.customer?.name || '', telefone: o.customer?.phone?.number || '' },
    entrega: { tipo: o.orderType === 'DELIVERY' ? 'Delivery' : 'Retirada na Loja (Av. Rosita Freire, 460)', endereco: addr.formattedAddress || '', bairro: addr.neighborhood || '', referencia: addr.reference || '', taxa: o.total?.deliveryFee || 0 },
    itens: (o.items || []).map(i => ({
      id: 'ifood-' + (i.externalCode || i.id || i.name), name: i.name, unit: i.unitPrice || 0, qty: i.quantity || 1, note: i.observations || '',
      choices: i.options?.length ? [{ group: 'Opções', items: i.options.map(op => ({ name: op.name, qty: op.quantity || 1, price: op.price || 0 })) }] : []
    })),
    pagamento: { forma: method?.method || 'iFood', pago: method?.type === 'ONLINE', metodo: method?.type === 'ONLINE' ? 'iFood online' : '' },
    desconto: (o.total?.benefits || 0), subtotal: o.total?.subTotal || 0, total: o.total?.orderAmount || 0,
    criadoEm: Date.parse(o.createdAt) || Date.now(), atualizadoEm: Date.now(), historico: [{ status: 'novo', em: Date.now() }]
  };
}

exports.ifoodSync = onSchedule({ schedule: 'every 1 minutes', secrets: [IFOOD_CLIENT_ID, IFOOD_CLIENT_SECRET] }, async () => {
  const loja = (await db.collection('config').doc('loja').get()).data() || {};
  if (!loja.ifoodAtivo) return;
  const token = await ifoodToken();
  const h = { Authorization: 'Bearer ' + token };

  // 1) Eventos novos (pedido criado, confirmado, despachado...)
  const evRes = await fetch(`${IFOOD}/order/v1.0/events:polling`, { headers: h });
  const events = evRes.status === 200 ? await evRes.json() : [];
  for (const ev of events) {
    const q = await db.collection('pedidos').where('externoId', '==', ev.orderId).limit(1).get();
    if (ev.code === 'PLC' && q.empty) {
      const o = await fetch(`${IFOOD}/order/v1.0/orders/${ev.orderId}`, { headers: h }).then(r => r.json());
      const pedido = fromIfood(o);
      await db.collection('pedidos').doc(pedido.id).set(pedido);
    } else if (!q.empty && IFOOD_STATUS[ev.code]) {
      await q.docs[0].ref.update({ status: IFOOD_STATUS[ev.code], atualizadoEm: Date.now() });
    }
  }
  if (events.length) {
    await fetch(`${IFOOD}/order/v1.0/events/acknowledgment`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(events.map(e => ({ id: e.id }))) });
  }

  // 2) Posição dos entregadores dos pedidos em rota
  const emRota = await db.collection('pedidos').where('origem', '==', 'ifood').where('status', '==', 'entrega').limit(30).get();
  for (const d of emRota.docs) {
    const t = await fetch(`${IFOOD}/order/v1.0/orders/${d.data().externoId}/tracking`, { headers: h });
    if (!t.ok) continue;
    const pos = await t.json();
    if (pos.latitude && pos.longitude) {
      await d.ref.update({ entregador: { lat: pos.latitude, lng: pos.longitude, em: Date.now(), previsao: pos.expectedDelivery || null } });
    }
  }
});
