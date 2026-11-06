(() => {
  'use strict';

  const SESSION_KEY = 'hs_checkout_coupon';
  const DEFAULT_API_BASE = 'https://hs-nutrition-production.up.railway.app';
  const QUOTE_TTL_MS = 30_000;
  const CODE_FORMAT = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;
  const REJECTIONS = new Map([
    ['coupon_unavailable', 'This discount code is invalid or no longer available.'],
    ['invalid_coupon_code', 'Use 3–32 letters, numbers, hyphens or underscores, starting with a letter or number.'],
    ['coupon_not_applicable', 'This discount code does not apply to the products in your cart.'],
    ['coupon_zero_total', 'This discount leaves no payable balance. Remove the code or contact HS Nutrition.']
  ]);

  const normalizeCode = value => String(value || '').trim().toUpperCase();
  const euro = cents => '€ ' + (cents / 100).toFixed(2);
  let confirmedCode = readSavedCode();
  let requestedCode = confirmedCode;
  let cart = {empty: true, items: null, key: ''};
  let ui, pending, confirmedQuote, attemptedKey = '';
  let message = '', tone = '', invalidCode = '';
  let legacyTotal = '', managedTotalNode = null, ownedCheckout = null;

  function readSavedCode() {
    try {
      const code = normalizeCode(sessionStorage.getItem(SESSION_KEY));
      if (CODE_FORMAT.test(code)) return code;
    } catch (_) { /* Storage can be unavailable. */ }
    return '';
  }

  function saveConfirmedCode(code) {
    confirmedCode = code;
    try {
      if (code) sessionStorage.setItem(SESSION_KEY, code);
      else sessionStorage.removeItem(SESSION_KEY);
    } catch (_) { /* The cart still works without storage. */ }
  }

  function normalizeCart(rawCart) {
    if (!Array.isArray(rawCart) || !rawCart.length) return {empty: true, items: null, key: ''};
    const quantities = new Map();
    for (const line of rawCart) {
      if (!line || !['string', 'number'].includes(typeof line.id)) return {empty: false, items: null, key: ''};
      const id = String(line.id).trim();
      const quantity = Number(line.qty ?? line.quantity ?? 1);
      const combined = (quantities.get(id) || 0) + quantity;
      if (!id || !Number.isSafeInteger(quantity) || quantity < 1 || !Number.isSafeInteger(combined)) {
        return {empty: false, items: null, key: ''};
      }
      quantities.set(id, combined);
    }
    const items = Array.from(quantities, ([id, quantity]) => ({id, quantity}));
    items.sort((a, b) => a.id < b.id ? -1 : (a.id > b.id ? 1 : 0));
    return {empty: false, items, key: JSON.stringify(items)};
  }

  function node(tag, properties) {
    return Object.assign(document.createElement(tag), properties);
  }

  function mount() {
    if (ui) return true;
    const modal = document.getElementById('cartModal');
    if (!modal || !modal.querySelector('#cartItems')) return false;
    const totalRow = modal.querySelector('.cart-total');
    const total = totalRow?.querySelector('#cartTotal');
    const checkout = modal.querySelector('.cart-checkout');
    if (!total || !checkout) return false;

    const section = node('section', {className: 'hs-cart-coupon', hidden: true});
    const form = node('form', {className: 'hs-cart-coupon-form', noValidate: true});
    const label = node('label', {htmlFor: 'hs-cart-coupon-code', textContent: 'Discount code'});
    const controls = node('div', {className: 'hs-cart-coupon-controls'});
    const input = node('input', {
      id: 'hs-cart-coupon-code', name: 'couponCode', type: 'text', maxLength: 32,
      autocomplete: 'off', autocapitalize: 'characters', spellcheck: false, placeholder: 'Enter code',
      value: requestedCode
    });
    input.setAttribute('aria-describedby', 'hs-cart-coupon-help hs-cart-coupon-status');
    const apply = node('button', {type: 'submit', className: 'hs-cart-coupon-apply', textContent: 'Apply'});
    const remove = node('button', {type: 'button', className: 'hs-cart-coupon-remove', textContent: 'Remove', hidden: true});
    const help = node('p', {
      id: 'hs-cart-coupon-help', className: 'hs-cart-coupon-help',
      textContent: 'Discounts apply to eligible products. Shipping is selected at checkout.'
    });
    const status = node('p', {id: 'hs-cart-coupon-status', className: 'hs-cart-coupon-status'});
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    const breakdown = node('div', {className: 'hs-cart-coupon-breakdown', hidden: true});
    const subtotal = node('span', {});
    const discountLabel = node('span', {});
    const discount = node('span', {});
    const subtotalRow = node('div', {className: 'hs-cart-coupon-line'});
    const discountRow = node('div', {className: 'hs-cart-coupon-line hs-cart-coupon-savings'});
    subtotalRow.append(node('span', {textContent: 'Products subtotal'}), subtotal);
    discountRow.append(discountLabel, discount);
    breakdown.append(subtotalRow, discountRow);
    controls.append(input, apply, remove);
    form.append(label, controls);
    section.append(form, help, status);
    totalRow.before(section, breakdown);
    modal.classList.add('hs-cart-coupon-ready');
    ui = {modal, total, checkout, section, input, apply, remove, status, breakdown, subtotal, discountLabel, discount};

    form.addEventListener('submit', submitCode);
    input.addEventListener('input', render);
    remove.addEventListener('click', () => {
      resetCoupon('Discount code removed.');
      render();
      input.focus();
    });
    modal.addEventListener('click', event => {
      if (pending && (event.target === checkout || checkout.contains(event.target))) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
    return true;
  }

  function rememberLegacyTotal() {
    if (!managedTotalNode || ui.total.firstChild !== managedTotalNode) {
      legacyTotal = ui.total.textContent;
      managedTotalNode = null;
    }
  }

  function currentKey() {
    return cart.key + ':' + requestedCode;
  }

  function setCheckoutPending(waiting) {
    if (waiting && !ownedCheckout && !ui.checkout.disabled) {
      ownedCheckout = ui.checkout;
      ownedCheckout.dataset.hsCouponPending = 'true';
      ownedCheckout.disabled = true;
    } else if (!waiting && ownedCheckout) {
      if (ownedCheckout.dataset.hsCouponPending === 'true') {
        delete ownedCheckout.dataset.hsCouponPending;
        ownedCheckout.disabled = false;
      }
      ownedCheckout = null;
    }
  }

  function announce(text, variant = '', rejected = '') {
    message = text;
    tone = variant;
    invalidCode = rejected;
  }

  function render() {
    if (!ui) return;
    rememberLegacyTotal();
    const quote = confirmedQuote?.key === currentKey() ? confirmedQuote : null;
    if (quote) {
      const formatted = euro(quote.total);
      if (!managedTotalNode || managedTotalNode.textContent !== formatted) {
        managedTotalNode = document.createTextNode(formatted);
        ui.total.replaceChildren(managedTotalNode);
      }
      ui.subtotal.textContent = euro(quote.subtotal);
      ui.discountLabel.textContent = 'Discount (' + quote.code + ')';
      ui.discount.textContent = '− ' + euro(quote.discount);
    } else if (managedTotalNode) {
      managedTotalNode = null;
      ui.total.textContent = legacyTotal;
    }
    ui.breakdown.hidden = !quote;
    ui.section.hidden = cart.empty;
    const draft = normalizeCode(ui.input.value);
    ui.apply.disabled = !draft || Boolean(pending && draft === requestedCode);
    ui.remove.hidden = !requestedCode && !draft;
    ui.input.setAttribute('aria-invalid', String(Boolean(invalidCode && draft === invalidCode)));
    ui.status.dataset.tone = tone;
    if (ui.status.textContent !== message) ui.status.textContent = message;
    setCheckoutPending(Boolean(pending));
  }

  function cancelPending() {
    if (!pending) return;
    const old = pending;
    pending = null;
    clearTimeout(old.timer);
    old.controller.abort();
  }

  function resetCoupon(status = '') {
    cancelPending();
    requestedCode = '';
    confirmedQuote = null;
    attemptedKey = '';
    saveConfirmedCode('');
    if (ui) ui.input.value = '';
    announce(status);
  }

  function submitCode(event) {
    event.preventDefault();
    if (cart.empty) return;
    const code = normalizeCode(ui.input.value);
    if (!code) return;
    ui.input.value = code;
    if (code !== confirmedCode) saveConfirmedCode('');
    requestedCode = code;
    if (!CODE_FORMAT.test(code)) {
      cancelPending();
      confirmedQuote = null;
      attemptedKey = '';
      announce(REJECTIONS.get('invalid_coupon_code'), 'error', code);
      render();
      return;
    }
    checkQuote(true);
  }

  function asCents(value) {
    if (!['number', 'string'].includes(typeof value) || !/^\d+(?:\.\d{1,2})?$/.test(String(value))) return NaN;
    const result = Math.round(Number(value) * 100);
    return Number.isSafeInteger(result) ? result : NaN;
  }

  function validateQuote(data, request) {
    const subtotal = asCents(data.subtotal);
    const discount = asCents(data.discount);
    const total = asCents(data.total);
    const percentage = Number(data.coupon?.percentage);
    const code = normalizeCode(data.coupon?.code);
    if (data.shipping?.type !== 'none' || asCents(data.shipping.amount) !== 0 ||
        !Number.isFinite(subtotal) || !Number.isFinite(discount) || !Number.isFinite(total) ||
        subtotal - discount !== total || total <= 0 ||
        code !== request.code || !Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
      throw new Error('Invalid quote');
    }
    return {key: request.key, subtotal, discount, total, percentage, code, expiresAt: Date.now() + QUOTE_TTL_MS};
  }

  function announceUnverified(request, rateLimited = false) {
    const retry = rateLimited ? 'Please wait a moment and press Apply to retry.' : 'Press Apply to try again.';
    const next = confirmedCode === request.code ? ' Checkout can recheck the saved code.' : '';
    announce('We could not verify this discount. ' + retry + next, 'error');
  }

  async function checkQuote(force) {
    if (!requestedCode || !CODE_FORMAT.test(requestedCode)) {
      render();
      return;
    }
    if (!cart.items) {
      cancelPending();
      confirmedQuote = null;
      attemptedKey = '';
      announce('We could not check this cart. Review your products and try applying the code again.', 'error');
      render();
      return;
    }
    const key = currentKey();
    const reusableAttempt = attemptedKey === key && (!confirmedQuote || confirmedQuote.expiresAt > Date.now());
    if (pending?.key === key || (!force && reusableAttempt)) {
      render();
      return;
    }
    cancelPending();
    confirmedQuote = null;
    attemptedKey = key;
    const request = {key, code: requestedCode, controller: new AbortController()};
    pending = request;
    request.timer = setTimeout(() => {
      if (pending !== request) return;
      cancelPending();
      announceUnverified(request);
      render();
    }, 10000);
    announce('Checking ' + request.code + '…');
    render();
    try {
      const base = (window.HS_CHECKOUT_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');
      const response = await fetch(base + '/api/checkout/quote', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({items: cart.items, shippingType: 'none', couponCode: request.code}),
        signal: request.controller.signal
      });
      const data = await response.json();
      if (pending !== request || key !== currentKey()) return;
      if (!response.ok || data?.ok !== true) {
        const rejected = REJECTIONS.get(data?.code);
        if (rejected) {
          saveConfirmedCode('');
          announce(rejected, 'error', request.code);
        } else {
          announceUnverified(request, response.status === 429);
        }
      } else {
        confirmedQuote = validateQuote(data, request);
        saveConfirmedCode(confirmedQuote.code);
        announce(confirmedQuote.code + ' applied: ' + confirmedQuote.percentage + '% off eligible products. You save ' +
          euro(confirmedQuote.discount) + '.', 'success');
      }
    } catch (_) {
      if (pending === request) announceUnverified(request);
    } finally {
      if (pending === request) {
        clearTimeout(request.timer);
        pending = null;
        render();
      }
    }
  }

  function refresh(rawCart) {
    if (!mount()) return;
    cart = normalizeCart(rawCart);
    if (cart.empty) {
      resetCoupon();
      render();
    } else {
      checkQuote(false);
    }
  }

  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    const saved = readSavedCode();
    const savedChanged = saved !== confirmedCode;
    cancelPending();
    confirmedCode = requestedCode = saved;
    confirmedQuote = null;
    attemptedKey = '';
    announce('');
    if (ui) {
      if (savedChanged) ui.input.value = saved;
      render();
    }
    // Let the normal renderer reload the cart before requesting a new quote.
    const modal = ui?.modal || document.getElementById('cartModal');
    if (modal?.style.display === 'flex' && typeof window.openCart === 'function') window.openCart();
  });

  window.HSCartCoupon = Object.freeze({refresh});
})();
