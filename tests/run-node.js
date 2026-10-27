// Roda os testes no Node (usado pelo GitHub Actions): node tests/run-node.js
// O cardápio vem do site de pedidos, então este teste também confere que os dois estão ligados.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const SITE = 'https://galdinoheitor15-star.github.io/baldini-burguer/';

const Core = require(path.join(root, 'baldini-core.js'));
const spec = require(path.join(__dirname, 'spec.js'));

(async () => {
  const res = await fetch(SITE + 'menu-data.js', { cache: 'no-store' });
  if (!res.ok) { console.log('✘ cardápio do site não carregou:', res.status); process.exit(1); }
  const sandbox = { window: {} };
  vm.runInNewContext(await res.text(), sandbox);
  const MENU = sandbox.window.MENU;

  const results = [];
  spec((name, fn) => results.push({ name, fn }), Core, MENU);
  results.push({
    name: 'todas as fotos do cardápio existem no site',
    fn: async () => {
      const imgs = [...new Set(MENU.flatMap(c => c.items.map(p => p.img)).filter(Boolean))];
      const missing = [];
      await Promise.all(imgs.map(src => fetch(SITE + src, { method: 'HEAD' }).then(r => { if (!r.ok) missing.push(src); }).catch(() => missing.push(src))));
      if (missing.length) throw new Error('faltando: ' + missing.join(', '));
    }
  });
  results.push({
    name: 'ajustes do cardápio (preço, produto novo, escondido) valem do mesmo jeito no site e na gestão',
    fn: async () => {
      const src = await fetch(SITE + 'menu-ajustes.js', { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error('menu-ajustes.js não existe no site'); return r.text(); });
      const sb = { window: {} }; sb.self = sb.window;
      vm.runInNewContext(src, sb);
      const C = sb.window.BaldiniCardapio;
      const cat = MENU.find(c => c.items.some(p => p.price > 0));
      const p = cat.items.find(x => x.price > 0);
      const m = C.aplicar(MENU, { precos: { [p.id]: 99.5 }, ocultos: [cat.items[1]?.id], novos: [{ id: 'novo-x', cat: cat.id, name: 'Produto X', price: 7 }] });
      const c2 = m.find(c => c.id === cat.id);
      if (c2.items.find(x => x.id === p.id).price !== 99.5) throw new Error('preço não mudou');
      if (cat.items[1] && c2.items.some(x => x.id === cat.items[1].id)) throw new Error('escondido continua aparecendo');
      if (!c2.items.some(x => x.id === 'novo-x' && x.price === 7)) throw new Error('produto novo não entrou');
      if (MENU.find(c => c.id === cat.id).items.find(x => x.id === p.id).price === 99.5) throw new Error('mexeu no cardápio original');
    }
  });
  results.push({
    name: 'site de pedidos carrega o banco, as regras e o bot',
    fn: async () => {
      const html = await fetch(SITE).then(r => r.text());
      ['baldini-core.js', 'baldini-db.js', 'firebase-config.js', 'pedido.js', 'bot.js', 'baldini-gestao'].forEach(s => { if (!html.includes(s)) throw new Error('site sem ' + s); });
    }
  });
  results.push({
    name: 'gestão carrega os scripts certos',
    fn: () => {
      const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
      [...html.matchAll(/src="([^"?]+\.js)(\?[^"]*)?"/g)].map(m => m[1]).filter(s => !/^https?:/.test(s))
        .forEach(s => { if (!fs.existsSync(path.join(root, s))) throw new Error('script não existe: ' + s); });
      if (!html.includes(SITE + 'menu-data.js')) throw new Error('gestão não puxa o cardápio do site');
    }
  });

  let fail = 0;
  for (const t of results) {
    try { await t.fn(); console.log('  ✔', t.name); }
    catch (e) { fail++; console.log('  ✘', t.name, '\n     ', e.message); }
  }
  console.log(fail ? `\n${fail} de ${results.length} testes falharam` : `\n${results.length} testes passaram`);
  process.exit(fail ? 1 : 0);
})();
