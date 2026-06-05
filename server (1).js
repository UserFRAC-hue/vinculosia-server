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

    // Esperar QR hasta 30 segundos
    var intentos = 0;
    var interval = setInterval(() => {
      intentos++;
      if (pendingQRs[id]) {
        clearInterval(interval);
        res.json({ ok: true, qr: pendingQRs[id] });
      } else if (activeSessions[id]) {
        clearInterval(interval);
        res.json({ ok: true, conectado: true, mensaje: 'Ya estaba conectado' });
      } else if (intentos > 30) {
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
async function iniciarSesionWhatsApp(clienteId, cliente) {
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
      var shouldReconnect = lastDisconnect && lastDisconnect.error &&
        lastDisconnect.error.output &&
        lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        console.log('Reconectando cliente ' + clienteId + '...');
        setTimeout(() => iniciarSesionWhatsApp(clienteId, cliente), 5000);
      } else {
        await supabase.from('clientes').update({ conectado: false }).eq('id', clienteId);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (var msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
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

      // Responder con IA si no está suspendido
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
      } catch(e) {
        console.error('Error IA cliente ' + clienteId + ':', e.message);
      }
    }
  });
}

async function generarRespuestaIA(mensaje, cliente) {
  var response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.GROQ_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: cliente.prompt_ia || 'Eres un asistente de atencion al cliente amable y profesional. Responde de forma breve y util. Empresa: ' + cliente.nombre },
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
