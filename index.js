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
// 🧠 FONCTION IA GROQ (AVEC MÉMOIRE)
// ============================================================
async function askGroqAI(currentMessage, systemPrompt, history = []) {
    if (!GROQ_API_KEY) return "⚠️ Erreur Config IA";

    const finalPrompt = systemPrompt || "Tu es un assistant utile sur WhatsApp.";

    // On prépare la conversation : Prompt Système + Historique + Nouveau message
    const messagesToSend = [
        { role: "system", content: finalPrompt },
        ...history, // On insère le passé ici
        { role: "user", content: currentMessage }
    ];

    try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${GROQ_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "llama3-70b-8192",
                messages: messagesToSend,
                temperature: 0.7,
                max_tokens: 400
            })
        });

        const data = await response.json();
        return data.choices?.[0]?.message?.content || null;

    } catch (error) {
        console.error("❌ Erreur Groq:", error);
        return null;
    }
}

// ============================================================
// 💾 FONCTION DE SAUVEGARDE
// ============================================================
async function saveMessageToDb(instanceId, text, sender, isFromMe) {
    try {
        await supabase.from('messages').insert({
            instance_id: instanceId,
            content: text,
            sender: sender.replace('@s.whatsapp.net', ''),
            is_from_me: isFromMe,
            created_at: new Date()
        });
    } catch (e) { console.error("❌ Erreur DB:", e); }
}

// ============================================================
// 🕰️ FONCTION POUR RÉCUPÉRER L'HISTORIQUE
// ============================================================
async function getConversationHistory(instanceId, sender) {
    try {
        // On récupère les 10 derniers messages de CE client avec CET agent
        const { data } = await supabase
            .from('messages')
            .select('content, is_from_me')
            .eq('instance_id', instanceId)
            .eq('sender', sender.replace('@s.whatsapp.net', '')) // Filtre par client
            .order('created_at', { ascending: false }) // Du plus récent au plus vieux
            .limit(10); // On garde juste les 10 derniers pour pas surcharger l'IA

        if (!data) return [];

        // On remet dans le bon ordre (Chronologique) et au format OpenAI
        return data.reverse().map(msg => ({
            role: msg.is_from_me ? "assistant" : "user",
            content: msg.content
        }));

    } catch (e) {
        console.error("Erreur historique:", e);
        return [];
    }
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
// GESTION SESSION (Code standard)
// ============================================================
const memoryCache = new Map();
const useSupabaseAuth = async (sessionId) => {
    const writeData = async (data, key) => { try { memoryCache.set(`${sessionId}-${key}`, data); await supabase.from('whatsapp_sessions').upsert({ session_id: sessionId, key_id: key, data: JSON.parse(JSON.stringify(data, BufferJSON.replacer)) }); } catch (e) {} };
    const readData = async (key) => { try { if (memoryCache.has(`${sessionId}-${key}`)) return memoryCache.get(`${sessionId}-${key}`); const { data } = await supabase.from('whatsapp_sessions').select('data').eq('session_id', sessionId).eq('key_id', key).single(); return data?.data ? JSON.parse(JSON.stringify(data.data), BufferJSON.reviver) : null; } catch (e) { return null; } };
    const removeData = async (key) => { try { memoryCache.delete(`${sessionId}-${key}`); await supabase.from('whatsapp_sessions').delete().eq('session_id', sessionId).eq('key_id', key); } catch (e) {} };
    const creds = await readData('creds') || initAuthCreds();
    return { state: { creds, keys: { get: async (type, ids) => { const data = {}; await Promise.all(ids.map(async (id) => { let value = await readData(`${type}-${id}`); if (type === 'app-state-sync-key' && value) { value = require('@whiskeysockets/baileys').proto.Message.AppStateSyncKeyData.fromObject(value); } data[id] = value; })); return data; }, set: async (data) => { const tasks = []; for (const category in data) { for (const id in data[category]) { const value = data[category][id]; const key = `${category}-${id}`; tasks.push(value ? writeData(value, key) : removeData(key)); } } await Promise.all(tasks); } } }, saveCreds: () => writeData(creds, 'creds') };
};

// ============================================================
// 🤖 LE ROBOT INTELLIGENT
// ============================================================
const startWhatsApp = async (instanceId, phoneNumber = null) => {
    console.log(`🚀 Démarrage Instance SaaS : ${instanceId}`);
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
                        console.log(`📩 Reçu de ${cleanSender} pour ${instanceId}: ${text}`);
                        
                        // 1. SAUVEGARDER LE MESSAGE USER 📥
                        await saveMessageToDb(instanceId, text, cleanSender, false);

                        // 2. RECUPÉRER CONFIG + HISTORIQUE
                        let config = { system_prompt: null, webhook_url: null };
                        let history = [];
                        
                        try {
                            // Config de l'agent
                            const { data } = await supabase.from('instances').select('system_prompt, webhook_url').eq('id', instanceId).single();
                            if (data) config = data;

                            // Historique de conversation (Si pas de webhook)
                            if (!config.webhook_url) {
                                history = await getConversationHistory(instanceId, sender);
                            }

                        } catch (e) { console.error("Erreur lecture données", e); }

                        // 3. GÉNÉRER LA RÉPONSE
                        let replyText = null;
                        
                        await sock.sendPresenceUpdate('composing', sender);

                        if (config.webhook_url) {
                            // Mode Webhook (Pas besoin d'historique ici, le site gère)
                            replyText = await sendToUserWebhook(config.webhook_url, { event: "message", instance_id: instanceId, from: cleanSender, body: text });
                        } else {
                            // Mode IA (Avec Mémoire !)
                            replyText = await askGroqAI(text, config.system_prompt, history);
                        }

                        // 4. ENVOYER ET SAUVEGARDER RÉPONSE 📤
                        if (replyText) {
                            await sock.sendMessage(sender, { text: replyText });
                            await saveMessageToDb(instanceId, replyText, cleanSender, true);
                            console.log(`📤 Réponse envoyée.`);
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
