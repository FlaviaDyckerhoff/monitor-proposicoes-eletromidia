const fs = require('fs');
const { DOMParser } = require('@xmldom/xmldom');
const AdmZip = require('adm-zip');
const iconv = require('iconv-lite');
const nodemailer = require('nodemailer');

// CMRJ usa cadeia TLS antiga; manter igual ao monitor CMRJ existente.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const EMAIL_DESTINO = process.env.EMAIL_DESTINO || 'tramitacao@monitorlegislativo.com.br';
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const DRY_RUN = String(process.env.DRY_RUN || '').toLowerCase() === 'true';
const ARQUIVO_ESTADO = 'estado.json';
const ANO = String(new Date().getFullYear());

const HIGH_TERMS = [
  'Eletromidia',
  'Eletromidia S.A.',
  '09.347.516/0001-81',
  'OOH',
  'Out of home',
  'Midia out of home',
  'Mídia out of home',
  'Outdoor',
  'Busdoor',
  'Cidade Limpa',
  'Lei Cidade Limpa',
  'Lei da Cidade Limpa',
  'Poluicao Visual',
  'Poluição Visual',
  'Abrigos de onibus',
  'Abrigos de ônibus',
  'Paradas de onibus',
  'Paradas de ônibus',
  'Anuncio Luminoso',
  'Anúncio Luminoso',
  'Anuncios Luminosos',
  'Anúncios Luminosos',
  'Painel de LED',
  'Paineis de LED',
  'Painéis de LED',
  'Painel luminoso',
  'Paineis luminosos',
  'Painéis luminosos',
  'Letreiro digital',
  'Letreiros digitais',
  'Tela digital',
  'Telas digitais',
  'Teloes de LED',
  'Telões de LED',
];

const MEDIUM_TERMS = [
  'Painel',
  'Paineis',
  'Painéis',
  'LED',
  'Propaganda',
  'Times Square',
  'Boulevard Sao Joao',
  'Boulevard São João',
  'New York Food Lounge',
];

function carregarEstado() {
  if (!fs.existsSync(ARQUIVO_ESTADO)) {
    return { proposicoes_vistas: [], matches_enviados: [], ultima_execucao: '' };
  }
  const estado = JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
  return {
    proposicoes_vistas: estado.proposicoes_vistas || [],
    matches_enviados: estado.matches_enviados || [],
    ultima_execucao: estado.ultima_execucao || '',
  };
}

function salvarEstado(estado) {
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

function normalizarTexto(valor) {
  return String(valor || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escaparHtml(valor) {
  return String(valor || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function limparHtml(valor) {
  return String(valor || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&ccedil;/g, 'c')
    .replace(/&atilde;/g, 'a')
    .replace(/&otilde;/g, 'o')
    .replace(/&aacute;/g, 'a')
    .replace(/&eacute;/g, 'e')
    .replace(/&iacute;/g, 'i')
    .replace(/&oacute;/g, 'o')
    .replace(/&uacute;/g, 'u')
    .replace(/&agrave;/g, 'a')
    .replace(/&ecirc;/g, 'e')
    .replace(/&ocirc;/g, 'o')
    .replace(/\s+/g, ' ')
    .trim();
}

function getText(node, tagName) {
  const els = node.getElementsByTagName(tagName);
  if (els.length === 0) return '';
  const child = els[0].childNodes[0];
  return child ? child.nodeValue.trim() : '';
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': options.userAgent || 'Mozilla/5.0 (compatible; monitor-eletromidia/1.0)',
      'Accept': options.accept || 'text/html,application/xhtml+xml,application/xml,application/json,*/*',
    },
    signal: AbortSignal.timeout(options.timeoutMs || 30000),
  });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' em ' + url);
  return response.text();
}

async function fetchBuffer(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': options.userAgent || 'Mozilla/5.0 (compatible; monitor-eletromidia/1.0)',
      'Accept': options.accept || '*/*',
    },
    signal: AbortSignal.timeout(options.timeoutMs || 60000),
  });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' em ' + url);
  return Buffer.from(await response.arrayBuffer());
}

