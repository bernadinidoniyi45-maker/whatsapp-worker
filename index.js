const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON, useMultiFileAuthState, isJidBroadcast } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
const pino = require('pino');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY; 
const PORT = process.env.PORT || 3000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = express();

app.use(cors());
app.use(express.json());

// --- FONCTION IA DYNAMIQUE ---
// Elle prend le "systemPrompt" (la personnalité) en paramètre !
async function askGroqAI(userMessage, systemPrompt) {
    if (!GROQ_API_KEY) return "⚠️ Erreur : Clé API Groq manquante.";

    // Si pas de prompt personnalisé, on met un défaut
    const finalPrompt = systemPrompt || "Tu es un assistant utile et sympathique.";

    try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${GROQ_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "llama3-70b-8192",
                messages: [
                    { role: "system", content: finalPrompt }, // 👈 C'EST ICI QUE ÇA CHANGE
                    { role: "user", content: userMessage }
                ],
                temperature: 0.7,
                max_tokens: 300
            })
        });

        const data = await response.json();
        return data.choices?.[0]?.message?.content || "Désolé, erreur IA.";

    } catch (error) {
        console.error("Erreur Groq:", error);
        return "Erreur technique IA.";
    }
}

// --- GESTION SESSION ---
const memoryCache = new Map();

const useSupabaseAuth = async (sessionId) => {
    const writeData = async (data, key) => {
        try {
            memoryCache.set(`${sessionId}-${key}`, data);
            await supabase.from('whatsapp_sessions').upsert({ 
                session_id: sessionId, 
                key_id: key, 
                data: JSON.parse(JSON.stringify(data, BufferJSON.replacer)) 
            });
        } catch (e) {}
    };

    const readData = async (key) => {
        try {
            if (memoryCache.has(`${sessionId}-${key}`)) return memoryCache.get(`${sessionId}-${key}`);
            const { data } = await supabase.from('whatsapp_sessions').select('data').eq('session_id', sessionId).eq('key_id', key).single();
            return data?.data ? JSON.parse(JSON.stringify(data.data), BufferJSON.reviver) : null;
        } catch (e) { return null; }
    };

    const removeData = async (key) => {
        try { 
            memoryCache.delete(`${sessionId}-${key}`);
            await supabase.from('whatsapp_sessions').delete().eq('session_id', sessionId).eq('key_id', key); 
        } catch (e) {}
    };

    const creds = await readData('creds') || initAuthCreds();

    return { state: { creds, keys: { /* ... (identique avant) ... */ get: async (type, ids) => { const data = {}; await Promise.all(ids.map(async (id) => { let value = await readData(`${type}-${id}`); if (type === 'app-state-sync-key' && value) { value = require('@whiskeysockets/baileys').proto.Message.AppStateSyncKeyData.fromObject(value); } data[id] = value; })); return data; }, set: async (data) => { const tasks = []; for (const category in data) { for (const id in data[category]) { const value = data[category][id]; const key = `${category}-${id}`; tasks.push(value ? writeData(value, key) : removeData(key)); } } await Promise.all(tasks); } } }, saveCreds: () => writeData(creds, 'creds') };
};

const startWhatsApp = async (instanceId, phoneNumber = null) => {
    console.log(`🚀 Démarrage Instance DYNAMIQUE : ${instanceId}`);
    try {
        const { state, saveCreds } = await useSupabaseAuth(instanceId);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: ["Mac OS", "Chrome", "10.15.7"], 
            syncFullHistory: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            emitOwnEvents: true,
            shouldIgnoreJid: jid => isJidBroadcast(jid) || jid.includes('status'),
            getMessage: async (key) => { return { conversation: 'Hello' }; },
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                if (!msg.key.fromMe) {
                    const sender = msg.key.remoteJid;
                    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

                    if (text) {
                        console.log(`📩 Message pour ${instanceId}: ${text}`);
                        await sock.sendPresenceUpdate('composing', sender);

                        // 1. RÉCUPÉRER LE CERVEAU DEPUIS SUPABASE 🧠
                        let systemPrompt = null;
                        try {
                            // On cherche le prompt associé à cette instance précise
                            const { data, error } = await supabase
                                .from('instances')
                                .select('system_prompt')
                                .eq('id', instanceId)
                                .single();
                            
                            if (data && data.system_prompt) {
                                systemPrompt = data.system_prompt;
                                console.log(`🧠 Cerveau chargé pour ${instanceId}`);
                            } else {
                                console.log(`⚠️ Pas de prompt trouvé, utilisation du défaut.`);
                            }
                        } catch (err) {
                            console.error("Erreur lecture prompt:", err);
                        }

                        // 2. ENVOYER À GROQ AVEC LE BON PROMPT
                        const aiResponse = await askGroqAI(text, systemPrompt);
                        await sock.sendMessage(sender, { text: aiResponse });
                    }
                }
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr && !phoneNumber) await supabase.from('instances').update({ qr_code: qr, status: 'scanning' }).eq('id', instanceId);
            if (connection === 'open') {
                console.log(`✅ ${instanceId} CONNECTÉ !`);
                await supabase.from('instances').update({ qr_code: null, status: 'connected' }).eq('id', instanceId);
            }
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) startWhatsApp(instanceId, phoneNumber);
                else await supabase.from('instances').update({ status: 'disconnected', qr_code: null }).eq('id', instanceId);
            }
        });

        sock.ev.on('creds.update', saveCreds);
    } catch (e) { console.error("🚨 Erreur fatale:", e); }
};

app.get('/', (req, res) => res.send('Multi-Agent System Ready 🟢'));

app.post('/init-session', async (req, res) => {
    const { instanceId, phoneNumber } = req.body;
    // On lance le worker pour cet ID spécifique
    startWhatsApp(instanceId, phoneNumber).catch(e => console.error(e));
    return res.json({ status: 'started' });
});

app.listen(PORT, () => console.log(`Serveur sur port ${PORT}`));
