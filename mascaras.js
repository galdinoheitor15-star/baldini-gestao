// ===== Máscaras dos campos (usadas no site de pedidos e na gestão) =====
// Basta colocar data-mask no <input>: money, percent, phone, cpf, cnpj, ncm ou int.
// Quem digita só consegue números, no formato certo e com o tamanho certo.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BaldiniMask = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const digits = (v, max) => String(v ?? '').replace(/\D/g, '').slice(0, max);
  const pattern = (d, parts) => {
    // parts: [[tamanho, separador antes], ...]
    let out = '', i = 0;
    for (const [len, sep] of parts) {
      if (i >= d.length) break;
      out += (i > 0 || sep === '(' ? sep : '') + d.slice(i, i + len);
      i += len;
    }
    return out;
  };
  const FORMAT = {
    // Valor em reais: os números entram pelos centavos, como em maquininha (R$ 99.999,99 no máximo)
    money(v, max = 7) {
      const d = digits(v, max).replace(/^0+(?=\d)/, '');
      if (!d) return '';
      const cents = d.padStart(3, '0');
      const int = cents.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
      return `R$ ${int},${cents.slice(-2)}`;
    },
    // Porcentagem com até 2 casas, no máximo 100
    percent(v) {
      let s = String(v ?? '').replace(/\./g, ',').replace(/[^\d,]/g, '');
      const [a, ...b] = s.split(',');
      s = a.slice(0, 3) + (b.length ? ',' + b.join('').slice(0, 2) : '');
      return Number(s.replace(',', '.')) > 100 ? '100' : s;
    },
    phone(v) {
      const d = digits(v, 11);
      if (d.length <= 2) return d ? `(${d}` : '';
      return d.length <= 10
        ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}${d.length > 6 ? '-' + d.slice(6) : ''}`
        : `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    },
    cpf: v => pattern(digits(v, 11), [[3, ''], [3, '.'], [3, '.'], [2, '-']]),
    cnpj: v => pattern(digits(v, 14), [[2, ''], [3, '.'], [3, '.'], [4, '/'], [2, '-']]),
    ncm: v => pattern(digits(v, 8), [[4, ''], [2, '.'], [2, '.']]),
    int: (v, max = 3) => digits(v, max)
  };
  const MAXLEN = { money: 16, percent: 6, phone: 15, cpf: 14, cnpj: 18, ncm: 10 };

  function format(type, value, max) {
    const f = FORMAT[type];
    return f ? f(value, max ? Number(max) : undefined) : String(value ?? '');
  }
  function fix(el) {
    const type = el.dataset.mask;
    if (!FORMAT[type]) return;
    if (!el.maxLength || el.maxLength < 0) el.maxLength = MAXLEN[type] || Number(el.dataset.max) || 3;
    if (!el.inputMode) el.inputMode = type === 'percent' ? 'decimal' : type === 'phone' ? 'tel' : 'numeric';
    const v = format(type, el.value, el.dataset.max);
    if (v !== el.value) el.value = v;
  }
  // Formata os campos que já têm valor (ex.: preenchidos pela tela)
  function apply(scope) {
    (scope || document).querySelectorAll?.('input[data-mask]').forEach(fix);
  }
  // Números puros para validar: (81) 98790-8900 → "81987908900"
  const onlyDigits = v => String(v ?? '').replace(/\D/g, '');
  // "R$ 1.234,56" → 1234.56
  const toNumber = v => Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.')) || 0;
  const validPhone = v => /^[1-9]{2}9?\d{8}$/.test(onlyDigits(v));
  function validCnpj(v) {
    const d = onlyDigits(v);
    if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
    const dv = n => {
      const w = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
      const r = w.reduce((s, x, i) => s + x * d[i], 0) % 11;
      return r < 2 ? 0 : 11 - r;
    };
    return dv(12) === +d[12] && dv(13) === +d[13];
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('input', e => { if (e.target.matches?.('input[data-mask]')) fix(e.target); }, true);
    // Campos criados depois (listas, janelas) também ganham a máscara
    const start = () => {
      apply(document);
      new MutationObserver(list => list.forEach(m => m.addedNodes.forEach(n => {
        if (n.nodeType !== 1) return;
        if (n.matches('input[data-mask]')) fix(n); else apply(n);
      }))).observe(document.body, { childList: true, subtree: true });
    };
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  }
  return { format, apply, onlyDigits, toNumber, validPhone, validCnpj };
});
