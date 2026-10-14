// Toolbar popup: your product list (click to open) and the dashboard link.

const $ = (id) => document.getElementById(id);
const ask = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));

function render(res, port) {
  const products = ((res && res.products) || []).filter((p) => p.enabled !== false);
  $('status').textContent = res && res.online
    ? `Connected to TCGBot · ${products.length} product(s)`
    : products.length ? 'TCGBot isn\'t running — showing your last saved list.' : 'TCGBot isn\'t running. Start it to load your products.';
  const list = $('list');
  list.textContent = '';
  products.forEach((p, i) => {
    const b = document.createElement('button');
    b.textContent = `${i + 1}. ${p.name}${typeof p.price === 'number' ? ` — $${p.price}` : ''}`;
    b.addEventListener('click', () => chrome.tabs.create({ url: p.url }));
    list.appendChild(b);
  });
  $('dashboard').href = `http://127.0.0.1:${port}/`;
  $('port').value = port;
}

(async () => {
  const { port } = await ask({ type: 'getPort' });
  render(await ask({ type: 'products' }), port);
  $('save').addEventListener('click', async () => {
    const p = Number($('port').value) || 8787;
    render(await ask({ type: 'setPort', port: p }), p);
  });
})();