function hashCurto(valor) {
  let hash = 0;
  const texto = String(valor || '');
  for (let i = 0; i < texto.length; i++) {
    hash = ((hash << 5) - hash) + texto.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function dedupeKey(item) {
  const base = [
    item.source,
    item.tipo || '',
    item.numero || '',
    item.ano || '',
    item.codigo || '',
    item.id || '',
    hashCurto(item.url || item.raw_text || ''),
  ].join(':');
  return normalizarTexto(base).replace(/\s+/g, ':');
}

function normalizarItem(item) {
  const rawText = [
    item.source,
    item.casa,
    item.tipo,
    item.numero,
    item.ano,
    item.ementa,
    item.autor,
    item.raw_text,
  ].filter(Boolean).join(' ');
  const normalizado = {
    source: item.source,
    uf: item.uf,
    casa: item.casa,
    tipo: item.tipo || '-',
    numero: item.numero || '-',
    ano: String(item.ano || ANO),
    ementa: item.ementa || '-',
    autor: item.autor || null,
    data_apresentacao: item.data_apresentacao || item.data || null,
    url: item.url || '',
    raw_text: rawText,
  };
  normalizado.dedupe_key = dedupeKey({ ...item, ...normalizado });
  return normalizado;
}

function termoBate(textoNormalizado, termo) {
  const termoNorm = normalizarTexto(termo);
  if (!termoNorm) return false;
  return (' ' + textoNormalizado + ' ').includes(' ' + termoNorm + ' ');
}

function classificarMatch(item) {
  const textoNormalizado = normalizarTexto(item.raw_text);
  const termosAlta = HIGH_TERMS.filter(t => termoBate(textoNormalizado, t));
  const termosMedia = MEDIUM_TERMS.filter(t => termoBate(textoNormalizado, t));

  if (termosAlta.length > 0) {
    return {
      ...item,
      matched_terms: Array.from(new Set([...termosAlta, ...termosMedia])),
      confidence: 'alta',
    };
  }

  if (termosMedia.length > 0) {
    return {
      ...item,
      matched_terms: Array.from(new Set(termosMedia)),
      confidence: 'media',
    };
  }

  return null;
}

function extrairXmlDoZip(zipBuffer) {
  const zip = new AdmZip(zipBuffer);
  const xmlEntry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith('.xml'));
  if (!xmlEntry) throw new Error('Nenhum XML encontrado no ZIP ALESP');
  return xmlEntry.getData().toString('utf8');
}

function descobrirTagItem(doc) {
  const root = doc.documentElement;
  for (let i = 0; i < root.childNodes.length; i++) {
    if (root.childNodes[i].nodeType === 1) return root.childNodes[i].tagName;
  }
  return null;
}

async function carregarNaturezasAlesp() {
  try {
    const xml = await fetchText('https://www.al.sp.gov.br/repositorioDados/processo_legislativo/naturezasSpl.xml', { timeoutMs: 30000 });
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const items = doc.getElementsByTagName('natureza');
    const mapa = {};
    for (let i = 0; i < items.length; i++) {
      const id = getText(items[i], 'idNatureza');
      const sigla = getText(items[i], 'sgNatureza');
      const nome = getText(items[i], 'nmNatureza');
      if (id) mapa[id] = sigla || nome || id;
    }
    return mapa;
  } catch (err) {
    console.warn('ALESP naturezas: ' + err.message);
    return {};
  }
}

function parsearAlespXml(xml, naturezas) {
  const itens = [];
  const tag = /<propositura>([\s\S]*?)<\/propositura>/g;
  let match;
  while ((match = tag.exec(xml)) !== null) {
    const bloco = match[1];
    const campo = (nome) => {
      const m = bloco.match(new RegExp('<' + nome + '>([\\s\\S]*?)<\\/' + nome + '>'));
      return m ? limparHtml(m[1]).trim() : '';
    };
    const ano = campo('AnoExercicio') || campo('Ano') || campo('AnoLegislativo');
    if (String(ano) !== ANO) continue;
    const id = campo('IdDocumento') || campo('Codigo') || campo('id');
    if (!id) continue;
    const idNat = campo('idNatureza') || campo('IdNatureza') || campo('CdNatureza');
    const tipo = campo('sgNatureza') || campo('nmNatureza') || naturezas[idNat] || 'OUTROS';
    const numero = campo('NroLegislativo') || campo('Numero') || campo('NrLegislativo') || '-';
    let data = campo('DtEntradaSistema') || campo('DataApresentacao') || campo('DtApresentacao') || null;
    if (data && data.includes('T')) data = data.split('T')[0];
    itens.push(normalizarItem({
      source: 'ALESP',
      uf: 'SP',
      casa: 'ALESP',
      id,
      tipo,
      numero,
      ano,
      data_apresentacao: data,
      ementa: campo('Ementa') || campo('dsEmenta') || campo('Assunto') || '-',
      url: 'https://www.al.sp.gov.br/propositura/?id=' + id,
    }));
  }

  return itens;
}

function dataBrParaIso(dataBr) {
  const match = String(dataBr || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return match ? match[3] + '-' + match[2] + '-' + match[1] : null;
}

function parsearAlespListagem(html, tipoFallback) {
  const proposicoes = [];
  let pos = 0;
  while (pos < html.length) {
    const classPos = html.indexOf('class="tituloItem"', pos);
    if (classPos === -1) break;
    const aStart = html.lastIndexOf('<a', classPos);
    const aEnd = html.indexOf('</a>', classPos);
    if (aStart === -1 || aEnd === -1) {
      pos = classPos + 20;
      continue;
    }

    const anchor = html.slice(aStart, aEnd + 4);
    const hrefMatch = anchor.match(/href="\/propositura\/\?id=(\d+)&tipo=(\d+)&ano=(\d+)"/);
    if (!hrefMatch) {
      pos = aEnd + 4;
      continue;
    }

    const pStart = html.indexOf('<p>', aEnd);
    const pEnd = pStart === -1 ? -1 : html.indexOf('</p>', pStart);
    if (pStart === -1 || pEnd === -1) {
      pos = aEnd + 4;
      continue;
    }

    const id = hrefMatch[1];
    const titulo = limparHtml(anchor);
    const ementa = limparHtml(html.slice(pStart + 3, pEnd));
    const dados = titulo.match(/^(.+?)\s+(\d+)\/(\d{4}),\s+de\s+(\d{2}\/\d{2}\/\d{4})/i);
    if (dados && dados[3] === ANO) {
      proposicoes.push(normalizarItem({
        source: 'ALESP',
        uf: 'SP',
        casa: 'ALESP',
        id,
        tipo: dados[1] || tipoFallback,
        numero: dados[2],
        ano: dados[3],
        data_apresentacao: dataBrParaIso(dados[4]),
        ementa,
        url: 'https://www.al.sp.gov.br/propositura/?id=' + id,
      }));
    }
    pos = pEnd + 4;
  }
  return proposicoes;
}

async function buscarAlesp() {
  const todas = [];
  if (String(process.env.ALESP_USE_ZIP || 'true').toLowerCase() !== 'false') {
    try {
      const naturezas = await carregarNaturezasAlesp();
      const zipBuffer = await fetchBuffer('https://www.al.sp.gov.br/repositorioDados/processo_legislativo/proposituras.zip', { timeoutMs: 120000 });
      todas.push(...parsearAlespXml(extrairXmlDoZip(zipBuffer), naturezas));
    } catch (err) {
      console.warn('ALESP ZIP: ' + err.message);
    }
  }

  if (todas.length > 0 && String(process.env.ALESP_USE_LISTAGEM || '').toLowerCase() !== 'true') {
    return deduplicar(todas);
  }

  const tipos = [
    ['1', 'Projeto de Lei'],
    ['2', 'Projeto de Lei Complementar'],
    ['6', 'Mocao'],
    ['7', 'Requerimento'],
    ['8', 'Requerimento de Informacao'],
    ['4', 'Projeto de Decreto Legislativo'],
    ['3', 'Projeto de Resolucao'],
  ];

  for (const [tipoId, tipoNome] of tipos) {
    try {
      console.log('ALESP listagem ' + tipoNome + '...');
      const buffer = await fetchBuffer('https://www.al.sp.gov.br/alesp/projetos/?tipo=' + tipoId + '&ano=' + ANO, { timeoutMs: tipoId === '9' ? 90000 : 25000 });
      const parseadas = parsearAlespListagem(iconv.decode(buffer, 'latin1'), tipoNome);
      console.log('ALESP listagem ' + tipoNome + ': ' + parseadas.length);
      todas.push(...parseadas);
    } catch (err) {
      console.warn('ALESP listagem ' + tipoNome + ': ' + err.message);
    }
  }

  return deduplicar(todas);
}

async function buscarCmsp() {
  const url = 'https://splegisws.saopaulo.sp.leg.br/ws/ws2.asmx/ProjetosPorAnoJSON?Ano=' + ANO;
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('CMSP HTTP ' + response.status);
  const lista = await response.json();
  const tiposMonitorados = new Set(['PL', 'PDL', 'PR', 'PLO', 'MOC', 'IND', 'REQ', 'RPL', 'AUD', 'RDS', 'RPP', 'RPS', 'RDP', 'REQCOM', 'RSC']);
  return lista
    .filter(p => tiposMonitorados.has(p.tipo))
    .map(p => normalizarItem({
      source: 'CMSP',
      uf: 'SP',
      casa: 'CMSP',
      id: p.chave,
      tipo: p.tipo,
      numero: p.numero,
      ano: p.ano || ANO,
      data_apresentacao: p.data || null,
      ementa: p.ementa || '-',
      autor: p.autor || null,
      url: 'https://splegisconsulta.saopaulo.sp.leg.br/Pesquisa/DetalheProjeto?coddoc=' + p.chave,
      raw_text: JSON.stringify(p),
    }));
}

function parsearDomino(html, tipo, source) {
  const proposicoes = [];
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  while ((trMatch = trRegex.exec(html)) !== null) {
    const linha = trMatch[1];
    const codigoMatch = linha.match(/\b(\d{11})\b/);
    if (!codigoMatch) continue;
    const codigo = codigoMatch[1];
    const tds = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch;
    while ((tdMatch = tdRegex.exec(linha)) !== null) tds.push(limparHtml(tdMatch[1]));
    if (tds.length < 3) continue;

    let numero = String(parseInt(codigo.substring(6), 10));
    let ano = codigo.substring(0, 4);
    const numeroExibido = tds[0] && tds[0].match(/(\d+)\/(\d{4})/);
    if (numeroExibido) {
      numero = numeroExibido[1];
      ano = numeroExibido[2];
    }
    if (ano !== ANO) continue;

    let ementa = '-';
    let data = null;
    let autor = null;
    for (let i = 0; i < tds.length; i++) {
      if (tds[i].includes('=>') && tds[i].includes(codigo)) {
        ementa = (tds[i].split('=>')[0] || '-').trim();
        for (let j = i + 1; j < tds.length; j++) {
          const dataMatch = tds[j].match(/\d{2}\/\d{2}\/\d{4}/);
          if (dataMatch) {
            data = dataBrParaIso(dataMatch[0]);
            autor = tds[j + 1] ? tds[j + 1].substring(0, 200) : null;
            break;
          }
        }
        break;
      }
    }

    proposicoes.push(normalizarItem({
      source,
      uf: 'RJ',
      casa: source,
      id: source + '-' + codigo,
      codigo,
      tipo: tipo.sigla,
      numero,
      ano,
      autor,
      data_apresentacao: data,
      ementa,
      url: tipo.url,
      raw_text: tds.join(' '),
    }));
  }
  return proposicoes;
}

async function buscarAlerj() {
  const baseUrl = 'https://www3.alerj.rj.gov.br/lotus_notes/default.asp';
  const tipos = [
    { sigla: 'PEC', id: 158 }, { sigla: 'PLC', id: 160 }, { sigla: 'PL', id: 161 },
    { sigla: 'PDL', id: 162 }, { sigla: 'PR', id: 163 }, { sigla: 'IND-L', id: 164 },
    { sigla: 'IND', id: 165 }, { sigla: 'MOC', id: 167 }, { sigla: 'REQ', id: 170 },
    { sigla: 'REQ-I', id: 171 }, { sigla: 'REQ-SN', id: 172 },
  ];
  const todas = [];
  for (const tipo of tipos) {
    tipo.url = baseUrl + '?id=' + tipo.id;
    try {
      const html = await fetchText(tipo.url, { timeoutMs: 30000 });
      todas.push(...parsearDomino(html, tipo, 'ALERJ'));
    } catch (err) {
      console.warn('ALERJ ' + tipo.sigla + ': ' + err.message);
    }
    await new Promise(resolve => setTimeout(resolve, 800));
  }
  return deduplicar(todas);
}

async function buscarCmrj() {
  const baseUrl = 'https://aplicnt.camara.rj.gov.br/APL/Legislativos/scpro.nsf';
  const tipos = [
    { sigla: 'PL', form: 'Internet/LeiInt?OpenForm' },
    { sigla: 'PLC', form: 'Internet/LeiCompInt?OpenForm' },
    { sigla: 'PELO', form: 'Internet/EmendaInt?OpenForm' },
    { sigla: 'PDL', form: 'Internet/DecretoInt?OpenForm' },
    { sigla: 'PR', form: 'Internet/ResolucaoInt?OpenForm' },
    { sigla: 'IND', form: 'Internet/IndInt?OpenForm' },
    { sigla: 'MOC', form: 'Internet/mocaoInt?OpenForm' },
    { sigla: 'REQ-I', form: 'Internet/ReqInfInt?OpenForm' },
    { sigla: 'REQ', form: 'Internet/ReqInt?OpenForm' },
    { sigla: 'MSG', form: 'Internet/MensInt?OpenForm' },
  ];
  const todas = [];
  for (const tipo of tipos) {
    tipo.url = baseUrl + '/' + tipo.form;
    try {
      console.log('CMRJ ' + tipo.sigla + '...');
      const html = await fetchText(tipo.url, { timeoutMs: 30000 });
      const parseadas = parsearDomino(html, tipo, 'CMRJ');
      console.log('CMRJ ' + tipo.sigla + ': ' + parseadas.length);
      todas.push(...parseadas);
    } catch (err) {
      console.warn('CMRJ ' + tipo.sigla + ': ' + err.message);
    }
    await new Promise(resolve => setTimeout(resolve, 800));
  }
  return deduplicar(todas);
}

function deduplicar(items) {
  const mapa = new Map();
  for (const item of items) {
    if (!mapa.has(item.dedupe_key)) mapa.set(item.dedupe_key, item);
  }
  return Array.from(mapa.values());
}

async function buscarTodasFontes() {
  const fontes = [
    ['ALESP', buscarAlesp],
    ['CMSP', buscarCmsp],
    ['ALERJ', buscarAlerj],
    ['CMRJ', buscarCmrj],
  ];
  const todas = [];
  const status = [];

  for (const [nome, fn] of fontes) {
    try {
      console.log('Buscando ' + nome + '...');
      const itens = await fn();
      console.log(nome + ': ' + itens.length + ' item(ns)');
      todas.push(...itens);
      status.push({ fonte: nome, ok: true, total: itens.length });
      if (global.gc) global.gc();
    } catch (err) {
      console.error(nome + ': ' + err.message);
      status.push({ fonte: nome, ok: false, erro: err.message });
      if (global.gc) global.gc();
    }
  }

  return { itens: deduplicar(todas), status };
}

function agruparPorConfianca(matches) {
  return {
    alta: matches.filter(m => m.confidence === 'alta'),
    media: matches.filter(m => m.confidence === 'media'),
  };
}

function montarTabela(itens) {
  if (itens.length === 0) return '<p style="color:#777">Nenhum item.</p>';
  return '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
    '<thead><tr style="background:#1a3a5c;color:white">' +
    '<th style="padding:8px;text-align:left">Casa</th>' +
    '<th style="padding:8px;text-align:left">Proposicao</th>' +
    '<th style="padding:8px;text-align:left">Termos</th>' +
    '<th style="padding:8px;text-align:left">Ementa</th>' +
    '<th style="padding:8px;text-align:left">Link</th>' +
    '</tr></thead><tbody>' +
    itens.map(item => '<tr>' +
      '<td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap">' + escaparHtml(item.casa) + '</td>' +
      '<td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap"><strong>' + escaparHtml(item.tipo + ' ' + item.numero + '/' + item.ano) + '</strong></td>' +
      '<td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;color:#555">' + escaparHtml(item.matched_terms.join(', ')) + '</td>' +
      '<td style="padding:8px;border-bottom:1px solid #eee">' + escaparHtml(item.ementa) + '</td>' +
      '<td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap"><a href="' + escaparHtml(item.url) + '">ver</a></td>' +
    '</tr>').join('') +
    '</tbody></table>';
}

async function enviarEmail(matches, status) {
  if (!EMAIL_REMETENTE || !EMAIL_SENHA || !EMAIL_DESTINO) {
    throw new Error('Variaveis de email ausentes.');
  }
  const grupos = agruparPorConfianca(matches);
  const statusTexto = status.map(s => s.ok ? (s.fonte + ': ' + s.total) : (s.fonte + ': erro')).join(' | ');
  const html = '<div style="font-family:Arial,sans-serif;max-width:980px;margin:0 auto">' +
    '<h2 style="color:#1a3a5c;border-bottom:2px solid #1a3a5c;padding-bottom:8px">Eletromidia — proposicoes novas filtradas SP/RJ</h2>' +
    '<p style="color:#666;font-size:13px">Uso interno Monitor Legislativo — ' + new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) + '</p>' +
    '<p><strong>Resumo:</strong> alta confianca: ' + grupos.alta.length + ' | media/revisar: ' + grupos.media.length + '</p>' +
    '<p style="font-size:12px;color:#777">Fontes: ' + escaparHtml(statusTexto) + '</p>' +
    '<h3 style="color:#1a3a5c">Alta confianca</h3>' + montarTabela(grupos.alta) +
    '<h3 style="color:#856404;margin-top:24px">Media / revisar</h3>' + montarTabela(grupos.media) +
    '<p style="margin-top:20px;font-size:12px;color:#999">Este email e interno. Nao enviar automaticamente a cliente.</p>' +
  '</div>';

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_REMETENTE, pass: EMAIL_SENHA },
  });

  await transporter.sendMail({
    from: '"Monitor Eletromidia" <' + EMAIL_REMETENTE + '>',
    to: EMAIL_DESTINO,
    subject: '[Eletromidia] ' + matches.length + ' proposicao(oes) nova(s) filtrada(s) SP/RJ - ' + new Date().toLocaleDateString('pt-BR'),
    html,
  });
}

