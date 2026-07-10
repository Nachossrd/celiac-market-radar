const fmt = n => n == null ? '—' : new Intl.NumberFormat('es-CL').format(n);
const money = n => n == null ? '—' : '$' + new Intl.NumberFormat('es-CL').format(n);

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

function statusCard(name, info) {
  const cls = info.items > 0 ? 'ok' : (info.lastRun === 'Nunca' ? 'empty' : 'fail');
  const when = info.lastRun === 'Nunca' ? 'Nunca ejecutado' : new Date(info.lastRun).toLocaleString('es-CL');
  return `
    <div class="status-card ${cls}">
      <div class="name">${name}</div>
      <div class="meta">${fmt(info.items)} items</div>
      <div class="meta">${when}</div>
      ${info.errors ? `<div class="meta">errores: ${info.errors}</div>` : ''}
    </div>`;
}

async function renderStatus() {
  const status = await fetchJSON('/api/status');
  document.getElementById('status-grid').innerHTML =
    Object.entries(status).map(([k, v]) => statusCard(k, v)).join('');
}

async function renderReport() {
  const r = await fetchJSON('/api/report');

  // Advertencias
  if (r.confianza.advertencias.length) {
    document.getElementById('advertencias-section').hidden = false;
    document.getElementById('advertencias-list').innerHTML =
      r.confianza.advertencias.map(a => `<li>${a}</li>`).join('');
  }

  // Poblacion
  document.getElementById('poblacion-source').textContent =
    `${r.fuentesUsadas.poblacion} · Prevalencia: ${r.fuentesUsadas.prevalencia}`;
  document.getElementById('poblacion-stats').innerHTML = `
    <div class="stat"><div class="label">Comunas</div><div class="value">${fmt(r.poblacion.comunas)}</div></div>
    <div class="stat"><div class="label">Poblacion RM</div><div class="value">${fmt(r.poblacion.poblacion)}</div></div>
    <div class="stat"><div class="label">Celiacos estimados (serologico ${(r.poblacion.prevalenciaAplicada*100).toFixed(2)}%)</div><div class="value">${fmt(r.poblacion.celiacosEstimados)}</div></div>
    <div class="stat"><div class="label">Diagnosticados</div><div class="value">${fmt(r.poblacion.diagnosticados)}</div></div>
    <div class="stat"><div class="label">Subdiagnosticados</div><div class="value">${fmt(r.poblacion.subdiagnosticados)}</div></div>
  `;

  // Precios
  const p = r.precios;
  const rows = ['pan','pastel','galleta','harina'].map(cat => {
    const s = p[cat];
    if (s.count === 0) return `<tr><td>${cat}</td><td class="num muted">sin datos</td><td class="num muted">—</td><td class="num muted">—</td><td class="num muted">—</td><td class="num muted">—</td></tr>`;
    return `<tr><td>${cat}</td><td class="num">${s.count}</td><td class="num">${money(s.min)}</td><td class="num">${money(s.median)}</td><td class="num">${money(s.avg)}</td><td class="num">${money(s.max)}</td></tr>`;
  }).join('');
  document.getElementById('precios-table').innerHTML = `
    <table>
      <thead><tr><th>Categoria</th><th class="num">N</th><th class="num">Min</th><th class="num">Mediana</th><th class="num">Promedio</th><th class="num">Max</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  // Marcas
  const marcas = r.marcas.slice(0, 15);
  if (marcas.length === 0) {
    document.getElementById('marcas-list').innerHTML = '<p class="muted">Sin productos scrapeados. Ejecuta los scrapers de supermercados / MercadoLibre.</p>';
  } else {
    document.getElementById('marcas-list').innerHTML = `
      <table>
        <thead><tr><th>Marca</th><th class="num">SKUs</th><th class="num">% del total</th></tr></thead>
        <tbody>${marcas.map(m => `<tr><td>${m.name}</td><td class="num">${m.count}</td><td class="num">${m.sharePercentage}%</td></tr>`).join('')}</tbody>
      </table>`;
  }

  // Trends
  if (r.trends.length === 0) {
    document.getElementById('trends-list').innerHTML = '<p class="muted">Sin datos de Google Trends. Ejecuta <code>npm run scrape:trends</code>.</p>';
  } else {
    document.getElementById('trends-list').innerHTML = `
      <table>
        <thead><tr><th>Keyword</th><th>Categoria</th><th class="num">Interes promedio (0-100)</th></tr></thead>
        <tbody>${r.trends.map(t => `<tr><td>${t.keyword}</td><td>${t.category}</td><td class="num">${t.avgInterest}</td></tr>`).join('')}</tbody>
      </table>`;
  }

  // Comunas
  const topByDemand = [...r.demanda].sort((a,b) => b.demandaAtraida - a.demandaAtraida).slice(0, 20);
  document.getElementById('comunas-table').innerHTML = `
    <p class="source-line">${r.fuentesUsadas.mobility.tipoDeDato === 'proxy_estimado' ? '<strong>Aviso:</strong> matriz de movilidad es PROXY estimado, no EOD oficial SECTRA.' : 'Fuente movilidad: ' + r.fuentesUsadas.mobility.fuente}</p>
    <table>
      <thead><tr><th>Comuna</th><th class="num">Poblacion</th><th class="num">Celiacos</th><th class="num">Retenida</th><th class="num">Atraida</th></tr></thead>
      <tbody>${topByDemand.map(c => `<tr><td>${c.nombre}</td><td class="num">${fmt(c.poblacion)}</td><td class="num">${fmt(c.celiacosSerologico)}</td><td class="num">${fmt(c.demandaRetenida)}</td><td class="num">${fmt(c.demandaAtraida)}</td></tr>`).join('')}</tbody>
    </table>`;
}

function radiusForCeliacos(n) {
  // Escala visual: raiz cuadrada para que los grandes no eclipsen a los chicos
  return Math.max(6, Math.sqrt(n) * 0.7);
}
function colorForCeliacos(n) {
  if (n >= 4000) return '#ef4444';
  if (n >= 2000) return '#f97316';
  if (n >= 1000) return '#facc15';
  if (n >= 500)  return '#84cc16';
  return '#22c55e';
}

async function renderMap() {
  const comunasData = await fetchJSON('/api/comunas');
  const regionCtx = await fetchJSON('/api/regions/current');
  const center = regionCtx.centroide || { lat: -33.47, lng: -70.65, zoom: 10 };

  // Si el mapa ya existe (region cambiada), lo destruimos antes
  const oldMap = document.getElementById('mapa');
  if (oldMap && oldMap._leaflet_id) {
    oldMap.innerHTML = '';
    delete oldMap._leaflet_id;
  }
  const map = L.map('mapa').setView([center.lat, center.lng], center.zoom);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap, &copy; CARTO',
    maxZoom: 19
  }).addTo(map);

  const comunaLayer = L.layerGroup().addTo(map);
  for (const c of comunasData.comunas) {
    if (c.lat == null || c.lng == null) continue;
    const n = c.celiacos.estimadoSerologico;
    L.circleMarker([c.lat, c.lng], {
      radius: radiusForCeliacos(n),
      color: colorForCeliacos(n),
      fillColor: colorForCeliacos(n),
      fillOpacity: 0.45,
      weight: 1
    }).bindPopup(`
      <strong>${c.nombre}</strong><br>
      Poblacion: ${fmt(c.poblacion)}<br>
      Celiacos estimados: ${fmt(n)}<br>
      Diagnosticados: ${fmt(c.celiacos.diagnosticados)}<br>
      Subdiagnosticados: ${fmt(c.celiacos.subdiagnosticados)}
    `).addTo(comunaLayer);
  }

  // Pins de panaderias scrapeadas (si hay)
  // Si el scraper no geocodifico direcciones, ubicamos cerca del centroide de su comuna.
  const comunaByName = {};
  for (const c of comunasData.comunas) {
    if (c.lat != null && c.lng != null) {
      comunaByName[c.nombre.toLowerCase()] = c;
    }
  }
  let panaderiasCount = 0;
  let aproximadasCount = 0;
  let mapsSource = null;
  try {
    // Primero intentamos el dataset regional
    const slug = regionCtx.slug;
    let maps;
    try {
      maps = await fetchJSON(`/api/scraped/google-maps-${slug}`);
      mapsSource = `google-maps-${slug}`;
    } catch {
      // Fallback al dataset nacional viejo
      maps = await fetchJSON('/api/scraped/google-maps');
      mapsSource = 'google-maps (nacional fallback)';
    }
    if (Array.isArray(maps.data)) {
      const bakeryLayer = L.layerGroup().addTo(map);
      for (const b of maps.data) {
        let lat = b.lat, lng = b.lng, aproximado = false;
        if (lat == null || lng == null) {
          const comuna = b.comuna && comunaByName[b.comuna.toLowerCase()];
          if (!comuna) continue;
          // Offset chico para no apilar todos en el mismo punto (~150-300m random)
          const seed = (b.name || b.nombre || '').length;
          lat = comuna.lat + ((seed * 31 % 100) - 50) / 25000;
          lng = comuna.lng + ((seed * 17 % 100) - 50) / 25000;
          aproximado = true;
          aproximadasCount++;
        }
        L.marker([lat, lng]).bindPopup(`
          <strong>${b.name || b.nombre || 'Local'}</strong><br>
          Comuna: ${b.comuna || '—'}<br>
          Rating: ${b.rating ?? '—'} (${b.reviews ?? 0} reviews)<br>
          ${b.address ? b.address + '<br>' : ''}
          ${aproximado ? '<em>Ubicacion aproximada (centroide comuna)</em><br>' : ''}
          ${b.placeUrl ? `<a href="${b.placeUrl}" target="_blank">Ver en Google Maps</a>` : ''}
        `).addTo(bakeryLayer);
        panaderiasCount++;
      }
    }
  } catch (e) {
    // Sin datos de google-maps todavia: no es error, es esperado
  }

  const legend = document.getElementById('mapa-legend');
  const isFallbackRM = mapsSource && mapsSource.includes('nacional fallback') && regionCtx.slug !== 'metropolitana';
  const noPins = panaderiasCount === 0;
  const buttonLabel = noPins
    ? `Cargar locales de ${regionCtx.nombre} (~5-10 min)`
    : `Re-scrapear locales de ${regionCtx.nombre}`;

  legend.innerHTML = `
    ${noPins
      ? `<span class="muted">Sin locales scrapeados para ${regionCtx.nombre}. Apreta el boton para traerlos (Google Maps, tarda 5-10 min y puede pedir CAPTCHA).</span>`
      : `<strong>${panaderiasCount}</strong> locales mostrados${aproximadasCount > 0 ? ` (${aproximadasCount} ubicaciones aproximadas por comuna)` : ''}. Fuente: ${mapsSource}.${isFallbackRM ? ' <span class="warn-inline">⚠ Mostrando datos RM como fallback — no son de esta region.</span>' : ''}`
    }
    <br><button id="btn-scrape-maps" class="btn-primary">${buttonLabel}</button>
    <span id="btn-scrape-maps-status"></span>
  `;

  document.getElementById('btn-scrape-maps').addEventListener('click', async () => {
    const btn = document.getElementById('btn-scrape-maps');
    const stat = document.getElementById('btn-scrape-maps-status');
    btn.disabled = true;
    stat.textContent = ' · disparado, ver Pipeline automatica para progreso...';
    try {
      await fetch('/api/auto/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeMaps: true, skipIne: true, skipTrends: true, skipRetail: true })
      });
      // El SSE recibira start/step(maps-scrape)/done y recargara la pagina.
    } catch (e) {
      stat.textContent = ` · error: ${e.message}`;
      btn.disabled = false;
    }
  });
}

const NIVEL_COLOR = {
  'Alto':        '#1b7e2b',
  'Medio-Alto':  '#5aa648',
  'Medio':       '#d4a017',
  'Medio-Bajo':  '#e8772e',
  'Bajo':        '#c0392b'
};

async function renderINE() {
  let data;
  try {
    data = await fetchJSON('/api/ine/ranking');
  } catch (e) {
    document.getElementById('ine-summary').innerHTML =
      `<div class="stat"><div class="label">INE</div><div class="value">—</div></div>`;
    document.getElementById('ine-table').innerHTML =
      `<p class="muted">No hay datos INE todavia. Ejecuta <code>npm run scrape:ine</code> (~3 min) o haz POST /api/ine/scrape.</p>`;
    return;
  }
  const ranking = data.ranking;
  if (!ranking.length) {
    document.getElementById('ine-table').innerHTML =
      `<p class="muted">No hay perfiles con score. Ejecuta <code>npm run scrape:ine</code>.</p>`;
    return;
  }

  const conAlta = ranking.filter(r => r.clase_confianza === 'alta').length;
  const promedio = (ranking.reduce((s, r) => s + r.poder_adquisitivo, 0) / ranking.length).toFixed(1);
  const top = ranking[0];
  const bot = ranking[ranking.length - 1];

  document.getElementById('ine-summary').innerHTML = `
    <div class="stat"><div class="label">Comunas perfiladas</div><div class="value">${ranking.length}</div></div>
    <div class="stat"><div class="label">Alta confianza</div><div class="value">${conAlta}</div></div>
    <div class="stat"><div class="label">Score promedio</div><div class="value">${promedio}</div></div>
    <div class="stat"><div class="label">Top</div><div class="value">${top.comuna} (${top.poder_adquisitivo})</div></div>
    <div class="stat"><div class="label">Bottom</div><div class="value">${bot.comuna} (${bot.poder_adquisitivo})</div></div>
  `;

  const rows = ranking.map(r => `
    <tr>
      <td>${r.rank}</td>
      <td>${r.comuna}</td>
      <td>${r.sector || '—'}</td>
      <td style="background:${NIVEL_COLOR[r.nivel_socioeconomico] || '#888'}1a; font-weight:600">
        ${r.poder_adquisitivo}
      </td>
      <td><span class="badge" style="background:${NIVEL_COLOR[r.nivel_socioeconomico] || '#888'}; color:#fff">${r.nivel_socioeconomico}</span></td>
      <td>${r.clase_confianza}</td>
      <td>${r.elasticidad_precio}</td>
      <td>${r.probabilidad_consumo_premium != null ? (r.probabilidad_consumo_premium * 100).toFixed(0) + '%' : '—'}</td>
      <td>${r.nivel_educacional || '—'}</td>
      <td>${fmt(r.poblacion)}</td>
    </tr>
  `).join('');

  document.getElementById('ine-table').innerHTML = `
    <table class="ine-table">
      <thead><tr>
        <th>#</th><th>Comuna</th><th>Sector</th><th>Score</th><th>Nivel</th>
        <th>Confianza</th><th>Elasticidad</th><th>P(premium)</th><th>Educacion</th><th>Poblacion</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function renderRegionBar() {
  const sel = document.getElementById('region-select');
  const info = document.getElementById('region-info');
  if (!sel) return;
  try {
    const data = await fetchJSON('/api/regions');
    sel.innerHTML = data.regions.map(r =>
      `<option value="${r.slug}"${r.activa ? ' selected' : ''}>${r.nombre} (${r.totalComunas})</option>`
    ).join('');
    const active = data.regions.find(r => r.activa);
    if (active) {
      info.innerHTML = `<strong>${active.nombre}</strong> · DEIS ${active.codigoRegion} · ${active.perfilEconomico.join(', ')}`;
      // Propaga el nombre a cualquier .region-tag del HTML
      document.querySelectorAll('.region-tag').forEach(el => el.textContent = active.nombre);
    }
    sel.addEventListener('change', async (ev) => {
      const slug = ev.target.value;
      sel.disabled = true;
      showOverlay(`Cambiando a ${slug}...`, 'Recalculando inteligencia territorial');
      try {
        const r = await fetch('/api/regions/set', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug })
        }).then(r => r.json());
        if (!r.pipelineTriggered) {
          hideOverlay();
          sel.disabled = false;
          return;
        }
        // Esperamos el evento SSE `done` (lo escucha renderAuto via window._sseConnected)
        window.__pendingRegionChange = slug;
      } catch (e) {
        hideOverlay();
        sel.disabled = false;
        info.innerHTML = `Error: ${e.message}`;
      }
    });
  } catch (e) {
    info.innerHTML = `Error cargando regiones: ${e.message}`;
  }
}

