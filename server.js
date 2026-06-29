const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

const app = express();
var PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Almacena sesiones activas en memoria
var activeSessions = {};
var pendingQRs = {};

// ── TEST ──────────────────────────────────────────────
app.get('/test', (req, res) => {
  res.json({
    status: 'ok',
    groq: process.env.GROQ_KEY ? 'conectado' : 'falta',
    supabase: process.env.SUPABASE_URL ? 'conectado' : 'falta',
    sesiones_activas: Object.keys(activeSessions).length
  });
});

// ── LIMPIAR SESIONES ──────────────────────────────────
app.delete('/sesiones/:id', (req, res) => {
  try {
    const { id } = req.params;
    if (activeSessions[id]) {
      try { activeSessions[id].end(); } catch(e) {}
      delete activeSessions[id];
    }
    delete pendingQRs[id];
    var authDir = path.join('./sesiones', id.toString());
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
    }
    res.json({ ok: true, mensaje: 'Sesion limpiada' });
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/sesiones', (req, res) => {
  try {
    Object.keys(activeSessions).forEach(id => {
      try { activeSessions[id].end(); } catch(e) {}
    });
    activeSessions = {};
    pendingQRs = {};
    if (fs.existsSync('./sesiones')) {
      fs.rmSync('./sesiones', { recursive: true, force: true });
    }
    res.json({ ok: true, mensaje: 'Todas las sesiones limpiadas' });
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── LOGIN CLIENTE ─────────────────────────────────────
app.post('/login-cliente', async (req, res) => {
  try {
    const { clave } = req.body;
    if (!clave) return res.status(400).json({ ok: false, error: 'Clave requerida' });
    const { data, error } = await supabase.from('clientes').select('*').eq('clave_acceso', clave.toUpperCase().trim()).single();
    if (error || !data) return res.status(401).json({ ok: false, error: 'Clave incorrecta' });
    res.json({ ok: true, cliente: { ...data, bot_activo: !!activeSessions[data.id] } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── CLIENTES ──────────────────────────────────────────
app.get('/clientes', async (req, res) => {
  try {
    const { data, error } = await supabase.from('clientes').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    const clientesConEstado = data.map(c => ({
      ...c,
      bot_activo: !!activeSessions[c.id]
    }));
    res.json({ ok: true, clientes: clientesConEstado });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/clientes', async (req, res) => {
  try {
    const { nombre, telefono, negocio, prompt_ia } = req.body;
    // Generar clave unica formato XXX-XXX-XXX
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var clave = '';
    for (var i = 0; i < 9; i++) {
      if (i === 3 || i === 6) clave += '-';
      clave += chars[Math.floor(Math.random() * chars.length)];
    }
    const { data, error } = await supabase.from('clientes').insert([{
      nombre, telefono, negocio,
      prompt_ia: prompt_ia || 'Eres un asistente de atencion al cliente amable y profesional. Responde de forma breve y util.',
      activo: true,
      suspendido: false,
      clave_acceso: clave
    }]).select().single();
    if (error) throw error;
    res.json({ ok: true, cliente: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/clientes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const { data, error } = await supabase.from('clientes').update(updates).eq('id', id).select().single();
    if (error) throw error;
    res.json({ ok: true, cliente: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── SUSPENDER / REACTIVAR ─────────────────────────────
app.post('/clientes/:id/suspender', async (req, res) => {
  try {
    const { id } = req.params;
    if (activeSessions[id]) {
      try { await activeSessions[id].logout(); } catch(e) {}
      delete activeSessions[id];
    }
    await supabase.from('clientes').update({ suspendido: true }).eq('id', id);
    res.json({ ok: true, mensaje: 'Bot suspendido' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/clientes/:id/reactivar', async (req, res) => {
  try {
    const { id } = req.params;
    await supabase.from('clientes').update({ suspendido: false }).eq('id', id);
    res.json({ ok: true, mensaje: 'Cliente reactivado. Conecta QR para iniciar bot.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── QR ────────────────────────────────────────────────
app.post('/conectar/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: cliente } = await supabase.from('clientes').select('*').eq('id', id).single();
    if (!cliente) return res.status(404).json({ ok: false, error: 'Cliente no encontrado' });
    if (cliente.suspendido) return res.status(403).json({ ok: false, error: 'Cliente suspendido' });
    if (activeSessions[id]) return res.json({ ok: true, mensaje: 'Ya conectado', conectado: true });

    pendingQRs[id] = null;
    iniciarSesionWhatsApp(id, cliente);

    // Esperar QR hasta 60 segundos
    var intentos = 0;
    var interval = setInterval(() => {
      intentos++;
      if (pendingQRs[id]) {
        clearInterval(interval);
        res.json({ ok: true, qr: pendingQRs[id] });
      } else if (activeSessions[id]) {
        clearInterval(interval);
        res.json({ ok: true, conectado: true, mensaje: 'Ya estaba conectado' });
      } else if (intentos > 60) {
        clearInterval(interval);
        res.status(408).json({ ok: false, error: 'Timeout esperando QR' });
      }
    }, 1000);

  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/estado/:id', (req, res) => {
  const { id } = req.params;
  res.json({ ok: true, conectado: !!activeSessions[id] });
});

// ── MENSAJES ──────────────────────────────────────────
app.get('/mensajes/:clienteId', async (req, res) => {
  try {
    const { clienteId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const { data, error } = await supabase
      .from('mensajes')
      .select('*')
      .eq('cliente_id', clienteId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    res.json({ ok: true, mensajes: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/stats/:clienteId', async (req, res) => {
  try {
    const { clienteId } = req.params;
    const hoy = new Date().toISOString().split('T')[0];

    const { count: total } = await supabase.from('mensajes').select('*', { count: 'exact', head: true }).eq('cliente_id', clienteId);
    const { count: hoyCount } = await supabase.from('mensajes').select('*', { count: 'exact', head: true }).eq('cliente_id', clienteId).gte('created_at', hoy);
    const { count: iaCount } = await supabase.from('mensajes').select('*', { count: 'exact', head: true }).eq('cliente_id', clienteId).eq('respondido_ia', true);

    res.json({ ok: true, stats: {
      total: total || 0,
      hoy: hoyCount || 0,
      respondidos_ia: iaCount || 0,
      porcentaje_ia: total > 0 ? Math.round((iaCount / total) * 100) : 0
    }});
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── WHATSAPP SESSION ──────────────────────────────────
async function iniciarSesionWhatsApp(clienteId, cliente, intentoReconexion) {
  intentoReconexion = intentoReconexion || 0;
  if (intentoReconexion > 3) {
    console.log('Cliente ' + clienteId + ' superó intentos de reconexión. Limpiando sesión.');
    var authDir2 = path.join('./sesiones', clienteId.toString());
    if (fs.existsSync(authDir2)) fs.rmSync(authDir2, { recursive: true, force: true });
    await supabase.from('clientes').update({ conectado: false }).eq('id', clienteId);
    return;
  }
  var authDir = path.join('./sesiones', clienteId.toString());
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        var qrBase64 = await QRCode.toDataURL(qr);
        pendingQRs[clienteId] = qrBase64;
      } catch(e) {}
    }

    if (connection === 'open') {
      activeSessions[clienteId] = sock;
      pendingQRs[clienteId] = null;
      await supabase.from('clientes').update({ conectado: true, ultima_conexion: new Date().toISOString() }).eq('id', clienteId);
      console.log('Cliente ' + clienteId + ' conectado');
    }

    if (connection === 'close') {
      delete activeSessions[clienteId];
      var statusCode = lastDisconnect && lastDisconnect.error &&
        lastDisconnect.error.output &&
        lastDisconnect.error.output.statusCode;
      var shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 401 && statusCode !== 403;

      if (shouldReconnect) {
        console.log('Reconectando cliente ' + clienteId + '...');
        setTimeout(() => iniciarSesionWhatsApp(clienteId, cliente, intentoReconexion + 1), 10000);
      } else {
        console.log('Cliente ' + clienteId + ' desconectado definitivamente');
        await supabase.from('clientes').update({ conectado: false }).eq('id', clienteId);
        // Limpiar sesion guardada para forzar nuevo QR
        var authDir = path.join('./sesiones', clienteId.toString());
        if (fs.existsSync(authDir)) {
          fs.rmSync(authDir, { recursive: true, force: true });
        }
      }
    }
  });

sock.ev.on('messages.upsert', async ({ messages }) => {
    for (var msg of messages) {
      // Detectar si el dueno escribio manualmente (fromMe = true)
      if (msg.key.fromMe && msg.message) {
        var textoHumano = msg.message.conversation || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) || '';
        if (textoHumano && textoHumano.trim().toLowerCase() === '/bot on') {
          await supabase.from('kv_conversaciones')
            .update({ modo: 'bot' })
            .eq('cliente_id', clienteId)
            .eq('telefono_usuario', msg.key.remoteJid);
          await sock.sendMessage(msg.key.remoteJid, { text: 'Bot reactivado.' });
        } else if (textoHumano) {
          await supabase.from('kv_conversaciones')
            .upsert([{
              cliente_id: clienteId,
              telefono_usuario: msg.key.remoteJid,
              modo: 'humano',
              ultimo_mensaje: textoHumano,
              fecha: new Date().toISOString()
            }], { onConflict: 'cliente_id,telefono_usuario' });
        }
        continue;
      }

      if (!msg.message) continue;
      var texto = msg.message.conversation || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) || '';
      if (!texto) continue;

      var remitente = msg.key.remoteJid;

      await supabase.from('mensajes').insert([{
        cliente_id: clienteId,
        remitente: remitente,
        mensaje: texto,
        direccion: 'entrada',
        respondido_ia: false
      }]);

      // Verificar si este chat esta en modo humano
      var { data: conv } = await supabase
        .from('kv_conversaciones')
        .select('modo')
        .eq('cliente_id', clienteId)
        .eq('telefono_usuario', remitente)
        .single();

      if (conv && conv.modo === 'humano') continue;

      var { data: clienteActual } = await supabase.from('clientes').select('*').eq('id', clienteId).single();
      if (!clienteActual || clienteActual.suspendido) continue;

      try {
        var respuestaIA = await generarRespuestaIA(texto, clienteActual);
        await sock.sendMessage(remitente, { text: respuestaIA });

        await supabase.from('mensajes').insert([{
          cliente_id: clienteId,
          remitente: 'bot',
          mensaje: respuestaIA,
          direccion: 'salida',
          respondido_ia: true
        }]);

        await supabase.from('kv_conversaciones')
          .upsert([{
            cliente_id: clienteId,
            telefono_usuario: remitente,
            modo: 'bot',
            ultimo_mensaje: texto,
            fecha: new Date().toISOString()
          }], { onConflict: 'cliente_id,telefono_usuario' });

      } catch(e) {
        console.error('Error IA cliente ' + clienteId + ':', e.message);
      }
    }
  });
}

async function obtenerConfigKV(clienteId) {
  try {
    // Buscar en kv_clientes por whatsapp coincidente con clientes.telefono
    var { data: kvCliente } = await supabase
      .from('kv_clientes')
      .select('*')
      .eq('whatsapp', clienteId)
      .eq('activo', true)
      .single();

    if (!kvCliente) return null;

    // Obtener configuracion del bot
    var { data: config } = await supabase
      .from('kv_configuracion_bot')
      .select('*')
      .eq('cliente_id', kvCliente.id)
      .single();

    // Obtener productos activos
    var { data: productos } = await supabase
      .from('kv_productos')
      .select('nombre, referencia, precio, tallas, colores, stock')
      .eq('cliente_id', kvCliente.id)
      .eq('activo', true);

    return { kvCliente, config, productos };
  } catch(e) {
    return null;
  }
}

function construirSystemPrompt(cliente, kvData) {
  // Si no tiene Kit de Ventas, usar prompt básico de Vínculos.IA
  if (!kvData || !kvData.config) {
    return cliente.prompt_ia || 'Eres un asistente de atencion al cliente amable y profesional. Responde de forma breve y util. Empresa: ' + cliente.nombre;
  }

  var config = kvData.config;
  var productos = kvData.productos || [];
  var kvCliente = kvData.kvCliente;

  // Construir lista de productos
  var listaProductos = '';
  if (productos.length > 0) {
    listaProductos = '\n\nPRODUCTOS DISPONIBLES:\n';
    productos.forEach(function(p) {
      listaProductos += '- ' + p.nombre;
      if (p.referencia) listaProductos += ' (Ref: ' + p.referencia + ')';
      listaProductos += ' | Precio: $' + Number(p.precio).toLocaleString('es-CO');
      if (p.tallas && p.tallas.length > 0) listaProductos += ' | Tallas: ' + p.tallas.join(', ');
      if (p.colores && p.colores.length > 0) listaProductos += ' | Colores: ' + p.colores.join(', ');
      if (p.stock !== null) listaProductos += ' | Stock: ' + (p.stock > 0 ? p.stock + ' unidades' : 'AGOTADO');
      listaProductos += '\n';
    });
  }

  var prompt = 'Eres ' + (config.nombre_bot || 'el asesor de ventas') + ' de ' + kvCliente.nombre_empresa + '.\n';
  prompt += 'Descripcion del negocio: ' + (config.descripcion_negocio || 'Negocio colombiano') + '\n';
  prompt += 'Tu tono debe ser: ' + (config.tono || 'amigable y profesional') + '\n';
  prompt += listaProductos;
  prompt += '\nINSTRUCCIONES CLAVE:\n';
  prompt += '- Tu objetivo principal es cerrar ventas o agendar citas\n';
  prompt += '- Siempre pregunta por talla, color o especificacion cuando aplique\n';
  prompt += '- Si el producto esta AGOTADO, ofrece alternativas disponibles\n';
  prompt += '- Responde en maximo 3 oraciones, de forma natural y humana\n';
  prompt += '- Nunca digas que eres una IA o un bot\n';
  if (config.instrucciones_cierre) prompt += '- ' + config.instrucciones_cierre + '\n';

  return prompt;
}

async function generarRespuestaIA(mensaje, cliente) {
  // Intentar obtener config del Kit de Ventas
  var kvData = await obtenerConfigKV(cliente.telefono);
  var systemPrompt = construirSystemPrompt(cliente, kvData);

  var response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.GROQ_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: mensaje }
      ],
      max_tokens: 300
    })
  });
  var data = await response.json();
  return data.choices[0].message.content;
}

// Reconectar sesiones al iniciar servidor
async function reconectarSesiones() {
  if (!fs.existsSync('./sesiones')) return;
  var { data: clientes } = await supabase.from('clientes').select('*').eq('activo', true).eq('suspendido', false);
  if (!clientes) return;
  for (var cliente of clientes) {
    var authDir = path.join('./sesiones', cliente.id.toString());
    if (fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0) {
      console.log('Reconectando sesion de ' + cliente.nombre + '...');
      iniciarSesionWhatsApp(cliente.id, cliente);
    }
  }
}

app.listen(PORT, async () => {
  console.log('Vinculos.IA server en puerto ' + PORT);
  await reconectarSesiones();
});