async function main() {
  console.log('Iniciando monitor Eletromidia Proposicoes SP/RJ');
  console.log('Ano: ' + ANO + ' | DRY_RUN=' + DRY_RUN);

  const estado = carregarEstado();
  const vistos = new Set(estado.proposicoes_vistas.map(String));
  const primeiroRun = vistos.size === 0;

  const { itens, status } = await buscarTodasFontes();
  console.log('Universo bruto coletado: ' + itens.length + ' item(ns)');
  if (itens.length === 0) {
    console.log('Nenhum item retornado pelas fontes.');
    if (!DRY_RUN && status.some(s => !s.ok)) process.exit(1);
    return;
  }

  const novos = itens.filter(item => !vistos.has(item.dedupe_key));
  const matches = novos.map(classificarMatch).filter(Boolean);
  console.log('Novos ainda nao vistos: ' + novos.length);
  console.log('Filtrados para envio Eletromidia: ' + matches.length);
  console.log('Filtrados alta/media: ' + agruparPorConfianca(matches).alta.length + '/' + agruparPorConfianca(matches).media.length);

  if (DRY_RUN) {
    matches.slice(0, 20).forEach(m => {
      console.log('MATCH ' + m.confidence.toUpperCase() + ' | ' + m.casa + ' | ' + m.tipo + ' ' + m.numero + '/' + m.ano + ' | ' + m.matched_terms.join(', ') + ' | ' + m.ementa.substring(0, 120));
    });
    return;
  }

  if (primeiroRun) {
    console.log('Primeiro run: marcando universo atual como visto sem enviar email.');
    itens.forEach(item => vistos.add(item.dedupe_key));
    estado.proposicoes_vistas = Array.from(vistos);
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);
    return;
  }

  if (matches.length > 0) {
    await enviarEmail(matches, status);
    estado.matches_enviados.push(...matches.map(m => ({
      dedupe_key: m.dedupe_key,
      source: m.source,
      tipo: m.tipo,
      numero: m.numero,
      ano: m.ano,
      confidence: m.confidence,
      matched_terms: m.matched_terms,
      sent_at: new Date().toISOString(),
    })));
    estado.matches_enviados = estado.matches_enviados.slice(-500);
    console.log('Email enviado: ' + matches.length + ' match(es).');
  } else {
    console.log('Sem novidades filtradas. Nada a enviar.');
  }

  novos.forEach(item => vistos.add(item.dedupe_key));
  estado.proposicoes_vistas = Array.from(vistos);
  estado.ultima_execucao = new Date().toISOString();
  salvarEstado(estado);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