let _overlayTimer = null;
let _overlayPollTimer = null;

function showOverlay(title, sub) {
  let el = document.getElementById('region-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'region-overlay';
    el.innerHTML = `
      <div class="overlay-box">
        <div class="spinner"></div>
        <div class="overlay-title"></div>
        <div class="overlay-sub"></div>
        <div class="overlay-log"></div>
        <div class="overlay-actions">
          <button class="overlay-reload">Recargar ahora</button>
          <button class="overlay-cancel">Cerrar overlay</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('.overlay-reload').onclick = () => window.location.reload();
    el.querySelector('.overlay-cancel').onclick = () => {
      hideOverlay();
      if (window.__pendingRegionChange) delete window.__pendingRegionChange;
      const sel = document.getElementById('region-select');
      if (sel) sel.disabled = false;
    };
  }
  el.querySelector('.overlay-title').textContent = title;
  el.querySelector('.overlay-sub').textContent = sub || '';
  el.querySelector('.overlay-log').innerHTML = '';
  el.style.display = 'flex';

  // Timeout de seguridad: si tras 3 min no llego done, muestro mensaje
  if (_overlayTimer) clearTimeout(_overlayTimer);
  _overlayTimer = setTimeout(() => {
    appendOverlayLog('⚠ 3 min sin recibir "done". Probable: SSE desconectado.');
    appendOverlayLog('Click "Recargar ahora" para forzar refresh, o "Cerrar overlay".');
  }, 180000);

  // Plan B: cada 5s consulta /api/auto/status. Si esta idle y la region es la
  // que pediste, recarga (cubre el caso SSE perdido).
  if (_overlayPollTimer) clearInterval(_overlayPollTimer);
  _overlayPollTimer = setInterval(async () => {
    if (!window.__pendingRegionChange) {
      clearInterval(_overlayPollTimer);
      return;
    }
    try {
      const st = await fetchJSON('/api/auto/status');
      if (!st.running && st.currentRegion === window.__pendingRegionChange) {
        appendOverlayLog(`✓ status idle, region=${st.currentRegion} — recargando (via polling)`);
        delete window.__pendingRegionChange;
        clearInterval(_overlayPollTimer);
        setTimeout(() => window.location.reload(), 400);
      } else if (st.running) {
        appendOverlayLog(`… running step="${st.running.step}"`);
      }
    } catch (e) { /* ignore */ }
  }, 5000);
}

function appendOverlayLog(line) {
  const el = document.getElementById('region-overlay');
  if (!el || el.style.display === 'none') return;
  const log = el.querySelector('.overlay-log');
  log.insertAdjacentHTML('beforeend', `<div>${line}</div>`);
  log.scrollTop = log.scrollHeight;
}

function hideOverlay() {
  const el = document.getElementById('region-overlay');
  if (el) el.style.display = 'none';
  if (_overlayTimer)     { clearTimeout(_overlayTimer);   _overlayTimer = null; }
  if (_overlayPollTimer) { clearInterval(_overlayPollTimer); _overlayPollTimer = null; }
}

async function renderCeliac() {
  let data;
  try {
    data = await fetchJSON('/api/celiac/profiles');
  } catch (e) {
    document.getElementById('celiac-table').innerHTML =
      `<p class="muted">Celiac scorer no disponible: ${e.message}</p>`;
    return;
  }
  const perfiles = (data.perfiles || []).filter(p => p.celiac_score !== null)
    .sort((a, b) => b.celiac_score - a.celiac_score);

  document.getElementById('celiac-validation').innerHTML = `
    <p class="source-line">
      Evidencia global: <strong>${data.validation.overallEvidence}</strong>
      · confianza ${(data.validation.overallConfidence * 100).toFixed(0)}%
      · prevalencia base ${(data.base_literature.prevalencia * 100).toFixed(2)}%
      (Araya 2015) · ratio subdiagnostico ${data.base_literature.ratio_subdiagnostico}:1 (Fasano 2003)
    </p>
  `;

  if (!perfiles.length) {
    document.getElementById('celiac-table').innerHTML =
      `<p class="muted">No hay perfiles celiacos. Asegura demografia scrapeada.</p>`;
    return;
  }

  const total = perfiles.reduce((s, p) => s + (p.estimated_celiac_population || 0), 0);
  const avgScore = (perfiles.reduce((s, p) => s + p.celiac_score, 0) / perfiles.length).toFixed(1);
  const avgConf = (perfiles.reduce((s, p) => s + p.confidence, 0) / perfiles.length).toFixed(2);
  document.getElementById('celiac-summary').innerHTML = `
    <div class="stat"><div class="label">Comunas evaluadas</div><div class="value">${perfiles.length}</div></div>
    <div class="stat"><div class="label">Celiacos estimados (region)</div><div class="value">${fmt(total)}</div></div>
    <div class="stat"><div class="label">Score promedio</div><div class="value">${avgScore}</div></div>
    <div class="stat"><div class="label">Confianza promedio</div><div class="value">${(avgConf * 100).toFixed(0)}%</div></div>
    <div class="stat"><div class="label">Top</div><div class="value">${perfiles[0].comuna} (${perfiles[0].celiac_score})</div></div>
  `;

  const rows = perfiles.slice(0, 50).map((p, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${p.comuna}</td>
      <td>${p.celiac_score}</td>
      <td>${(p.confidence * 100).toFixed(0)}%</td>
      <td>${p.prevalencia_estimada_pct}%</td>
      <td>${fmt(p.estimated_celiac_population)}</td>
      <td>${p.ethnic_modifier.toFixed(2)} × (${(p.ethnic_modifier_confidence * 100).toFixed(0)}%)</td>
      <td>${p.diagnostic_access || '—'}</td>
      <td>${p.market_gap_gluten_free ?? '—'}</td>
    </tr>
  `).join('');

  document.getElementById('celiac-table').innerHTML = `
    <table class="ine-table">
      <thead><tr>
        <th>#</th><th>Comuna</th><th>Score</th><th>Conf</th><th>Prevalencia</th>
        <th>Celiacos est.</th><th>Mod. etnico</th><th>Acceso dx</th><th>Gap GF</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function renderAuto() {
  let st;
  try {
    st = await fetchJSON('/api/auto/status');
  } catch (e) {
    document.getElementById('auto-status').innerHTML = `<p class="muted">${e.message}</p>`;
    return;
  }
  const r = st.running;
  document.getElementById('auto-status').innerHTML = `
    <div class="stat"><div class="label">Region activa</div><div class="value">${st.currentRegion}</div></div>
    <div class="stat"><div class="label">Estado</div><div class="value">${r ? 'corriendo: ' + r.step : 'idle'}</div></div>
    <div class="stat"><div class="label">Ultima corrida</div><div class="value">${st.lastRun?.finishedAt?.slice(0, 19) || '—'}</div></div>
  `;

  // SSE para eventos en vivo (con reconexion)
  if (!window._sseConnected) {
    const log = document.getElementById('auto-events');
    const append = (kind, evt) => {
      const ts = new Date(evt.at || Date.now()).toLocaleTimeString('es-CL');
      log.insertAdjacentHTML('afterbegin',
        `<div class="event evt-${kind}"><span class="ts">${ts}</span> <strong>${kind}</strong> ${evt.region || ''} ${evt.step || evt.error || ''}</div>`);
      const items = log.querySelectorAll('.event');
      if (items.length > 50) items[items.length - 1].remove();
    };
    let es;
    const connect = () => {
      es = new EventSource('/api/events');
      es.onerror = () => {
        // EventSource reconecta solo; pero si el navegador suspende, no.
        // Reconexion explicita tras 3s.
        try { es.close(); } catch {}
        append('hello', { region: '(reconectando SSE en 3s...)' });
        setTimeout(connect, 3000);
      };
    es.addEventListener('hello', e => append('hello', JSON.parse(e.data)));
    es.addEventListener('start', e => {
      const d = JSON.parse(e.data);
      append('start', d);
      if (window.__pendingRegionChange === d.region) {
        showOverlay(`Procesando ${d.region}...`, 'pipeline iniciada');
      }
    });
    es.addEventListener('step',  e => {
      const d = JSON.parse(e.data);
      append('step', d);
      if (window.__pendingRegionChange === d.region) {
        appendOverlayLog(`> ${d.step}`);
      }
    });
    es.addEventListener('done',  e => {
      const d = JSON.parse(e.data);
      append('done', d);
      if (window.__pendingRegionChange === d.region) {
        appendOverlayLog(`✓ completado en ${d.durationMs}ms — recargando...`);
        delete window.__pendingRegionChange;
        setTimeout(() => window.location.reload(), 600);
      } else {
        // Si la corrida incluyo Maps o Reviews, recargo entera para que el
        // mapa se rebuilde con los nuevos pins.
        const updated = d.result?.steps || {};
        if (updated.maps || updated.reviews) {
          setTimeout(() => window.location.reload(), 600);
        } else {
          renderCeliac(); renderINE(); renderAuto();
        }
      }
    });
    es.addEventListener('error', e => {
        let d = {}; try { d = JSON.parse(e.data); } catch {}
        append('error', d);
        if (window.__pendingRegionChange) {
          hideOverlay();
          delete window.__pendingRegionChange;
        }
      });
    };
    connect();
    window._sseConnected = true;
  }
}

(async () => {
  try {
    await renderRegionBar();
    await renderStatus();
    await renderMap();
    await renderReport();
    await renderINE();
    await renderCeliac();
    await renderAuto();
  } catch (e) {
    document.querySelector('main').insertAdjacentHTML('afterbegin',
      `<div class="warn-box"><h2>Error cargando dashboard</h2><pre>${e.message}</pre></div>`);
  }
})();
