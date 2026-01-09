const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON, useMultiFileAuthState, isJidBroadcast } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
const pino = require('pino');

// --- CONFIGURATION ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PORT = process.env.PORT || 3000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = express();

app.use(cors());
app.use(express.json());

// ============================================================
// 💾 FONCTION DE SAUVEGARDE (C'est la nouveauté !)
// ============================================================
async function saveMessageToDb(instanceId, text, sender, isFromMe) {
    try {
        await supabase.from('messages').insert({
            instance_id: instanceId,
            content: text,
            sender: sender.replace('@s.whatsapp.net', ''), // On nettoie le numéro
            is_from_me: isFromMe,
            created_at: new Date()
        });
        console.log(`💾 Message sauvegardé en base pour ${instanceId}`);
    } catch (e) {
        console.error("❌ Erreur sauvegarde DB:", e);
    }
}

// ============================================================
// 🧠 FONCTION IA GROQ
// ============================================================
async function askGroqAI(userMessage, systemPrompt) {
    if (!GROQ_API_KEY) return "⚠️ Erreur Config IA";
    const finalPrompt = systemPrompt || "Tu es un assistant utile.";
    try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "llama3-70b-8192",
                messages: [{ role: "system", content: finalPrompt }, { role: "user", content: userMessage }],
                temperature: 0.7, max_tokens: 400
            })
        });
        const data = await response.json();
        return data.choices?.[0]?.message?.content || null;
    } catch (error) { return null; }
}

// ============================================================
// 📡 FONCTION WEBHOOK
// ============================================================
async function sendToUserWebhook(webhookUrl, messageData) {
    try {
        const response = await fetch(webhookUrl, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(messageData)
        });
        const data = await response.json();
        return data.reply || null;
    } catch (error) { return null; }
}

// ============================================================
// GESTION SESSION (Idem avant)
// ============================================================
const memoryCache = new Map();
const useSupabaseAuth = async (sessionId) => {
    // ... (Garde le même code de gestion de session que je t'ai donné avant, c'est le même bloc)
    // Pour alléger la réponse, je remets l'essentiel :
    const writeData = async (data, key) => { try { memoryCache.set(`${sessionId}-${key}`, data); await supabase.from('whatsapp_sessions').upsert({ session_id: sessionId, key_id: key, data: JSON.parse(JSON.stringify(data, BufferJSON.replacer)) }); } catch (e) {} };
    const readData = async (key) => { try { if (memoryCache.has(`${sessionId}-${key}`)) return memoryCache.get(`${sessionId}-${key}`); const { data } = await supabase.from('whatsapp_sessions').select('data').eq('session_id', sessionId).eq('key_id', key).single(); return data?.data ? JSON.parse(JSON.stringify(data.data), BufferJSON.reviver) : null; } catch (e) { return null; } };
    const removeData = async (key) => { try { memoryCache.delete(`${sessionId}-${key}`); await supabase.from('whatsapp_sessions').delete().eq('session_id', sessionId).eq('key_id', key); } catch (e) {} };
    const creds = await readData('creds') || initAuthCreds();
    return { state: { creds, keys: { get: async (type, ids) => { const data = {}; await Promise.all(ids.map(async (id) => { let value = await readData(`${type}-${id}`); if (type === 'app-state-sync-key' && value) { value = require('@whiskeysockets/baileys').proto.Message.AppStateSyncKeyData.fromObject(value); } data[id] = value; })); return data; }, set: async (data) => { const tasks = []; for (const category in data) { for (const id in data[category]) { const value = data[category][id]; const key = `${category}-${id}`; tasks.push(value ? writeData(value, key) : removeData(key)); } } await Promise.all(tasks); } } }, saveCreds: () => writeData(creds, 'creds') };
};

// ============================================================
// 🤖 LE ROBOT AVEC SAUVEGARDE
// ============================================================
const startWhatsApp = async (instanceId, phoneNumber = null) => {
    console.log(`🚀 Démarrage Instance : ${instanceId}`);
    try {
        const { state, saveCreds } = await useSupabaseAuth(instanceId);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version, auth: state, logger: pino({ level: 'silent' }),
            browser: ["SaaS Agent", "Chrome", "10.0"], syncFullHistory: false,
            connectTimeoutMs: 60000, defaultQueryTimeoutMs: 60000, keepAliveIntervalMs: 10000,
            emitOwnEvents: true, shouldIgnoreJid: jid => isJidBroadcast(jid) || jid.includes('status'),
            getMessage: async (key) => { return { conversation: 'Hello' }; },
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                if (!msg.key.fromMe) {
                    const sender = msg.key.remoteJid;
                    const cleanSender = sender.replace('@s.whatsapp.net', '');
                    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

                    if (text) {
                        console.log(`📩 Reçu de ${cleanSender}: ${text}`);
                        
                        // 1. SAUVEGARDER LE MESSAGE REÇU (USER) 📥
                        await saveMessageToDb(instanceId, text, cleanSender, false);

                        // 2. RÉCUPÉRER LA CONFIG
                        let config = { system_prompt: null, webhook_url: null };
                        try {
                            const { data } = await supabase.from('instances').select('system_prompt, webhook_url').eq('id', instanceId).single();
                            if (data) config = data;
                        } catch (e) {}

                        // 3. GÉNÉRER LA RÉPONSE
                        let replyText = null;
                        if (config.webhook_url) {
                            replyText = await sendToUserWebhook(config.webhook_url, { event: "message", instance_id: instanceId, from: cleanSender, body: text });
                        } else {
                            replyText = await askGroqAI(text, config.system_prompt);
                        }

                        // 4. ENVOYER ET SAUVEGARDER LA RÉPONSE (BOT) 📤
                        if (replyText) {
                            await sock.sendMessage(sender, { text: replyText });
                            await saveMessageToDb(instanceId, replyText, cleanSender, true); // TRUE = C'est le robot
                            console.log(`📤 Réponse envoyée et sauvegardée.`);
                        }
                    }
                }
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr && !phoneNumber) await supabase.from('instances').update({ qr_code: qr, status: 'scanning' }).eq('id', instanceId);
            if (connection === 'open') { await supabase.from('instances').update({ qr_code: null, status: 'connected' }).eq('id', instanceId); }
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) startWhatsApp(instanceId, phoneNumber);
                else await supabase.from('instances').update({ status: 'disconnected', qr_code: null }).eq('id', instanceId);
            }
        });
        sock.ev.on('creds.update', saveCreds);
    } catch (e) { console.error("🚨 Erreur:", e); }
};

app.get('/', (req, res) => res.send('Worker Ready 🟢'));
app.post('/init-session', async (req, res) => {
    const { instanceId, phoneNumber } = req.body;
    startWhatsApp(instanceId, phoneNumber).catch(e => console.error(e));
    return res.json({ status: 'started' });
});
app.listen(PORT, () => console.log(`Serveur sur port ${PORT}`));
